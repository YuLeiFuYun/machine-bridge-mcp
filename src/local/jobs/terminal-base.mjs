import { MCP_TASK_ACTIVE_JOB_STATUSES, MCP_TASK_TERMINAL_JOB_STATUSES } from "../../shared/mcp-task-contract.mjs";

export const ACTIVE_JOB_STATES = MCP_TASK_ACTIVE_JOB_STATUSES;

const TERMINAL_JOB_STATUSES = MCP_TASK_TERMINAL_JOB_STATUSES;

export function managedJobFinalStatus({ recover, cancelled, mainError, cleanupError }) {
  if (recover) return mainError || cleanupError ? "recovery_failed" : "recovered";
  if (cancelled) return cleanupError ? "cancelled_cleanup_failed" : "cancelled";
  if (mainError) return cleanupError ? "failed_cleanup_failed" : "failed";
  return cleanupError ? "succeeded_cleanup_failed" : "succeeded";
}

export function isTerminalManagedJobStatus(value) {
  return typeof value === "string" && TERMINAL_JOB_STATUSES.has(value);
}

export function isTerminalManagedJobResult(value, expectedJobId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isTerminalManagedJobStatus(value.status)) return false;
  if (expectedJobId && value.job_id !== expectedJobId) return false;
  if (typeof value.finished_at !== "string" || !Number.isFinite(Date.parse(value.finished_at))) return false;
  if (!Array.isArray(value.steps) || !Array.isArray(value.finally_steps)) return false;
  return true;
}

export function terminalStatusFromResult(status, result, options = {}) {
  if (typeof status?.job_id !== "string" || !isTerminalManagedJobResult(result, status.job_id)) {
    throw new Error("managed job terminal result is invalid or belongs to another job");
  }
  const resultPersisted = options.resultPersisted !== false;
  return {
    ...status,
    status: result.status,
    current_phase: null,
    current_step: null,
    ...(Object.hasOwn(status || {}, "dependency_pending_count") ? { dependency_pending_count: 0 } : {}),
    finished_at: result.finished_at,
    updated_at: options.updatedAt || result.finished_at,
    error_class: result.error_class || result.cleanup_error_class || null,
    cleanup_error_class: result.cleanup_error_class || null,
    result_persisted: resultPersisted,
    terminal_record_error_class: resultPersisted ? null : boundedErrorClass(options.terminalRecordErrorClass),
    artifact_cleanup_pending: true,
    artifact_cleanup_error_class: null,
  };
}

export function persistManagedJobTerminal({
  statusFile,
  resultFile,
  artifacts = [],
  status,
  result,
  writeJson,
  removeFile,
  maxStatusBytes,
  maxResultBytes,
  classifyPersistenceError = defaultErrorClass,
}) {
  if (typeof writeJson !== "function" || typeof removeFile !== "function") {
    throw new TypeError("managed job terminal persistence requires write and remove functions");
  }
  let resultError = null;
  try {
    writeJson(resultFile, result, maxResultBytes);
  } catch (error) {
    resultError = error;
  }

  const terminalStatus = terminalStatusFromResult(status, result, {
    resultPersisted: !resultError,
    terminalRecordErrorClass: resultError ? classifyPersistenceError(resultError) : null,
    updatedAt: result.finished_at,
  });
  let statusError = null;
  try {
    writeJson(statusFile, terminalStatus, maxStatusBytes);
  } catch (error) {
    statusError = error;
  }
  if (statusError) {
    return {
      resultPersisted: !resultError,
      statusPersisted: false,
      artifactsScrubbed: false,
      resultErrorClass: resultError ? classifyPersistenceError(resultError) : null,
      statusErrorClass: classifyPersistenceError(statusError),
      cleanupErrorClass: null,
      status: terminalStatus,
    };
  }

  const cleanupFailures = [];
  for (const artifact of artifacts) {
    try {
      removeFile(artifact);
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupFailures.push(error);
    }
  }
  const cleanupErrorClass = cleanupFailures.length ? classifyPersistenceError(cleanupFailures[0]) : null;
  const finalStatus = {
    ...terminalStatus,
    artifact_cleanup_pending: cleanupFailures.length > 0,
    artifact_cleanup_error_class: cleanupErrorClass,
  };
  let finalStatusError = null;
  try {
    writeJson(statusFile, finalStatus, maxStatusBytes);
  } catch (error) {
    finalStatusError = error;
  }
  return {
    resultPersisted: !resultError,
    statusPersisted: true,
    artifactsScrubbed: cleanupFailures.length === 0,
    resultErrorClass: resultError ? classifyPersistenceError(resultError) : null,
    statusErrorClass: finalStatusError ? classifyPersistenceError(finalStatusError) : null,
    cleanupErrorClass,
    status: finalStatusError ? terminalStatus : finalStatus,
  };
}

export function scrubManagedJobArtifacts(artifacts, removeFile, classifyPersistenceError = defaultErrorClass) {
  const failures = [];
  for (const artifact of artifacts) {
    try {
      removeFile(artifact);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(error);
    }
  }
  return {
    scrubbed: failures.length === 0,
    errorClass: failures.length ? classifyPersistenceError(failures[0]) : null,
    failureCount: failures.length,
  };
}

function defaultErrorClass(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["ENOSPC", "EDQUOT", "EFBIG"].includes(code)) return "storage_limit";
  if (["EACCES", "EPERM", "EROFS"].includes(code)) return "permission_denied";
  if (["ENOENT", "ENOTDIR"].includes(code)) return "not_found";
  return "persistence_failed";
}

function boundedErrorClass(value) {
  return String(value || "persistence_failed").toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 80) || "persistence_failed";
}
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const STAGED_PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;

export const TRANSIENT_PROCESS_RECOVERY_GRACE_MS = 30 * 60 * 1000;

export const TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS = 24 * 60 * 60 * 1000;

export const TRANSIENT_PROCESS_RECOVERY_SLOTS = 16;

export function terminalEvictionPriority(status, protectTransientRecovery = false) {
  if (status?.retention_class !== "transient_process") return 1;
  return protectTransientRecovery ? 2 : 0;
}

export function transientProcessWithinRecoveryGrace(status, fallbackMtime, now = Date.now()) {
  if (status?.retention_class !== "transient_process") return false;
  const terminalAt = terminalRetentionTime(status, fallbackMtime);
  const ageMs = now - terminalAt;
  const graceMs = status?.transient_recovery_pending === true
    ? TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS
    : TRANSIENT_PROCESS_RECOVERY_GRACE_MS;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= graceMs;
}

export function transientProcessUndeliveredRecoveryProtected(status, fallbackMtime, now = Date.now()) {
  return status?.transient_recovery_pending === true
    && transientProcessWithinRecoveryGrace(status, fallbackMtime, now);
}

export function transientProcessRecoveryIds(items, { now = Date.now(), incomingRetentionClass = "managed", reservedSlots = 0 } = {}) {
  const incomingSlots = incomingRetentionClass === "transient_process" ? Math.min(reservedSlots, TRANSIENT_PROCESS_RECOVERY_SLOTS) : 0;
  const recent = items.filter(({ status, mtime }) => transientProcessWithinRecoveryGrace(status, mtime, now));
  const followupRequired = recent.filter(({ status, mtime }) => transientProcessUndeliveredRecoveryProtected(status, mtime, now));
  const deliveryReserve = recent.filter(({ status }) => status?.transient_recovery_pending !== true)
    .sort((a, b) => terminalRetentionTime(b.status, b.mtime) - terminalRetentionTime(a.status, a.mtime))
    .slice(0, Math.max(0, TRANSIENT_PROCESS_RECOVERY_SLOTS - incomingSlots))
    .map(({ status }) => status.job_id);
  return new Set([...followupRequired.map(({ status }) => status.job_id), ...deliveryReserve]);
}

export function orderManagedJobTerminalEviction(items, options = {}) {
  const protectedIds = transientProcessRecoveryIds(items, options);
  return items.sort((a, b) => terminalEvictionPriority(a.status, protectedIds.has(a.status.job_id))
    - terminalEvictionPriority(b.status, protectedIds.has(b.status.job_id))
    || terminalRetentionTime(a.status, a.mtime) - terminalRetentionTime(b.status, b.mtime));
}

export function stagedPlanExpired(status, _fallbackMtime) {
  if (typeof status?.created_at !== "string") return false;
  const createdAt = Date.parse(status.created_at);
  return Number.isFinite(createdAt) && Date.now() - createdAt > STAGED_PLAN_RETENTION_MS;
}

export function terminalRetentionTime(status, fallbackMtime) {
  const finishedAt = typeof status?.finished_at === "string" ? Date.parse(status.finished_at) : NaN;
  return Number.isFinite(finishedAt) ? finishedAt : fallbackMtime;
}
