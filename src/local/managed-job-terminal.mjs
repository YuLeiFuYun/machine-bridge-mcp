export const ACTIVE_JOB_STATES = new Set(["queued", "running", "cleaning", "interrupted"]);
const TERMINAL_JOB_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
  "cancelled_cleanup_failed", "recovered", "recovery_failed", "runner_failed",
  "runner_launch_failed", "recovery_exhausted", "cancelled_before_start", "expired_before_start",
]);

export function managedJobFinalStatus({ recover, cancelled, mainError, cleanupError }) {
  if (recover) return mainError || cleanupError ? "recovery_failed" : "recovered";
  if (cancelled) return cleanupError ? "cancelled_cleanup_failed" : "cancelled";
  if (mainError) return cleanupError ? "failed_cleanup_failed" : "failed";
  return cleanupError ? "succeeded_cleanup_failed" : "succeeded";
}

export function isTerminalManagedJobStatus(value) {
  return TERMINAL_JOB_STATUSES.has(String(value || ""));
}

export function isTerminalManagedJobResult(value, expectedJobId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isTerminalManagedJobStatus(value.status)) return false;
  if (expectedJobId && value.job_id !== expectedJobId) return false;
  if (!Number.isFinite(Date.parse(String(value.finished_at || "")))) return false;
  if (!Array.isArray(value.steps) || !Array.isArray(value.finally_steps)) return false;
  return true;
}

export function terminalStatusFromResult(status, result, options = {}) {
  if (!isTerminalManagedJobResult(result, String(status?.job_id || ""))) {
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
