import { createServiceCommand } from "../src/local/cli-service.mjs";

const outputs = [];
const exits = [];
const calls = [];
const state = { workspace: { path: "/synthetic-workspace" }, worker: { url: "https://worker.example.test" } };
const service = {
  async autostartStatus() { calls.push("status"); return { ok: true, active: false, provider: "test" }; },
  async installAutostart(options) { calls.push(["install", options]); return { ok: true, provider: "test" }; },
  async startAutostart(options) { calls.push(["start", options]); return { ok: false, provider: "test", reason: "synthetic" }; },
  async stopAutostart(options) { calls.push(["stop", options]); return { ok: true, active_before: true, active: false, provider: "test" }; },
  async uninstallAutostart() { throw new Error("uninstall must use the lifecycle controller"); },
};
const command = createServiceCommand({
  chooseWorkspace: async (args, options) => { calls.push(["workspace", args, options]); return "/synthetic-workspace"; },
  stateRootFromArgs: () => "/synthetic-state",
  structuredLogger: (quiet) => ({ quiet }),
  service,
  inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: true }),
  stopWorkspaceServiceDaemon: async (_state, options) => { calls.push(["daemon-stop", options]); return { ok: true, found: true, stopped: true }; },
  stopAndRemoveAutostart: async (options) => {
    calls.push(["lifecycle", options]);
    return { ok: true, removed: true, workspace_daemons: [{ ok: true, stopped: true }] };
  },
  serviceEnvironmentSummary: () => ({ keys: ["HTTPS_PROXY"] }),
  loadState: () => structuredClone(state),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => "/synthetic-workspace",
  entryScript: "/package/bin/machine-mcp.mjs",
  setExitCode: (value) => exits.push(value),
  print: (value) => outputs.push(JSON.parse(value)),
});

await command({ _: ["status"] });
assert(outputs.at(-1).effective_active === true, "status did not combine provider and daemon state");
assert(outputs.at(-1).orphaned_workspace_daemon === true, "status lost orphaned-daemon diagnosis");
assert(outputs.at(-1).service_environment.keys[0] === "HTTPS_PROXY", "status lost environment summary");
assert(exits.length === 0, "status changed the process exit code");

await command({ _: ["install", "/synthetic-workspace"], quiet: true });
const install = calls.find((entry) => Array.isArray(entry) && entry[0] === "install")[1];
assert(install.workspace === "/synthetic-workspace" && install.stateRoot === "/synthetic-state", "install lost resolved inputs");
assert(install.entryScript.endsWith("machine-mcp.mjs") && install.logger.quiet === true, "install lost entrypoint or logging options");

await command({ _: ["start"] });
assert(exits.at(-1) === 1, "failed start did not set a failing exit code");

await command({ _: ["stop"], workspace: "/synthetic-workspace" });
assert(outputs.at(-1).ok === true && outputs.at(-1).workspace_daemon.stopped === true, "stop did not combine lifecycle results");
assert(calls.some((entry) => Array.isArray(entry) && entry[0] === "daemon-stop" && entry[1].reason === "service stop"), "stop bypassed verified daemon shutdown");

await command({ _: ["uninstall"], workspace: "/synthetic-workspace" });
assert(outputs.at(-1).autostart_removed === true, "uninstall lost lifecycle result normalization");
const lifecycle = calls.find((entry) => Array.isArray(entry) && entry[0] === "lifecycle")[1];
assert(lifecycle.states.length === 1 && lifecycle.stopAutostart === service.stopAutostart, "uninstall bypassed shared lifecycle controller");

await command({ _: ["remove"] });
assert(outputs.at(-1).autostart_removed === true, "remove alias did not use uninstall semantics");

const noWorker = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  structuredLogger: () => ({}),
  service,
  loadState: () => ({ workspace: { path: "/synthetic-workspace" }, worker: {} }),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => null,
});
await expectReject(() => noWorker({ _: ["install"] }), "No deployed Worker");
for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
  await expectReject(() => command({ _: [inherited] }), "Unknown service action");
}
expectThrow(() => createServiceCommand({}), "chooseWorkspace");
expectThrow(() => createServiceCommand({ chooseWorkspace: async () => "/synthetic-workspace" }), "stateRootFromArgs");
expectThrow(() => createServiceCommand({ chooseWorkspace: async () => "/synthetic-workspace", stateRootFromArgs: () => "/synthetic-state" }), "structuredLogger");

const defaulted = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  structuredLogger: () => ({}),
});
await expectReject(() => defaulted({ _: ["constructor"] }), "Unknown service action");

const noWorkspaceOutputs = [];
const noWorkspace = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  structuredLogger: () => ({}),
  service,
  selectedWorkspace: () => null,
  serviceEnvironmentSummary: () => ({ keys: [] }),
  print: (value) => noWorkspaceOutputs.push(JSON.parse(value)),
});
await noWorkspace({ _: [] });
assert(noWorkspaceOutputs.at(-1).workspace === null && noWorkspaceOutputs.at(-1).workspace_daemon === null, "default status did not support an unselected workspace");

const failingStopOutputs = [];
const failingStop = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  structuredLogger: () => ({}),
  service: { ...service, async stopAutostart() { return { ok: false, active: true }; } },
  selectedWorkspace: () => null,
  print: (value) => failingStopOutputs.push(JSON.parse(value)),
  setExitCode: (value) => exits.push(value),
});
await failingStop({ _: ["stop"] });
assert(failingStopOutputs.at(-1).ok === false && exits.at(-1) === 1, "provider stop failure was not propagated");

const originalLog = console.log;
const originalExitCode = process.exitCode;
const defaultOutput = [];
try {
  console.log = (value) => defaultOutput.push(JSON.parse(value));
  process.exitCode = undefined;
  const defaults = createServiceCommand({
    chooseWorkspace: async () => "/synthetic-workspace",
    stateRootFromArgs: () => "/synthetic-state",
    structuredLogger: () => ({}),
    service,
    loadState: () => structuredClone(state),
    resolveWorkspace: (value) => value,
    selectedWorkspace: () => null,
  });
  await defaults({ _: ["start"] });
  assert(defaultOutput.at(-1).ok === false && process.exitCode === 1, "default print/exit adapters were not exercised");
} finally {
  console.log = originalLog;
  process.exitCode = originalExitCode;
}
console.log("CLI service adapter test ok");

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected rejection containing ${expected}`);
}
function expectThrow(operation, expected) {
  try { operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected throw containing ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
