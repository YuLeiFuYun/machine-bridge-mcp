import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { launchdStatusSummary, systemdStatusSummary } from "../src/local/service-status.mjs";
import { runServiceRestartHandoff, serviceRestartHandoffMain } from "../src/local/service-restart-handoff.mjs";
import { waitForActiveStatus, waitForInactiveStatus, waitForStatus } from "../src/local/service-convergence.mjs";
import { scheduleServiceRestart, serviceControlEnvironment } from "../src/local/service-restart-scheduler.mjs";
import { restartWindowsTask, startWindowsTask } from "../src/local/windows-service.mjs";
import { stopOwnedPlatformService } from "../src/local/service-ownership.mjs";

await testDetachedScheduler();
await testHandoffExecution();
await testWindowsIdempotentStartAndRestart();
await testServiceOwnershipBoundary();
await testServiceConvergenceBranches();
await testHandoffMainAndDefaults();
testServiceStatusSanitization();
console.log("service restart handoff and status boundary test ok");

async function testDetachedScheduler() {
  const calls = [];
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => { unrefCount += 1; };
  const scheduled = scheduleServiceRestart({
    node: "/synthetic/node",
    helper: "/synthetic/service-restart-handoff.mjs",
    delayMs: 425,
    env: {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      HTTPS_PROXY: "http://secret.example.test",
      API_TOKEN: "must-not-pass",
    },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const result = await scheduled;
  assert.deepEqual(result, { ok: true, scheduled: true, delay_ms: 425 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/synthetic/node");
  assert.deepEqual(calls[0].args, ["/synthetic/service-restart-handoff.mjs", "425"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PATH, "/safe/bin");
  assert.equal(calls[0].options.env.HOME, "/safe/home");
  assert.equal(calls[0].options.env.HTTPS_PROXY, undefined);
  assert.equal(calls[0].options.env.API_TOKEN, undefined);
  assert.equal(unrefCount, 1, "restart helper was not detached from the caller lifecycle");

  assert.throws(() => scheduleServiceRestart({ platform: "win32" }), /not behavior-verified/);

  const failedChild = new EventEmitter();
  const failure = scheduleServiceRestart({ spawnProcess() { queueMicrotask(() => failedChild.emit("error", new Error("spawn failed"))); return failedChild; } });
  await assert.rejects(failure, /spawn failed/);

  assert.deepEqual(serviceControlEnvironment({ PATH: "/bin", LANG: "C", TOKEN: "secret" }), { PATH: "/bin", LANG: "C" });
}

async function testHandoffExecution() {
  const events = [];
  const result = await runServiceRestartHandoff({
    delayMs: 125,
    sleep: async (milliseconds) => { events.push(["sleep", milliseconds]); },
    logger: {},
    restartAutostart: async ({ logger }) => { events.push(["restart", logger]); return { ok: true, provider: "test", restarted: true }; },
  });
  assert.equal(result.restarted, true);
  assert.deepEqual(events.map((entry) => entry[0]), ["sleep", "restart"]);
  assert.equal(events[0][1], 125);
  await assert.rejects(() => runServiceRestartHandoff({
    delayMs: 1,
    sleep: async () => {},
    logger: {},
    restartAutostart: async () => ({ ok: false, provider: "test", reason: "synthetic" }),
  }), /service restart handoff failed \(synthetic\)/);
  await assert.rejects(
    () => runServiceRestartHandoff({ delayMs: 1, sleep: async () => {}, logger: {}, restartAutostart: async () => ({ ok: false, provider: "test" }) }),
    /service restart handoff failed \(test\)/,
  );
  await assert.rejects(
    () => runServiceRestartHandoff({ delayMs: 1, sleep: async () => {}, logger: {}, restartAutostart: async () => null }),
    /service restart handoff failed \(unknown\)/,
  );
}

async function testWindowsIdempotentStartAndRestart() {
  const idempotentCalls = [];
  const alreadyRunning = await startWindowsTask({}, {
    run: async (command) => {
      idempotentCalls.push(command);
      return scheduledTaskResult("Running");
    },
  });
  assert.equal(alreadyRunning.ok, true);
  assert.equal(alreadyRunning.already_running, true);
  assert.deepEqual(idempotentCalls, ["powershell.exe"], "already-running start still issued schtasks /Run");

  let running = true;
  const commands = [];
  const restarted = await restartWindowsTask({}, {
    sleep: async () => {},
    run: async (command, args) => {
      commands.push([command, args]);
      if (command === "schtasks" && args[0] === "/End") { running = false; return { code: 0, stdout: "", stderr: "" }; }
      if (command === "schtasks" && args[0] === "/Run") { running = true; return { code: 0, stdout: "", stderr: "" }; }
      return scheduledTaskResult(running ? "Running" : "Ready", running ? "2026-07-22T00:00:01.0000000Z" : "2026-07-22T00:00:00.0000000Z");
    },
  });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.restarted, true);
  assert(commands.some(([, args]) => args?.[0] === "/End"));
  assert(commands.some(([, args]) => args?.[0] === "/Run"));
}

function testServiceStatusSanitization() {
  const raw = [
    "gui/501/dev.machine-bridge-mcp.daemon = {",
    "  state = running",
    "  pid = 59222",
    "  runs = 3",
    "  last terminating signal = Terminated: 15",
    `  PATH => ${["", "Users", "private-user", "secret", "bin"].join("/")}:/usr/bin`,
    "  SSH_AUTH_SOCK => /var/run/private-agent",
    "}",
  ].join("\n");
  const launchd = launchdStatusSummary({ installed: true, definition: "dev.machine-bridge-mcp.daemon", result: { code: 0, stdout: raw } });
  assert.equal(launchd.active, true);
  assert.equal(launchd.loaded, true);
  assert.equal(launchd.pid, 59222);
  assert.equal(launchd.runs, 3);
  assert.equal(launchd.last_termination_signal, "Terminated: 15");
  const serialized = JSON.stringify(launchd);
  assert(!serialized.includes("private-user"));
  assert(!serialized.includes("SSH_AUTH_SOCK"));
  assert(!serialized.includes("private-agent"));
  assert(!Object.hasOwn(launchd, "detail") && !Object.hasOwn(launchd, "path"));

  const loadedIdle = launchdStatusSummary({ installed: true, definition: "dev.machine-bridge-mcp.daemon", result: { code: 0, stdout: "state = waiting\nruns = 1\n" } });
  assert.equal(loadedIdle.loaded, true);
  assert.equal(loadedIdle.active, false);
  assert.equal(loadedIdle.pid, null);

  const unloaded = launchdStatusSummary({ installed: false, result: { code: 1, stdout: "", stderr: "private failure" } });
  assert.equal(unloaded.loaded, false);
  assert.equal(unloaded.active, false);
  assert.equal(unloaded.state, "inactive");
  assert.equal(unloaded.definition, "");
  const runningWithoutPid = launchdStatusSummary({ installed: true, definition: "test", result: { code: 0, stdout: "state = running\n" } });
  assert.equal(runningWithoutPid.active, true);
  const loadedWithoutState = launchdStatusSummary({ installed: true, definition: "test", result: { code: 0, stdout: "" } });
  assert.equal(loadedWithoutState.state, "loaded");
  assert.equal(loadedWithoutState.active, false);

  const systemd = systemdStatusSummary({ installed: true, definition: "machine-bridge-mcp.service", result: { code: 0, stdout: "active\nSECRET=value\n" } });
  assert.equal(systemd.active, true, "systemd parser ignored the authoritative first status line");
  assert(!JSON.stringify(systemd).includes("SECRET"));
  const active = systemdStatusSummary({ installed: true, definition: "machine-bridge-mcp.service", result: { code: 0, stdout: "active\n" } });
  assert.equal(active.active, true);
  const unknown = systemdStatusSummary({ installed: false, result: { code: 1, stdout: "unexpected-private-text\n" } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.active, false);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.definition, "");
}

function scheduledTaskResult(state, lastRunTime = "2026-07-22T00:00:00.0000000Z", lastResult = 0) {
  return {
    code: 0,
    stdout: JSON.stringify({ state, last_result: lastResult, last_run_time: lastRunTime }),
    stderr: "",
  };
}

async function testServiceOwnershipBoundary() {
  let stops = 0;
  const unrelated = await stopOwnedPlatformService({
    state: { workspace: { path: "/other" } },
    inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: false, mode: "service", identity_reason: "workspace_mismatch" }),
    ownsPlatformAutostart: (daemon) => daemon.alive === true && daemon.verified_service_daemon === true && daemon.mode === "service",
    stopPlatformService: async () => { stops += 1; return { ok: true }; },
  });
  assert.equal(unrelated.owned, false);
  assert.equal(unrelated.stopped, false);
  assert.equal(stops, 0, "unrelated state reached the machine service manager");

  const owned = await stopOwnedPlatformService({
    state: { workspace: { path: "/owner" } },
    inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service", pid: 42 }),
    ownsPlatformAutostart: (daemon) => daemon.alive === true && daemon.verified_service_daemon === true && daemon.mode === "service",
    stopPlatformService: async () => { stops += 1; return { ok: true, active: false }; },
  });
  assert.equal(owned.owned, true);
  assert.equal(owned.stopped, true);
  assert.equal(stops, 1, "verified service owner did not reach the machine service manager exactly once");

  const providerFailure = await stopOwnedPlatformService({
    state: {},
    inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service" }),
    ownsPlatformAutostart: () => true,
    stopPlatformService: async () => ({ ok: false }),
  });
  assert.equal(providerFailure.stopped, false);
  await assert.rejects(() => stopOwnedPlatformService(), /requires state/);
  await assert.rejects(() => stopOwnedPlatformService({ state: {} }), /inspectWorkspaceDaemon/);
  await assert.rejects(() => stopOwnedPlatformService({ state: {}, inspectWorkspaceDaemon() {} }), /ownsPlatformAutostart/);
  await assert.rejects(() => stopOwnedPlatformService({ state: {}, inspectWorkspaceDaemon() {}, ownsPlatformAutostart() {} }), /stopPlatformService/);
}


async function testServiceConvergenceBranches() {
  let activeReads = 0;
  const active = await waitForActiveStatus(
    async () => ({ active: ++activeReads >= 2 }),
    { attempts: 3, delayMs: 1 },
  );
  assert.equal(active.active, true);
  assert.equal(activeReads, 2);

  let inactiveReads = 0;
  const inactive = await waitForInactiveStatus(
    async () => ({ active: ++inactiveReads < 2 }),
    { attempts: 3, delayMs: 1 },
  );
  assert.equal(inactive.active, false);

  const custom = await waitForStatus(
    async () => ({ state: "ready" }),
    (status) => status.state === "ready",
    { attempts: 0, sleep: async () => {} },
  );
  assert.equal(custom.state, "ready");
  await assert.rejects(() => waitForStatus(null, () => true), /readStatus must be a function/);
  await assert.rejects(() => waitForStatus(async () => ({}), null), /predicate must be a function/);
}

async function testHandoffMainAndDefaults() {
  const delays = [];
  await runServiceRestartHandoff({
    delayMs: "not-a-number",
    sleep: async (value) => delays.push(value),
    restartAutostart: async () => ({ ok: true }),
  });
  await runServiceRestartHandoff({
    delayMs: 99_999,
    sleep: async (value) => delays.push(value),
    logger: {},
    restartAutostart: async () => ({ ok: true }),
  });
  await runServiceRestartHandoff({
    delayMs: 1,
    sleep: async (value) => delays.push(value),
    logger: {},
    restartAutostart: async () => ({ ok: true }),
  });
  assert.deepEqual(delays, [300, 5_000, 50]);

  const realDelay = await runServiceRestartHandoff({
    delayMs: 50,
    logger: {},
    restartAutostart: async () => ({ ok: true, provider: "test" }),
  });
  assert.equal(realDelay.provider, "test");

  const logs = [];
  assert.equal(await serviceRestartHandoffMain({ run: async () => {}, logger: { error() { logs.push("unexpected"); } } }), 0);
  assert.equal(await serviceRestartHandoffMain({
    handoffOptions: { delayMs: 50, sleep: async () => {}, logger: {}, restartAutostart: async () => ({ ok: true }) },
  }), 0);
  assert.equal(await serviceRestartHandoffMain({
    run: async () => { const error = new Error("synthetic"); error.code = "synthetic_code"; throw error; },
    logger: { error(message, fields) { logs.push({ message, fields }); } },
  }), 1);
  assert.equal(logs[0].fields.error_class, "synthetic_code");
}
