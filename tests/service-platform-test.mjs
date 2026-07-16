import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runServiceCommand } from "../src/local/service.mjs";
import { waitForInactiveStatus } from "../src/local/service-convergence.mjs";
import {
  installWindowsTask,
  startWindowsTask,
  statusWindowsTask,
  stopWindowsTask,
  uninstallWindowsTask,
  windowsBatchArgument,
  windowsCommandLineArgument,
  windowsLauncherContent,
  writeWindowsLauncher,
  windowsTaskAction,
} from "../src/local/windows-service.mjs";

assert.equal(windowsCommandLineArgument("plain"), '"plain"');
assert.equal(windowsCommandLineArgument("C:\\"), '"C:\\\\"');
assert.equal(windowsCommandLineArgument('a\\"b'), '"a\\\\\\"b"');
assert.equal(windowsCommandLineArgument(""), '""');
assert.throws(() => windowsCommandLineArgument("bad\0value"), /NUL byte/);
assert.throws(() => windowsCommandLineArgument("bad\nvalue"), /line break/);
assert.equal(windowsBatchArgument("C:\\100%\\node.exe"), '"C:\\100%%\\node.exe"');

const representativeSpec = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  daemonArgs: [
    "C:\\Users\\Example User\\AppData\\Roaming\\npm\\node_modules\\machine-bridge-mcp\\bin\\machine-mcp.mjs",
    "start",
    "--daemon-only",
    "--workspace", "D:\\A representative workspace with a long directory name\\project",
    "--state-dir", "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp",
    "--log-level", "warn",
    "--log-format", "json",
  ],
  stateRoot: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp",
  stdout: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\logs\\daemon.out.log",
  stderr: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\logs\\daemon.err.log",
};
const oldInlineAction = [representativeSpec.node, ...representativeSpec.daemonArgs].map(windowsCommandLineArgument).join(" ");
assert(oldInlineAction.length > 262, "regression fixture no longer reproduces the Task Scheduler /TR length overflow");
const shortAction = windowsTaskAction("C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\service-launcher.cmd");
assert(shortAction.length <= 262, "launcher-based Task Scheduler action still exceeds the platform limit");
assert.throws(() => windowsTaskAction("C:\\Users\\100%\\service-launcher.cmd"), /percent sign/);
const launcherContent = windowsLauncherContent(representativeSpec);
assert(launcherContent.includes(":restart"), "Windows launcher lost restart-on-failure behavior");
assert(launcherContent.includes("--daemon-only"), "Windows launcher lost daemon-only startup arguments");
assert(launcherContent.includes("1>>") && launcherContent.includes("2>>"), "Windows launcher lost bounded service log routing");
assert(launcherContent.includes('if "%mbm_exit%"=="0" exit /b 0'), "Windows launcher restarts successful exits");

const serviceInvocation = await runServiceCommand("synthetic-service", ["status"], async (command, args, options) => ({ command, args, options }));
assert.equal(serviceInvocation.command, "synthetic-service");
assert.equal(serviceInvocation.args[0], "status");
assert.equal(serviceInvocation.options.capture, true);
assert.equal(serviceInvocation.options.allowFailure, true);
assert.equal(serviceInvocation.options.maxOutputBytes, 64 * 1024);

if (process.platform === "win32") windowsLauncherLiveTest();
await windowsInstallTest();
await windowsStatusTest();
await windowsStartTest();
await windowsCompletedStartTest();
await windowsUnknownStatusTest();
await windowsStopTest();
await windowsUninstallTest();
await delayedLaunchdStopTest();
await stuckLaunchdStopTest();
console.log("service platform lifecycle test ok");

function windowsLauncherLiveTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm windows & launcher "));
  try {
    const fixture = path.join(root, "fixture.mjs");
    const marker = path.join(root, "marker-100%.txt");
    writeFileSync(fixture, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "ok");\n');
    const launcher = writeWindowsLauncher({
      node: process.execPath,
      daemonArgs: [fixture, marker],
      stateRoot: root,
      stdout: path.join(root, "daemon.out.log"),
      stderr: path.join(root, "daemon.err.log"),
    });
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `call "${launcher.path}"`], { windowsHide: true });
    assert.equal(existsSync(marker), true, "real cmd.exe did not execute the generated launcher with quoted special-character paths");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function windowsInstallTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-windows-service-"));
  try {
    const calls = [];
    const spec = {
      ...representativeSpec,
      stateRoot: root,
      stdout: path.join(root, "daemon.out.log"),
      stderr: path.join(root, "daemon.err.log"),
    };
    const result = await installWindowsTask(spec, quietLogger(), {
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "schtasks") return { code: 0, stdout: "created", stderr: "" };
        return scheduledTaskResult("Ready");
      },
    });
    assert.equal(result.ok, true);
    const create = calls.find(call => call.command === "schtasks");
    assert(create, "Windows task creation was not attempted");
    assert(create.args.includes("/RL") && create.args.includes("LIMITED"), "Windows task was not constrained to least privilege");
    const action = create.args[create.args.indexOf("/TR") + 1];
    assert(action.length <= 262, "installed Windows task action exceeded the platform limit");
    const launcher = readFileSync(result.launcher, "utf8");
    assert(launcher.includes("--daemon-only"), "installed launcher omitted daemon startup arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function windowsStatusTest() {
  const ready = await statusWindowsTask({ run: async () => scheduledTaskResult("Ready") });
  assert.deepEqual({ installed: ready.installed, active: ready.active, state: ready.state }, { installed: true, active: false, state: "ready" });
  const running = await statusWindowsTask({ run: async () => scheduledTaskResult("Running") });
  assert.equal(running.active, true);
  const missing = await statusWindowsTask({ run: async () => ({ code: 3, stdout: "", stderr: "localized missing task message" }) });
  assert.equal(missing.installed, false, "missing task depended on localized output parsing");
}

async function windowsStartTest() {
  let queries = 0;
  const result = await startWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 1, stdout: "", stderr: "localized output" };
      queries += 1;
      return scheduledTaskResult(queries >= 2 ? "Running" : "Ready", queries >= 2 ? "2026-07-16T00:00:01.0000000Z" : "2026-07-16T00:00:00.0000000Z");
    },
  });
  assert.equal(result.ok, true, "Windows start trusted localized schtasks output over observed task state");
  assert.equal(result.status.active, true);
}

async function windowsCompletedStartTest() {
  let queries = 0;
  const result = await startWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 0, stdout: "", stderr: "" };
      queries += 1;
      return scheduledTaskResult(
        "Ready",
        queries >= 2 ? "2026-07-16T00:00:01.0000000Z" : "2026-07-16T00:00:00.0000000Z",
        0,
      );
    },
  });
  assert.equal(result.ok, true, "a task that completed successfully before polling was reported as a failed start");
  assert.equal(result.reason, "completed");
}

async function windowsUnknownStatusTest() {
  const unavailable = async () => ({ code: 1, stdout: "", stderr: "query failed" });
  const started = await startWindowsTask(quietLogger(), { run: unavailable });
  assert.equal(started.ok, false);
  assert.equal(started.reason, "task_status_unavailable");
  const stopped = await stopWindowsTask(quietLogger(), { run: unavailable });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "task_status_unavailable");
}

async function windowsStopTest() {
  let queries = 0;
  const result = await stopWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 1, stdout: "", stderr: "non-English output" };
      queries += 1;
      return scheduledTaskResult(queries >= 2 ? "Ready" : "Running");
    },
  });
  assert.equal(result.ok, true, "Windows stop trusted a localized schtasks exit message over observed task state");
  assert.equal(result.active, false);
}

async function windowsUninstallTest() {
  let deleted = false;
  const result = await uninstallWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command, args) => {
      if (command === "schtasks" && args[0] === "/Delete") {
        deleted = true;
        return { code: 1, stdout: "", stderr: "localized output" };
      }
      if (command === "powershell.exe") {
        return deleted
          ? { code: 3, stdout: "", stderr: "" }
          : scheduledTaskResult("Ready");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, true, "Windows removal depended on localized schtasks output");
  assert.equal(result.status.installed, false);
}

async function delayedLaunchdStopTest() {
  const statuses = [{ active: true }, { active: true }, { active: false }];
  const sleeps = [];
  const result = await waitForInactiveStatus(
    async () => statuses.shift(),
    { attempts: 5, delayMs: 25, sleep: async milliseconds => sleeps.push(milliseconds) },
  );
  assert.equal(result.active, false);
  assert.equal(sleeps.join(","), "25,25");
}

async function stuckLaunchdStopTest() {
  let reads = 0;
  const result = await waitForInactiveStatus(
    async () => { reads += 1; return { active: true }; },
    { attempts: 3, delayMs: 1, sleep: async () => {} },
  );
  assert.equal(result.active, true);
  assert.equal(reads, 3);
}

function scheduledTaskResult(state, lastRunTime = "2026-07-16T00:00:00.0000000Z", lastResult = 0) {
  return {
    code: 0,
    stdout: JSON.stringify({ state, last_result: lastResult, last_run_time: lastRunTime }),
    stderr: "",
  };
}

function quietLogger() {
  return { info() {}, warn() {} };
}
