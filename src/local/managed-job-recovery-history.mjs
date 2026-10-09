import { BridgeError } from "./errors.mjs";

export const MAX_MANAGED_JOB_RECOVERY_ATTEMPTS = 3;
const RECOVERY_REASONS = new Set(["runner_interrupted", "dependency_wait_runner_interrupted"]);

export function managedJobRecoveryAttempts(status) {
  const value = status?.recovery_attempts;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MANAGED_JOB_RECOVERY_ATTEMPTS) throw recoveryIntegrityError();
  return value;
}

export function managedJobRecoveryHistory(status) {
  const attempts = managedJobRecoveryAttempts(status);
  const value = status?.recovery_history;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > attempts || (attempts > 0 && value.length === 0)) throw recoveryIntegrityError();
  const firstAttempt = attempts - value.length + 1;
  const history = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join(",") !== "at,attempt,reason"
        || entry.attempt !== firstAttempt + index
        || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))
        || typeof entry.reason !== "string" || !RECOVERY_REASONS.has(entry.reason)) throw recoveryIntegrityError();
    return { attempt: entry.attempt, at: entry.at, reason: entry.reason };
  });
  return history;
}

export function managedJobRecoveryHistoryComplete(status) {
  const attempts = managedJobRecoveryAttempts(status);
  return managedJobRecoveryHistory(status).length === attempts;
}

export function appendManagedJobRecovery(status, reason) {
  if (!RECOVERY_REASONS.has(reason)) throw recoveryIntegrityError();
  const attempts = managedJobRecoveryAttempts(status);
  if (attempts >= MAX_MANAGED_JOB_RECOVERY_ATTEMPTS) throw recoveryIntegrityError();
  const history = managedJobRecoveryHistory(status);
  const attempt = attempts + 1;
  const at = new Date().toISOString();
  status.recovery_attempts = attempt;
  status.recovery_history = [...history, { attempt, at, reason }].slice(-MAX_MANAGED_JOB_RECOVERY_ATTEMPTS);
  return at;
}

function recoveryIntegrityError() {
  return new BridgeError("integrity_error", "managed job recovery metadata is invalid");
}
