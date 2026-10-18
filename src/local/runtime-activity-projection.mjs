// @ts-check

/** @typedef {{origin?: unknown, authority?: {owner?: unknown, principal?: {kind?: unknown} | null} | null}} ActivityContext */

/** @param {ActivityContext} [context] */
export function runtimeActivityVisible(context = {}) {
  const authority = context?.authority;
  if (context?.origin === "relay" || authority?.principal?.kind === "account") return authority?.owner === true;
  return true;
}

export function hiddenGlobalActivity() {
  return { activity_hidden_by_authority: true };
}

/** @param {Record<string, unknown>} [snapshot] */
export function hiddenInFlightActivity(snapshot = {}) {
  return {
    maximum: finiteNumber(snapshot.maximum),
    ordinary_capacity: finiteNumber(snapshot.ordinary_capacity),
    reserved_capacity: finiteNumber(snapshot.reserved_capacity),
    activity_hidden_by_authority: true,
  };
}

/** @param {unknown} snapshot @param {boolean} activityVisible */
export function publicSecurityAudit(snapshot, activityVisible) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  if (activityVisible) return { ...snapshot };
  const audit = /** @type {Record<string, unknown>} */ (snapshot);
  return {
    enabled: audit.enabled === true,
    healthy: audit.healthy === true,
    chain_verified: audit.chain_verified === true,
    persistence: typeof audit.persistence === "string" ? audit.persistence : null,
    worker_ready: audit.worker_ready === true,
    activity_hidden_by_authority: true,
  };
}

/** @param {unknown} status @param {boolean} activityVisible */
export function publicDeviceRootStatus(status, activityVisible) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  if (activityVisible) return { ...status };
  const { key_id: _keyId, ...publicStatus } = /** @type {Record<string, unknown>} */ (status);
  return {
    ...publicStatus,
    key_id_hidden_by_authority: true,
  };
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
