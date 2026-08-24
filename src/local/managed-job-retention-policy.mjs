export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const STAGED_PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;

export function terminalEvictionPriority(status) {
  return status?.retention_class === "transient_process" ? 0 : 1;
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
