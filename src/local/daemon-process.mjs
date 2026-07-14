import path from "node:path";
import process from "node:process";
import {
  acquireDaemonLock,
  daemonLockPathForState,
  readDaemonLockOwner,
  resolveWorkspace,
} from "./state.mjs";
import { inspectProcessInstance, isPidAlive, processCommandLine, splitProcessCommandLine } from "./process-identity.mjs";

const DEFAULT_TAKEOVER_TIMEOUT_MS = 15_000;
const DEFAULT_TAKEOVER_POLL_MS = 100;

export async function acquireDaemonLockWithTakeover(state, options = {}) {
  const ownerMetadata = options.ownerMetadata || {};
  const timeoutMs = boundedPositiveInt(options.timeoutMs, DEFAULT_TAKEOVER_TIMEOUT_MS);
  const pollMs = boundedPositiveInt(options.pollMs, DEFAULT_TAKEOVER_POLL_MS);
  let lock = acquireDaemonLock(state, ownerMetadata);
  if (lock.acquired || !options.takeOverServiceOwner) return lock;

  const stopped = await stopWorkspaceServiceDaemon(state, {
    owner: lock.owner,
    timeoutMs,
    pollMs,
    logger: options.logger,
    reason: "foreground startup",
  });
  if (!stopped.verified_service_daemon) return lock;
  if (!stopped.ok) {
    const pid = stopped.pid ? `pid ${stopped.pid}` : "unknown pid";
    throw new Error(`background daemon did not release the workspace within ${Math.ceil(stopped.timeout_ms / 1000)} seconds (${pid}); run \`machine-mcp service stop\`, verify \`machine-mcp service status\`, and retry`);
  }

  // A terminated daemon can release its token immediately before the filesystem
  // makes the lock removal visible to this process. Retry only this handoff.
  const handoffDeadline = Date.now() + Math.min(timeoutMs, 1_000);
  do {
    lock = acquireDaemonLock(state, ownerMetadata);
    if (lock.acquired) {
      options.logger?.info?.("background daemon stopped; foreground startup is taking over the workspace");
      return lock;
    }
    if (lock.owner?.pid && isPidAlive(lock.owner.pid)) return lock;
    await sleep(Math.min(pollMs, Math.max(1, handoffDeadline - Date.now())));
  } while (Date.now() < handoffDeadline);
  return lock;
}

export async function stopWorkspaceServiceDaemon(state, options = {}) {
  const timeoutMs = boundedPositiveInt(options.timeoutMs, DEFAULT_TAKEOVER_TIMEOUT_MS);
  const pollMs = boundedPositiveInt(options.pollMs, DEFAULT_TAKEOVER_POLL_MS);
  const logger = options.logger || { info() {}, warn() {} };
  const deadline = Date.now() + timeoutMs;
  const signalled = new Set();
  let owner = options.owner || readDaemonLockOwner(daemonLockPathForState(state));
  let verified = false;
  let lastOwner = owner;

  while (true) {
    if (owner?.pid && isPidAlive(owner.pid)) {
      lastOwner = owner;
      const identity = inspectWorkspaceDaemonOwner(state, owner);
      if (!identity.verified_service_daemon) {
        return {
          ok: false,
          found: true,
          verified_service_daemon: false,
          reason: identity.reason,
          timeout_ms: timeoutMs,
          ...publicDaemonOwner(owner),
        };
      }
      verified = true;
      if (!signalled.has(Number(owner.pid))) {
        const purpose = options.reason || "service stop";
        logger.info?.(`stopping detached background daemon (pid ${owner.pid}) for ${purpose}`);
        try {
          process.kill(Number(owner.pid), "SIGTERM");
        } catch (error) {
          if (error?.code !== "ESRCH") {
            return {
              ok: false,
              found: true,
              verified_service_daemon: true,
              reason: "signal_failed",
              timeout_ms: timeoutMs,
              ...publicDaemonOwner(owner),
            };
          }
        }
        signalled.add(Number(owner.pid));
      }
    }

    const liveSignalled = [...signalled].filter((pid) => isPidAlive(pid));
    const currentOwnerAlive = Boolean(owner?.pid && isPidAlive(owner.pid));
    if (!currentOwnerAlive && liveSignalled.length === 0) break;

    if (Date.now() >= deadline) {
      logger.warn?.(`detached background daemon did not stop within ${Math.ceil(timeoutMs / 1000)} seconds`);
      const remainingPid = Number(owner?.pid) || liveSignalled[0] || null;
      return {
        ok: false,
        found: true,
        stopped: false,
        verified_service_daemon: verified,
        reason: "timeout",
        timeout_ms: timeoutMs,
        pid: remainingPid,
        mode: publicDaemonMode(lastOwner),
        version: typeof lastOwner?.version === "string" ? lastOwner.version : "unknown",
      };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    owner = readDaemonLockOwner(daemonLockPathForState(state));
  }

  // Reclaim a stale lock only through the normal token-aware primitive.
  const staleCleanup = acquireDaemonLock(state, { mode: "service" });
  if (staleCleanup.acquired) staleCleanup.release();
  return {
    ok: true,
    found: verified,
    stopped: verified,
    verified_service_daemon: verified,
    reason: verified ? "stopped" : "not_running",
    timeout_ms: timeoutMs,
    ...(lastOwner ? publicDaemonOwner(lastOwner) : {}),
  };
}

export function inspectWorkspaceDaemon(state) {
  const owner = readDaemonLockOwner(daemonLockPathForState(state));
  if (!owner) return { present: false, alive: false, verified_service_daemon: false };
  const alive = Boolean(owner.pid && isPidAlive(owner.pid));
  const identity = alive
    ? inspectWorkspaceDaemonOwner(state, owner)
    : { verified_service_daemon: false, reason: "stale_lock" };
  return {
    present: true,
    alive,
    verified_service_daemon: identity.verified_service_daemon,
    identity_reason: identity.reason,
    ...publicDaemonOwner(owner),
  };
}

function inspectWorkspaceDaemonOwner(state, owner) {
  if (!owner || owner.purpose !== "daemon") return { verified_service_daemon: false, reason: "invalid_lock_owner" };
  const pid = Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return { verified_service_daemon: false, reason: "invalid_pid" };
  const processIdentity = inspectProcessInstance(owner);
  if (!processIdentity.current) return { verified_service_daemon: false, reason: processIdentity.reason };
  if (!sameCanonicalPath(owner.workspace, state.workspace.path)) return { verified_service_daemon: false, reason: "workspace_mismatch" };
  if (owner.mode === "foreground") return { verified_service_daemon: false, reason: "foreground_daemon" };
  if (owner.mode !== "service") return { verified_service_daemon: false, reason: "invalid_daemon_mode" };

  const command = processCommandLine(pid);
  if (!command) {
    return { verified_service_daemon: false, reason: "service_identity_unavailable" };
  }
  const argv = splitProcessCommandLine(command);
  const entryName = path.basename(String(owner.entryScript || "machine-mcp"));
  const workspaceArg = commandFlagValue(argv, "--workspace");
  const stateRootArg = commandFlagValue(argv, "--state-dir");
  const entryMatches = argv.some((value) => {
    const name = path.basename(value);
    return name === entryName || name === "machine-mcp" || name === "machine-mcp.mjs";
  });
  const matches = argv.includes("--daemon-only")
    && sameCanonicalPath(workspaceArg, state.workspace.path)
    && sameCanonicalPath(stateRootArg, state.paths.stateRoot)
    && entryMatches;
  return { verified_service_daemon: matches, reason: matches ? "service_command" : "command_mismatch" };
}

function commandFlagValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : "";
}

function sameCanonicalPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const a = resolveWorkspace(left);
    const b = resolveWorkspace(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function publicDaemonOwner(owner) {
  return {
    pid: Number(owner?.pid) || null,
    mode: publicDaemonMode(owner),
    version: typeof owner?.version === "string" ? owner.version : "unknown",
  };
}

function publicDaemonMode(owner) {
  return owner?.mode === "service" || owner?.mode === "foreground" ? owner.mode : "invalid";
}

function boundedPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
