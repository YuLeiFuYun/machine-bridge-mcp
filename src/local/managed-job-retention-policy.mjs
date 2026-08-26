export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const STAGED_PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TRANSIENT_PROCESS_RECOVERY_GRACE_MS = 30 * 60 * 1000;
export const TRANSIENT_PROCESS_RECOVERY_SLOTS = 16;

export function terminalEvictionPriority(status, protectTransientRecovery = false) {
  if (status?.retention_class !== "transient_process") return 1;
  return protectTransientRecovery ? 2 : 0;
}

export function transientProcessWithinRecoveryGrace(status, fallbackMtime, now = Date.now()) {
  if (status?.retention_class !== "transient_process") return false;
  const terminalAt = terminalRetentionTime(status, fallbackMtime);
  const ageMs = now - terminalAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= TRANSIENT_PROCESS_RECOVERY_GRACE_MS;
}

export function transientProcessRecoveryIds(items, { now = Date.now(), incomingRetentionClass = "managed", reservedSlots = 0 } = {}) {
  const incomingSlots = incomingRetentionClass === "transient_process" ? Math.min(reservedSlots, TRANSIENT_PROCESS_RECOVERY_SLOTS) : 0;
  return new Set(items.filter(({ status, mtime }) => transientProcessWithinRecoveryGrace(status, mtime, now))
    .sort((a, b) => terminalRetentionTime(b.status, b.mtime) - terminalRetentionTime(a.status, a.mtime))
    .slice(0, Math.max(0, TRANSIENT_PROCESS_RECOVERY_SLOTS - incomingSlots))
    .map(({ status }) => status.job_id));
}

export function orderManagedJobTerminalEviction(items, options = {}) {
  const protectedIds = transientProcessRecoveryIds(items, options);
  return items.sort((a, b) => terminalEvictionPriority(a.status, protectedIds.has(a.status.job_id))
    - terminalEvictionPriority(b.status, protectedIds.has(b.status.job_id))
    || terminalRetentionTime(a.status, a.mtime) - terminalRetentionTime(b.status, b.mtime));
}

export function stagedPlanExpired(status, fallbackMtime) {
  const createdAt = Date.parse(String(status?.created_at || ""));
  const baseline = Number.isFinite(createdAt) ? createdAt : fallbackMtime;
  return Number.isFinite(baseline) && Date.now() - baseline > STAGED_PLAN_RETENTION_MS;
}

export function terminalRetentionTime(status, fallbackMtime) {
  const finishedAt = Date.parse(String(status?.finished_at || ""));
  return Number.isFinite(finishedAt) ? finishedAt : fallbackMtime;
}
