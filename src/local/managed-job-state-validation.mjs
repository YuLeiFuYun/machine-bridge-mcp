import { basename } from "node:path";
import { BridgeError } from "./errors.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";

export function isKnownManagedJobStatus(value) {
  return value === "staged" || ACTIVE_JOB_STATES.has(value) || isTerminalManagedJobStatus(value);
}

export function assertManagedJobDirectoryIdentity(dir, status) {
  if (status?.job_id !== basename(dir)) {
    throw new BridgeError("integrity_error", "managed job state does not match its directory");
  }
}

export function assertKnownManagedJobStatus(status) {
  if (!isKnownManagedJobStatus(status?.status)) {
    throw new BridgeError("integrity_error", "managed job status is invalid");
  }
}

export function managedJobTransitionConflict() {
  return new BridgeError("conflict", "job state is being modified by another process; retry after inspecting its current status", {
    retryable: true,
    details: { job_transition_pending: true },
  });
}
