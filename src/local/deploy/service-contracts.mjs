// @ts-check
/**
 * @param {{
 *   state?: unknown,
 *   inspectWorkspaceDaemon?: (state: unknown) => unknown,
 *   ownsPlatformAutostart?: (daemon: unknown) => boolean,
 *   stopPlatformService?: () => Promise<{ ok?: boolean, active?: boolean } | null>
 * }} [options]
 * @returns {Promise<{ owned: boolean, stopped: boolean, daemon: unknown, provider: { ok?: boolean, active?: boolean } | null }>}
 */
export async function stopOwnedPlatformService({
  state,
  inspectWorkspaceDaemon,
  ownsPlatformAutostart,
  stopPlatformService,
} = {}) {
  if (!state) throw new TypeError("service ownership check requires state");
  if (typeof inspectWorkspaceDaemon !== "function") throw new TypeError("service ownership check requires inspectWorkspaceDaemon");
  if (typeof ownsPlatformAutostart !== "function") throw new TypeError("service ownership check requires ownsPlatformAutostart");
  if (typeof stopPlatformService !== "function") throw new TypeError("service ownership check requires stopPlatformService");
  const daemon = inspectWorkspaceDaemon(state);
  if (!ownsPlatformAutostart(daemon)) {
    return { owned: false, stopped: false, daemon, provider: null };
  }
  const provider = await stopPlatformService();
  return { owned: true, stopped: provider?.ok === true && provider.active === false, daemon, provider };
}
/** @typedef {Record<string, unknown> & { alive?: boolean, verified_service_daemon?: boolean, mode?: string, startup_readiness_verified?: boolean, identity_reason?: string, pid?: number | null }} DaemonStatus */
/** @typedef {{ inspectDaemon?: () => DaemonStatus, attempts?: number, delayMs?: number, sleep?: (milliseconds: number) => Promise<void>, replacementPid?: number | null }} OwnedWaitOptions */

const DEFAULT_ATTEMPTS = 900;

const DEFAULT_DELAY_MS = 100;

/** @param {OwnedWaitOptions} [options] */
export async function waitForOwnedServiceDaemon(options = {}) {
  const { inspectDaemon, attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = options;
  if (typeof inspectDaemon !== "function") throw new TypeError("owned service convergence requires inspectDaemon");
  const maximum = boundedAttempts(attempts);
  const replacementPid = positivePid(options.replacementPid);
  let replacementPending = false;
  /** @type {DaemonStatus | null} */
  let daemon = null;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    daemon = inspectDaemon();
    if (readyOwnedDaemon(daemon)) {
      replacementPending = Boolean(replacementPid && Number(daemon.pid) === replacementPid);
      if (!replacementPending) return { ok: true, attempts: attempt, daemon, reason: null };
    }
    if (daemon?.alive === true && daemon.verified_service_daemon !== true) {
      return { ok: false, attempts: attempt, daemon,
        reason: `daemon_identity_${daemon.identity_reason || "unverified"}` };
    }
    if (attempt < maximum) await sleep(delayMs);
  }
  return { ok: false, attempts: maximum, daemon,
    reason: replacementPending ? "daemon_replacement_not_observed"
      : daemon?.alive ? "daemon_readiness_not_verified" : "daemon_not_running" };
}

/** @param {DaemonStatus | null | undefined} daemon */
export function readyOwnedDaemon(daemon) {
  return daemon?.alive === true
    && daemon.verified_service_daemon === true
    && daemon.mode === "service"
    && daemon.startup_readiness_verified === true;
}

/** @param {unknown} value */
function boundedAttempts(value) {
  const parsed = value === undefined ? DEFAULT_ATTEMPTS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1800) {
    throw new Error("owned service convergence attempts must be between 1 and 1800");
  }
  return parsed;
}

function positivePid(/** @type {unknown} */ value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }

function delay(/** @type {number} */ milliseconds) { return new Promise(resolve => { setTimeout(resolve, milliseconds); }); }
/** @param {{ definitionPresent?: boolean, disableCode?: unknown, status?: { state?: unknown, active?: unknown } }} options */
export function systemdRemovalDecision({ definitionPresent, disableCode, status }) {
  const state = String(status?.state || "unknown");
  const active = status?.active;
  if (active === true || ["activating", "deactivating", "reloading", "maintenance"].includes(state)) {
    return { removable: false, alreadyAbsent: false, reason: "service_active_or_transitioning" };
  }
  const safelyInactive = active === false && ["inactive", "failed"].includes(state);
  const safelyAbsent = definitionPresent !== true && active === false && state === "unknown";
  if (!safelyInactive && !safelyAbsent) {
    return { removable: false, alreadyAbsent: false, reason: "status_unavailable" };
  }
  if (definitionPresent === true && Number(disableCode) !== 0) {
    return { removable: false, alreadyAbsent: false, reason: "disable_failed" };
  }
  return {
    removable: true,
    alreadyAbsent: definitionPresent !== true,
    reason: definitionPresent === true ? "disabled" : "already_absent",
  };
}
