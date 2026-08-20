import { inspectProcessInstance, processStartTimeFromSnapshot } from "./process-identity.mjs";

export function resourceLeaseOwnerStatus(lease, processStarts = null) {
  return resourceLeaseOwnerStatusFromStart(lease, processStartTimeFromSnapshot(processStarts, lease.owner.pid));
}

export function resourceLeaseOwnerStatusFromStart(lease, observedStart = null) {
  return inspectProcessInstance({
    pid: lease.owner.pid,
    startedAt: lease.acquired_at,
    processStartedAt: lease.owner.process_started_at,
  }, { getProcessStartTime: () => observedStart });
}

export function resourceLeaseIsStale(lease, processStarts, now, provisionalTtlMs) {
  const owner = lease.owner;
  const status = resourceLeaseOwnerStatus(lease, processStarts);
  if (owner.kind === "process" && status.reason === "pid_reused") return true;
  if (owner.kind === "process" && owner.process_group_isolated === true && resourceProcessGroupAlive(owner.process_group_id)) return false;
  if (owner.kind === "provisional" && now - Date.parse(lease.acquired_at) > provisionalTtlMs) return true;
  return status.reclaimable === true;
}

export function resourceProcessGroupAlive(value) {
  const pgid = Number(value);
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
