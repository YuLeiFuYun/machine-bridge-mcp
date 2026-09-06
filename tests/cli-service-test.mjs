import { createServiceCommand } from "../src/local/cli-service.mjs";

const outputs = [];
const exits = [];
const calls = [];
const state = { workspace: { path: "/synthetic-workspace" }, worker: { url: "https://worker.example.test" } };
const service = {
  async autostartStatus() { calls.push("status"); return { ok: true, active: true, provider: "test", state: "running" }; },
  async installAutostart(options) { calls.push(["install", options]); return { ok: true, provider: "test" }; },
  async startAutostart(options) { calls.push(["start", options]); return { ok: true, active: true, already_running: true, provider: "test" }; },
  async stopAutostart(options) { calls.push(["stop", options]); return { ok: true, active_before: true, active: false, provider: "test" }; },
  async uninstallAutostart() { throw new Error("uninstall must use the lifecycle controller"); },
};
const command = createServiceCommand({
  chooseWorkspace: async (args, options) => { calls.push(["workspace", args, options]); return "/synthetic-workspace"; },
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: (quiet) => ({ quiet }),
  currentPackageVersion: () => "3.0.0-test",
  service,
  inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service", pid: 42 }),
  stopWorkspaceServiceDaemon: async (_state, options) => { calls.push(["daemon-stop", options]); return { ok: true, found: true, stopped: true }; },
  stopAndRemoveAutostart: async (options) => {
    calls.push(["lifecycle", options]);
    return { ok: true, removed: true, workspace_daemons: [{ ok: true, stopped: true }] };
  },
  serviceEnvironmentSummary: () => ({ keys: ["HTTPS_PROXY"] }),
  loadServiceOwner: () => null,
  scheduleServiceRestart: async () => { calls.push("restart-scheduled"); return { ok: true, scheduled: true, delay_ms: 300 }; },
  startOwnedServiceRuntime: async (options) => { calls.push(["owned-start", options]); return service.startAutostart(options); },
  loadState: () => structuredClone(state),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => "/synthetic-workspace",
  entryScript: "/package/bin/machine-mcp.mjs",
  setExitCode: (value) => exits.push(value),
  print: (value) => outputs.push(JSON.parse(value)),
});

await command({ _: ["status"] });
assert(outputs.at(-1).effective_active === true, "status did not combine provider and daemon state");
assert(outputs.at(-1).orphaned_workspace_daemon === false, "running provider was misreported as orphaned");
assert(outputs.at(-1).service_environment.keys[0] === "HTTPS_PROXY", "status lost environment summary");
assert(exits.length === 0, "status changed the process exit code");

const orphanOutputs = [];
const orphanStatus = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async autostartStatus() { return { ok: true, active: false, provider: "test", state: "not running" }; } },
  inspectWorkspaceDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service", pid: 42 }),
  serviceEnvironmentSummary: () => ({ keys: [] }),
  loadServiceOwner: () => null,
  loadState: () => structuredClone(state),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => "/synthetic-workspace",
  print: (value) => orphanOutputs.push(JSON.parse(value)),
});
await orphanStatus({ _: ["status"] });
assert(orphanOutputs.at(-1).effective_active === true && orphanOutputs.at(-1).orphaned_workspace_daemon === true,
  "inactive provider with a verified surviving service daemon was not projected as orphaned active state");
assert(orphanOutputs.at(-1).service_owner.status === "missing" && orphanOutputs.at(-1).service_environment.keys.length === 0,
  "orphan status inherited installed machine owner or environment state");

const unknownOutputs = [];
const unknownStatus = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async autostartStatus() { return { ok: true, active: null, provider: "test", state: "unknown" }; } },
  inspectWorkspaceDaemon: () => ({ alive: false, verified_service_daemon: false, mode: "service", pid: null }),
  serviceEnvironmentSummary: () => ({ keys: [] }),
  loadServiceOwner: () => null,
  loadState: () => structuredClone(state),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => "/synthetic-workspace",
  print: (value) => unknownOutputs.push(JSON.parse(value)),
});
await unknownStatus({ _: ["status"] });
assert(unknownOutputs.at(-1).effective_active === null,
  "unverifiable provider state was collapsed into an inactive service status");
assert(unknownOutputs.at(-1).service_owner.status === "missing" && unknownOutputs.at(-1).service_environment.keys.length === 0,
  "unknown status inherited installed machine owner or environment state");

const ownerStatusOutput = [];
const ownerStatus = createServiceCommand({
  chooseWorkspace: async () => "/fallback-workspace",
  stateRootFromArgs: () => "/fallback-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}), currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async autostartStatus() { return { ok: true, active: true, provider: "test" }; } },
  loadServiceOwner: () => ({ status: "committed", version: "3.0.0-owner", workspace: "/owner-workspace", stateRoot: "/owner-state", entryScript: "/owner-entry" }),
  loadState: (workspace, options) => ({ workspace: { path: workspace }, paths: { stateRoot: options.stateDir }, worker: {} }),
  inspectWorkspaceDaemon: (_state, options) => ({ alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: true, version: options.expectedVersion }),
  serviceEnvironmentSummary: (root) => ({ root }),
  selectedWorkspace: () => "/fallback-workspace", resolveWorkspace: (value) => value,
  print: (value) => ownerStatusOutput.push(JSON.parse(value)),
});
await ownerStatus({ _: ["status"] });
assert(ownerStatusOutput.at(-1).workspace === "/owner-workspace"
  && ownerStatusOutput.at(-1).service_owner.version === "3.0.0-owner"
  && ownerStatusOutput.at(-1).service_environment.root === "/owner-state",
"service status did not project the committed machine owner instead of the selected-workspace fallback");

const invalidOwnerOutput = [];
const invalidOwnerStatus = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace", stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock, structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test", service,
  loadServiceOwner: () => { throw new Error("corrupt owner file"); },
  loadState: () => structuredClone(state), resolveWorkspace: value => value, selectedWorkspace: () => "/synthetic-workspace",
  inspectWorkspaceDaemon: () => ({ alive: false }), serviceEnvironmentSummary: () => ({ keys: [] }),
  print: value => invalidOwnerOutput.push(JSON.parse(value)),
});
await invalidOwnerStatus({ _: ["status", "/synthetic-workspace"] });
assert(invalidOwnerOutput.at(-1).service_owner.status === "invalid"
  && invalidOwnerOutput.at(-1).service_owner.error_class === "invalid_state",
"service status became unavailable when the owner record was corrupt");

const installCalls = [];
const installCommand = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: quiet => ({ quiet }), currentPackageVersion: () => "3.0.0-test",
  service: {
    ...service,
    async autostartStatus() { return { ok: true, active: false, provider: "test" }; },
    async installAutostart(options) { installCalls.push(options); return { ok: true, provider: "test" }; },
  },
  inspectWorkspaceDaemon: () => ({ alive: false }),
  loadState: () => structuredClone(state), resolveWorkspace: value => value, selectedWorkspace: () => null,
  entryScript: "/package/bin/machine-mcp.mjs",
});
await installCommand({ _: ["install", "/synthetic-workspace"], quiet: true });
const install = installCalls[0];
assert(install.workspace === "/synthetic-workspace" && install.stateRoot === "/synthetic-state", "install lost resolved inputs");
assert(install.entryScript.endsWith("machine-mcp.mjs") && install.logger.quiet === true, "install lost entrypoint or logging options");
for (const [provider, daemon, expected] of [
  [{ active: true }, { alive: false }, "provider or workspace daemon is active"],
  [{ active: false }, { alive: true }, "provider or workspace daemon is active"],
  [{ active: null }, { alive: false }, "activity could not be verified"],
]) {
  let installs = 0;
  const guardedInstall = createServiceCommand({
    chooseWorkspace: async () => "/synthetic-workspace", stateRootFromArgs: () => "/synthetic-state",
    acquireMachineServiceLockWithWait: acquireTestServiceLock, structuredLogger: () => ({}),
    currentPackageVersion: () => "3.0.0-test", loadState: () => structuredClone(state),
    service: { ...service, async autostartStatus() { return provider; }, async installAutostart() { installs += 1; return { ok: true }; } },
    inspectWorkspaceDaemon: () => daemon, resolveWorkspace: value => value, selectedWorkspace: () => null,
  });
  await expectReject(() => guardedInstall({ _: ["install"] }), expected);
  assert(installs === 0, `guarded service install mutated the provider for ${expected}`);
}

await command({ _: ["start"] });
assert(outputs.at(-1).already_running === true, "idempotent start did not preserve already-running state");
assert(calls.some((entry) => Array.isArray(entry) && entry[0] === "owned-start"), "start bypassed owner-aware runtime convergence");

for (const [daemon, providerActive, expected] of [
  [{ alive: true, verified_service_daemon: false, mode: "foreground", pid: 77 }, false, "foreground daemon"],
  [{ alive: true, verified_service_daemon: false, mode: "service", identity_reason: "command_mismatch", pid: 78 }, false, "command_mismatch"],
  [{ alive: true, verified_service_daemon: true, mode: "service", pid: 79 }, false, "orphaned service daemon"],
]) {
  let providerStarts = 0;
  const guardedStart = createServiceCommand({
    chooseWorkspace: async () => "/synthetic-workspace",
    stateRootFromArgs: () => "/synthetic-state",
    acquireMachineServiceLockWithWait: async () => ({ acquired: true, release() {} }),
    structuredLogger: () => ({}),
    currentPackageVersion: () => "3.0.0-test",
    service: {
      ...service,
      async autostartStatus() { return { ok: true, active: providerActive, provider: "test" }; },
      async startAutostart() { providerStarts += 1; return { ok: true, active: true }; },
    },
    startOwnedServiceRuntime: async () => {
      const identity = daemon.mode === "foreground" ? "foreground daemon" : daemon.identity_reason || "orphaned service daemon";
      throw new Error(identity);
    },
    inspectWorkspaceDaemon: () => daemon,
    loadState: () => structuredClone(state),
    resolveWorkspace: (value) => value,
    selectedWorkspace: () => "/synthetic-workspace",
  });
  await expectReject(() => guardedStart({ _: ["start"] }), expected);
  assert(providerStarts === 0, `guarded service start mutated the provider for ${expected}`);
}

await command({ _: ["restart"] });
assert(outputs.at(-1).scheduled === true && outputs.at(-1).reason === "restart_scheduled", "restart did not schedule a detached handoff");
assert(calls.includes("restart-scheduled"), "restart bypassed the handoff scheduler");
assert(!calls.some((entry) => Array.isArray(entry) && entry[0] === "service-lock" && entry[1] === "service-restart"),
  "restart parent held the lock instead of the detached mutation helper");

await command({ _: ["stop"], workspace: "/synthetic-workspace" });
assert(outputs.at(-1).ok === true && outputs.at(-1).workspace_daemon.stopped === true, "stop did not combine lifecycle results");
assert(calls.some((entry) => Array.isArray(entry) && entry[0] === "daemon-stop" && entry[1].reason === "service stop"), "stop bypassed verified daemon shutdown");

await command({ _: ["uninstall"] });
assert(outputs.at(-1).autostart_removed === true, "uninstall lost lifecycle result normalization");
const lifecycle = calls.find((entry) => Array.isArray(entry) && entry[0] === "lifecycle")[1];
assert(lifecycle.states.length === 1 && lifecycle.stopAutostart === service.stopAutostart, "uninstall bypassed shared lifecycle controller");

await command({ _: ["remove"] });
assert(outputs.at(-1).autostart_removed === true, "remove alias did not use uninstall semantics");
const lockOperations = calls.filter((entry) => Array.isArray(entry) && entry[0] === "service-lock").map((entry) => entry[1]);
const unlockOperations = calls.filter((entry) => Array.isArray(entry) && entry[0] === "service-unlock").map((entry) => entry[1]);
const allowedLockOperations = new Set(["service-install", "service-start", "service-stop", "service-uninstall", "service-remove"]);
assert(lockOperations.every(operation => allowedLockOperations.has(operation))
  && [...allowedLockOperations].every(operation => lockOperations.includes(operation)),
`direct service mutations lost serialization or introduced an unknown lock label: ${lockOperations.join(",")}`);
assert(JSON.stringify(unlockOperations) === JSON.stringify(lockOperations),
  "direct service mutation did not release every acquired machine-service lock");

for (const [action, args] of [
  ["start", { workspace: "/other" }],
  ["restart", { stateDir: "/other-state" }],
  ["uninstall", { workspace: "/other" }],
  ["remove", { _: ["remove", "/other"] }],
]) {
  await expectReject(() => command({ _: [action], ...args }), "single installed machine service");
}

const mismatchedStopCalls = [];
const mismatchedStop = createServiceCommand({
  chooseWorkspace: async () => "/other-workspace",
  stateRootFromArgs: () => "/other-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: {
    ...service,
    async autostartStatus() { return { ok: true, active: true, provider: "test" }; },
    async stopAutostart() { mismatchedStopCalls.push("provider-stop"); return { ok: true }; },
  },
  loadState: () => ({ workspace: { path: "/other-workspace" }, worker: {} }),
  resolveWorkspace: (value) => value,
  selectedWorkspace: () => null,
  inspectWorkspaceDaemon: () => ({ alive: false, verified_service_daemon: false, identity_reason: "not_running" }),
});
await expectReject(
  () => mismatchedStop({ _: ["stop"], workspace: "/other-workspace", stateDir: "/other-state" }),
  "does not own its verified daemon",
);
assert(mismatchedStopCalls.length === 0, "mismatched targeted stop reached the machine service manager");

for (const malformedLock of [{ acquired: false, release() {} }, { acquired: true }]) {
  let providerCalls = 0;
  const lockedOut = createServiceCommand({
    chooseWorkspace: async () => "/synthetic-workspace",
    stateRootFromArgs: () => "/synthetic-state",
    acquireMachineServiceLockWithWait: async () => malformedLock,
    structuredLogger: () => ({}),
    currentPackageVersion: () => "3.0.0-test",
    service: { ...service, async startAutostart() { providerCalls += 1; return { ok: true, active: true }; } },
    selectedWorkspace: () => null,
  });
  await expectReject(() => lockedOut({ _: ["start"] }), "operation lock could not be acquired");
  assert(providerCalls === 0, "service provider ran without an acquired releasable machine-service lock");
}

let throwingReleased = false;
const throwingMutation = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: async () => ({ acquired: true, release() { throwingReleased = true; } }),
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async startAutostart() { throw new Error("provider should be called through owner convergence"); } },
  startOwnedServiceRuntime: async () => { throw new Error("synthetic provider failure"); },
  selectedWorkspace: () => null,
});
await expectReject(() => throwingMutation({ _: ["start"] }), "synthetic provider failure");
assert(throwingReleased, "service mutation exception leaked the machine-service lock");

const noWorker = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
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
expectThrow(() => createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace", stateRootFromArgs: () => "/synthetic-state", structuredLogger: () => ({}),
}), "currentPackageVersion");

const noWorkspaceOutputs = [];
const noWorkspace = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async autostartStatus() { return { ok: true, active: false, provider: "test" }; } },
  selectedWorkspace: () => null,
  serviceEnvironmentSummary: () => ({ keys: [] }),
  loadServiceOwner: () => null,
  print: (value) => noWorkspaceOutputs.push(JSON.parse(value)),
});
await noWorkspace({ _: [] });
assert(noWorkspaceOutputs.at(-1).workspace === null && noWorkspaceOutputs.at(-1).workspace_daemon === null, "default status did not support an unselected workspace");

const failingStartOutputs = [];
const failingStart = createServiceCommand({
  chooseWorkspace: async () => "/synthetic-workspace",
  stateRootFromArgs: () => "/synthetic-state",
  acquireMachineServiceLockWithWait: acquireTestServiceLock,
  structuredLogger: () => ({}),
  currentPackageVersion: () => "3.0.0-test",
  service: { ...service, async startAutostart() { throw new Error("provider should be called through owner convergence"); } },
  startOwnedServiceRuntime: async () => ({ ok: false, active: false, reason: "synthetic" }),
  selectedWorkspace: () => null,
  print: (value) => failingStartOutputs.push(JSON.parse(value)),
  setExitCode: (value) => exits.push(value),
});
await failingStart({ _: ["start"] });
assert(failingStartOutputs.at(-1).ok === false && exits.at(-1) === 1, "failed start did not propagate a failing exit code");

console.log("CLI service adapter test ok");

async function acquireTestServiceLock(options = {}) {
  calls.push(["service-lock", options.operation]);
  return {
    acquired: true,
    release() { calls.push(["service-unlock", options.operation]); },
  };
}

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}, received ${error?.message || error}`);
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

const originalLog = console.log;
const originalExitCode = process.exitCode;
const defaultOutput = [];
try {
  console.log = (value) => defaultOutput.push(JSON.parse(value));
  process.exitCode = undefined;
  const defaults = createServiceCommand({
    chooseWorkspace: async () => "/synthetic-workspace",
    stateRootFromArgs: () => "/synthetic-state",
    acquireMachineServiceLockWithWait: acquireTestServiceLock,
    structuredLogger: () => ({}),
    currentPackageVersion: () => "3.0.0-test",
    service: { ...service, async startAutostart() { throw new Error("default adapter should delegate through owner convergence"); } },
    startOwnedServiceRuntime: async () => ({ ok: false, active: false, reason: "default-adapter-test" }),
    selectedWorkspace: () => null,
  });
  await defaults({ _: ["start"] });
  assert(defaultOutput.at(-1).reason === "default-adapter-test", "default console adapter lost the service result");
  assert(process.exitCode === 1, "default process exit adapter did not preserve failure status");
} finally {
  console.log = originalLog;
  process.exitCode = originalExitCode;
}
