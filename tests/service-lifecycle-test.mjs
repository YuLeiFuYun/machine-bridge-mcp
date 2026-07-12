import { stopAndRemoveAutostart } from "../src/local/service-lifecycle.mjs";

await successOrderTest();
await platformFailureTest();
await missingPlatformResultTest();
await daemonFailureTest();
await removalFailureTest();
await missingRemovalResultTest();
console.log("service lifecycle test ok");

async function successOrderTest() {
  const calls = [];
  const result = await stopAndRemoveAutostart({
    states: [state("one"), state("two")],
    stateRoot: "/state",
    stopAutostart: async () => { calls.push("platform-stop"); return { ok: true }; },
    stopWorkspaceServiceDaemon: async (value) => { calls.push(`daemon-stop:${value.workspace.path}`); return { ok: true, found: true, stopped: true }; },
    uninstallAutostart: async () => { calls.push("platform-remove"); return { ok: true }; },
  });
  assert(result.ok && result.removed && result.workspace_daemons.length === 2, "successful lifecycle result is incomplete");
  assert(calls.join(",") === "platform-stop,daemon-stop:one,daemon-stop:two,platform-remove", "service lifecycle order is unsafe");
}

async function platformFailureTest() {
  const calls = [];
  const result = await stopAndRemoveAutostart({
    states: [state("one")],
    stopAutostart: async () => { calls.push("platform-stop"); return { ok: false, active: true }; },
    stopWorkspaceServiceDaemon: async () => { calls.push("daemon-stop"); return { ok: true }; },
    uninstallAutostart: async () => { calls.push("platform-remove"); return { ok: true }; },
  });
  assert(!result.ok && !result.removed && result.reason === "platform_stop_failed", "platform stop failure did not fail closed");
  assert(calls.join(",") === "platform-stop", "platform stop failure continued mutating service state");
}

async function missingPlatformResultTest() {
  const calls = [];
  const result = await stopAndRemoveAutostart({
    states: [state("one")],
    stopAutostart: async () => { calls.push("platform-stop"); return undefined; },
    stopWorkspaceServiceDaemon: async () => { calls.push("daemon-stop"); return { ok: true }; },
    uninstallAutostart: async () => { calls.push("platform-remove"); return { ok: true }; },
  });
  assert(!result.ok && result.reason === "platform_stop_failed", "missing platform result was treated as success");
  assert(calls.join(",") === "platform-stop", "missing platform result continued mutating service state");
}

async function daemonFailureTest() {
  const calls = [];
  const result = await stopAndRemoveAutostart({
    states: [state("one"), state("two")],
    stopAutostart: async () => { calls.push("platform-stop"); return { ok: true }; },
    stopWorkspaceServiceDaemon: async (value) => {
      calls.push(`daemon-stop:${value.workspace.path}`);
      return value.workspace.path === "one" ? { ok: false, found: true, reason: "foreground_daemon" } : { ok: true, found: true };
    },
    uninstallAutostart: async () => { calls.push("platform-remove"); return { ok: true }; },
  });
  assert(!result.ok && !result.removed && result.reason === "workspace_daemon_stop_failed", "daemon stop failure did not fail closed");
  assert(calls.join(",") === "platform-stop,daemon-stop:one", "daemon stop failure continued to removal or unrelated profiles");
}

async function removalFailureTest() {
  const result = await stopAndRemoveAutostart({
    states: [],
    stopAutostart: async () => ({ ok: true }),
    stopWorkspaceServiceDaemon: async () => ({ ok: true }),
    uninstallAutostart: async () => ({ ok: false }),
  });
  assert(!result.ok && !result.removed && result.reason === "platform_remove_failed", "service definition removal failure was reported as success");
}

async function missingRemovalResultTest() {
  const result = await stopAndRemoveAutostart({
    states: [],
    stopAutostart: async () => ({ ok: true }),
    stopWorkspaceServiceDaemon: async () => ({ ok: true }),
    uninstallAutostart: async () => undefined,
  });
  assert(!result.ok && !result.removed && result.reason === "platform_remove_failed", "missing removal result was treated as success");
}

function state(path) { return { workspace: { path } }; }
function assert(condition, message) { if (!condition) throw new Error(message); }
