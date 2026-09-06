import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readLoopbackJson } from "../src/local/loopback-health.mjs";
import { workspaceDaemonOwnsPlatformAutostart } from "../src/local/daemon-process.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "bin", "machine-mcp.mjs");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

await testDirectLoopbackHealth();

assert(
  workspaceDaemonOwnsPlatformAutostart({ alive: true, verified_service_daemon: true, mode: "service" }),
  "verified workspace service daemon was not eligible for platform takeover",
);
for (const status of [
  { alive: false, verified_service_daemon: true, mode: "service" },
  { alive: true, verified_service_daemon: false, mode: "service" },
  { alive: true, verified_service_daemon: true, mode: "foreground" },
  { alive: true, verified_service_daemon: true, mode: "invalid" },
]) {
  assert(!workspaceDaemonOwnsPlatformAutostart(status), "unrelated daemon state could stop machine-level autostart");
}

const version = run(["version"]);
assert(version.status === 0, `version command failed: ${version.stderr}`);
assert(version.stdout.trim() === `${pkg.name} ${pkg.version}`, "version command returned stale package metadata");

const versionFlag = run(["--version"]);
assert(versionFlag.status === 0 && versionFlag.stdout.trim() === `${pkg.name} ${pkg.version}`, "--version did not use default-command normalization");

const help = run(["help"]);
assert(help.status === 0, `help command failed: ${help.stderr}`);
assert(help.stdout.includes("Usage:") && help.stdout.includes("--log-format") && help.stdout.includes("activate          Deploy/update Worker"), "help output omitted current CLI options");
assert(help.stdout.includes("newly generated account passwords are included once"), "help output incorrectly claims JSON can never contain a generated password");

const stateRoot = mkdtempSync(join(tmpdir(), "mbm-cli-entrypoint-state-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "mbm-cli-entrypoint-workspace-"));
try {
  const debugSecret = `ghp_${"A".repeat(36)}`;
  const missingDebugWorkspace = join(homedir(), `.mbm-debug-${debugSecret}-${process.pid}-missing`);
  const debugFailure = run(["workspace", "set", missingDebugWorkspace, "--state-dir", stateRoot], { MBM_DEBUG: "1" });
  assert(debugFailure.status !== 0, "debug redaction fixture unexpectedly resolved a missing workspace");
  assert(!debugFailure.stderr.includes(homedir()), "debug top-level exception leaked the local home path");
  assert(!debugFailure.stderr.includes(debugSecret), "debug top-level exception leaked a credential-shaped value");
  assert(debugFailure.stderr.includes("<home>") && debugFailure.stderr.includes("<redacted-access-token>"),
    "debug top-level exception did not use the shared log redaction boundary");

  const initial = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(initial.status === 0, `workspace show failed: ${initial.stderr}`);
  assert(initial.stdout.includes("No workspace selected yet"), "workspace show returned an unexpected initial state");

  const selected = run(["workspace", "set", workspaceRoot, "--state-dir", stateRoot]);
  assert(selected.status === 0 && selected.stdout.includes("Selected workspace:"), `workspace set failed: ${selected.stderr}`);
  const persistedConfig = JSON.parse(readFileSync(join(stateRoot, "config.json"), "utf8"));
  const persistedWorkspace = String(persistedConfig.selectedWorkspace || "");
  assert(
    normalizePathText(persistedWorkspace) === normalizePathText(realpathSync.native ? realpathSync.native(workspaceRoot) : realpathSync(workspaceRoot)),
    "workspace selection config did not contain the canonical workspace",
  );
  const remembered = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(
    remembered.status === 0 && normalizePathText(remembered.stdout.trim()) === normalizePathText(persistedWorkspace),
    "workspace show did not return the persisted selection",
  );

  const status = run(["status", "--workspace", workspaceRoot, "--state-dir", stateRoot]);
  assert(status.status === 0, `status command failed without a Worker: ${status.stderr}`);
  const statusPayload = JSON.parse(status.stdout);
  assert(statusPayload.workerHealth.error === "no worker url", "status did not report the missing Worker deterministically");

  const activateWithoutDeployment = run(["activate", "--workspace", workspaceRoot, "--state-dir", stateRoot, "--json"]);
  assert(activateWithoutDeployment.status !== 0 && activateWithoutDeployment.stderr.includes("requires an existing deployment"), "activate did not fail closed before first deployment");

  const clientConfig = run(["client-config", "codex", "--workspace", workspaceRoot, "--state-dir", stateRoot]);
  assert(clientConfig.status === 0 && clientConfig.stdout.includes("[mcp_servers.machine_bridge]"), `client-config failed: ${clientConfig.stderr}`);

  const removedApprovalCommand = run(["approval", "list", "--workspace", workspaceRoot, "--state-dir", stateRoot]);
  assert(removedApprovalCommand.status === 2 && removedApprovalCommand.stderr.includes("Unknown command"),
    "obsolete approval/lease CLI remained user-accessible");

  const reset = run(["workspace", "reset", "--state-dir", stateRoot]);
  assert(reset.status === 0 && reset.stdout.includes("selection reset"), `workspace reset failed: ${reset.stderr}`);
  const afterReset = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(afterReset.stdout.includes("No workspace selected yet"), "workspace reset did not clear the selection");

  const unknown = run(["not-a-command"]);
  assert(unknown.status === 2 && unknown.stderr.includes("Unknown command"), "unknown command did not return the documented usage error");
  for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
    const topLevel = run([inherited]);
    assert(topLevel.status === 2 && topLevel.stderr.includes("Unknown command"), `prototype-shaped command ${inherited} bypassed command validation`);
    const resourceAction = run(["resource", inherited]);
    assert(resourceAction.status !== 0 && resourceAction.stderr.includes("Unknown resource action"),
      `prototype-shaped resource action ${inherited} bypassed action validation: ${describeRun(resourceAction)}`);
    const browserAction = run(["browser", inherited]);
    assert(browserAction.status !== 0 && browserAction.stderr.includes("Unknown browser action"),
      `prototype-shaped browser action ${inherited} bypassed action validation: ${describeRun(browserAction)}`);
    const serviceAction = run(["service", inherited]);
    assert(serviceAction.status !== 0 && serviceAction.stderr.includes("Unknown service action"),
      `prototype-shaped service action ${inherited} bypassed action validation: ${describeRun(serviceAction)}`);
  }
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log("CLI entrypoint test ok");


async function testDirectLoopbackHealth() {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const client = new EventEmitter();
    client.setTimeout = (timeoutMs, onTimeout) => { client.timeoutMs = timeoutMs; client.onTimeout = onTimeout; return client; };
    client.destroy = (error) => { if (error) queueMicrotask(() => client.emit("error", error)); };
    client.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      onResponse(response);
      response.end(JSON.stringify({ ok: true, broker: "machine-bridge-browser" }));
    };
    return client;
  };
  const port = 39393;
  const health = await readLoopbackJson(`http://127.0.0.1:${port}/healthz`, { request, timeoutMs: 1234 });
  assert(health?.ok === true && health?.broker === "machine-bridge-browser", "loopback browser health did not parse injected JSON response");
  assert(calls.length === 1, "loopback health did not issue exactly one canonical request");
  const options = calls[0];
  assert(options.protocol === "http:" && options.hostname === "127.0.0.1" && options.port === port
    && options.path === "/healthz" && options.method === "GET",
  "loopback health lost its canonical request target");
  assert(options.agent === false && options.headers?.accept === "application/json" && options.headers?.connection === "close",
    "loopback health request stopped bypassing ambient proxy/keepalive state");
  const beforeRejected = calls.length;
  assert(await readLoopbackJson(`http://localhost:${port}/healthz`, { request }) === null,
    "loopback health accepted a non-canonical hostname");
  assert(calls.length === beforeRejected, "non-canonical loopback target reached the request transport");
}

function normalizePathText(value) {
  return String(value).split("\\").join("/").toLowerCase();
}

function run(args, envOverrides = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
    windowsHide: true,
  });
}

function describeRun(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error?.message || result.error) : null,
    stdout: String(result.stdout || "").slice(-1024),
    stderr: String(result.stderr || "").slice(-1024),
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
