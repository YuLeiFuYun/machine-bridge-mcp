// @ts-check

export function runtimeActivityVisible(context = {}) {
  const authority = context?.authority;
  if (context?.origin === "relay" || authority?.principal?.kind === "account") return authority?.owner === true;
  return true;
}

export function hiddenGlobalActivity() {
  return { activity_hidden_by_authority: true };
}

export function hiddenInFlightActivity(snapshot = {}) {
  return {
    maximum: finiteNumber(snapshot.maximum),
    ordinary_capacity: finiteNumber(snapshot.ordinary_capacity),
    reserved_capacity: finiteNumber(snapshot.reserved_capacity),
    activity_hidden_by_authority: true,
  };
}

export function publicSecurityAudit(snapshot, activityVisible) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  if (activityVisible) return { ...snapshot };
  return {
    enabled: snapshot.enabled === true,
    healthy: snapshot.healthy === true,
    chain_verified: snapshot.chain_verified === true,
    persistence: typeof snapshot.persistence === "string" ? snapshot.persistence : null,
    worker_ready: snapshot.worker_ready === true,
    activity_hidden_by_authority: true,
  };
}

export function publicDeviceRootStatus(status, activityVisible) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  if (activityVisible) return { ...status };
  const { key_id: _keyId, ...publicStatus } = status;
  return {
    ...publicStatus,
    key_id_hidden_by_authority: true,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
