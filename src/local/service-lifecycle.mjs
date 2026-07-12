export async function stopAndRemoveAutostart({
  states = [],
  stateRoot,
  logger = console,
  reason = "service uninstall",
  stopAutostart,
  uninstallAutostart,
  stopWorkspaceServiceDaemon,
} = {}) {
  assertFunction(stopAutostart, "stopAutostart");
  assertFunction(uninstallAutostart, "uninstallAutostart");
  assertFunction(stopWorkspaceServiceDaemon, "stopWorkspaceServiceDaemon");

  const platformStop = await stopAutostart({ logger });
  if (platformStop?.ok !== true) {
    return {
      ok: false,
      removed: false,
      reason: "platform_stop_failed",
      platform_stop: platformStop,
      workspace_daemons: [],
      removal: null,
    };
  }

  const workspaceDaemons = [];
  for (const state of states) {
    const result = await stopWorkspaceServiceDaemon(state, { logger, reason });
    workspaceDaemons.push({ workspace: state?.workspace?.path || null, ...result });
    if (result.found && !result.ok) {
      return {
        ok: false,
        removed: false,
        reason: "workspace_daemon_stop_failed",
        platform_stop: platformStop,
        workspace_daemons: workspaceDaemons,
        removal: null,
      };
    }
  }

  const removal = await uninstallAutostart({ stateRoot, logger });
  const removed = removal?.ok === true;
  return {
    ok: removed,
    removed,
    reason: removed ? "removed" : "platform_remove_failed",
    platform_stop: platformStop,
    workspace_daemons: workspaceDaemons,
    removal,
  };
}

function assertFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
}
