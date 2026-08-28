import { basename, join } from "node:path";
import { acquireJobTransitionLock } from "./managed-job-lock.mjs";
import { atomicWriteJson, readRequiredJson } from "./managed-job-storage.mjs";
import { isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";

export function transientProcessRecoveryStatusFields(retentionClass, context = {}) {
  if (retentionClass !== "transient_process") return {};
  const relayOrigin = context?.origin === "relay" || context?.authority?.origin === "relay";
  return {
    retention_class: "transient_process",
    ...(relayOrigin ? { transient_recovery_pending: true } : {}),
  };
}

export function clearTransientProcessRecoveryPending(dir) {
  const transition = acquireJobTransitionLock(dir);
  if (!transition) return false;
  try {
    const statusFile = join(dir, "status.json");
    const status = readRequiredJson(statusFile, 256 * 1024, "job status");
    if (status.job_id !== basename(dir)) throw new Error("managed job directory identity is invalid");
    if (status.retention_class !== "transient_process" || status.transient_recovery_pending !== true
        || !isTerminalManagedJobStatus(status.status)) return false;
    delete status.transient_recovery_pending;
    atomicWriteJson(statusFile, status, 256 * 1024);
    return true;
  } finally {
    transition.release();
  }
}
