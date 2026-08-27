// @ts-check

import { join } from "node:path";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { managedJobDependencyCount, managedJobDependencyLabel } from "./managed-job-dependency-metadata.mjs";
import { resolveManagedJobDirectory } from "./managed-job-directory.mjs";
import { readJson, readRequiredJson, resourceErrorClass } from "./managed-job-storage.mjs";
import {
  ACTIVE_JOB_STATES, isTerminalManagedJobResult, isTerminalManagedJobStatus, terminalStatusFromResult,
} from "./managed-job-terminal.mjs";

const DEPENDENCY_POLL_INTERVAL_MS = 1000;
const MAX_DEPENDENCY_WAIT_MS = 14 * 24 * 60 * 60 * 1000;
export const DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS = 45_000;
const RETRYABLE_DEPENDENCY_READ_ERROR_CLASSES = new Set(["identity_changed", "permission_denied", "resource_unavailable"]);

export class ManagedJobDependencyError extends Error {
  constructor(errorClass, message, details = {}) {
    super(message);
    this.name = "ManagedJobDependencyError";
    this.errorClass = errorClass;
    this.details = details;
  }
}

export function managedJobRunnerDependencyState(plan, initial, recover) {
  const dependencyIds = Array.isArray(plan?.depends_on) ? plan.depends_on : [];
  const waiting = recover !== true && dependencyIds.length > 0;
  const initialPending = managedJobDependencyCount(initial?.dependency_pending_count, dependencyIds.length, dependencyIds.length);
  return {
    dependencyIds,
    waiting,
    status: recover ? "cleaning" : waiting ? "queued" : "running",
    currentPhase: recover ? "recovery-cleanup" : waiting ? "dependency_wait" : "steps",
    total: dependencyIds.length,
    pending: waiting ? initialPending : 0,
  };
}

export async function waitForManagedJobDependencies({
  jobRoot,
  dependencyIds = [],
  witnesses = [],
  throwIfCancelled = () => {},
  onProgress = () => {},
  readStatus = (jobId) => readManagedJobDependencyStatus(jobRoot, jobId),
  sleep = defaultSleep,
  now = undefined,
}) {
  if (!dependencyIds.length) return { total: 0, pending: 0, completed: 0 };
  const witnessById = new Map();
  for (const witness of witnesses) {
    const jobId = String(witness?.job_id || "");
    if (!jobId || witnessById.has(jobId)) {
      throw new ManagedJobDependencyError("dependency_state_invalid", "managed job dependency witness set is invalid");
    }
    witnessById.set(jobId, witness);
  }
  if (witnessById.size !== dependencyIds.length || dependencyIds.some((jobId) => !witnessById.has(jobId))) {
    throw new ManagedJobDependencyError("dependency_state_invalid", "managed job dependency witness set does not match the plan");
  }

  const deadline = createMonotonicDeadline(MAX_DEPENDENCY_WAIT_MS, now);
  const unavailableSinceById = new Map();
  let previousPending = -1;
  while (!deadline.expired()) {
    throwIfCancelled();
    let pending = 0;
    for (const jobId of dependencyIds) {
      const witness = witnessById.get(jobId);
      let status;
      try {
        status = await readStatus(jobId);
      } catch (error) {
        const errorClass = resourceErrorClass(error);
        const elapsedMs = deadline.elapsedMs();
        const unavailableSinceMs = unavailableSinceById.get(jobId) ?? elapsedMs;
        if (RETRYABLE_DEPENDENCY_READ_ERROR_CLASSES.has(errorClass)
          && elapsedMs - unavailableSinceMs < DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS) {
          unavailableSinceById.set(jobId, unavailableSinceMs);
          pending += 1;
          continue;
        }
        throw new ManagedJobDependencyError("dependency_unavailable", "managed job dependency state is no longer available", {
          dependency_job_id: jobId,
          cause_class: managedJobDependencyLabel(errorClass),
        });
      }
      unavailableSinceById.delete(jobId);
      assertDependencyWitness(status, witness, jobId);
      if (managedJobDependencySucceeded(status)) continue;
      if (isTerminalManagedJobStatus(status?.status)) {
        throw new ManagedJobDependencyError("dependency_failed", "managed job dependency finished unsuccessfully", {
          dependency_job_id: jobId,
          dependency_status: status.status,
          dependency_error_class: status.error_class == null ? null : managedJobDependencyLabel(status.error_class),
        });
      }
      if (status?.status === "staged" || !ACTIVE_JOB_STATES.has(String(status?.status || ""))) {
        throw new ManagedJobDependencyError("dependency_state_invalid", "managed job dependency entered a non-executable state", {
          dependency_job_id: jobId,
          dependency_status: status?.status == null ? null : managedJobDependencyLabel(status.status),
        });
      }
      pending += 1;
    }
    const progress = { total: dependencyIds.length, pending, completed: dependencyIds.length - pending };
    if (pending !== previousPending) {
      onProgress(progress);
      previousPending = pending;
    }
    if (pending === 0) return progress;
    await sleep(Math.min(DEPENDENCY_POLL_INTERVAL_MS, Math.max(1, deadline.remainingMs())));
  }
  throw new ManagedJobDependencyError("dependency_timeout", "managed job dependency wait exceeded the bounded recovery window", {
    dependency_count: dependencyIds.length,
  });
}

export async function waitForManagedJobDependencyGate({
  jobRoot, dependencyIds, witnesses, waiting = true, throwIfCancelled, updateStatus,
}) {
  if (!waiting) return;
  await waitForManagedJobDependencies({
    jobRoot,
    dependencyIds,
    witnesses,
    throwIfCancelled,
    onProgress: ({ pending }) => updateStatus({
      status: "queued",
      current_phase: "dependency_wait",
      current_step: null,
      dependency_pending_count: pending,
    }),
  });
  updateStatus({
    status: "running",
    current_phase: "steps",
    current_step: null,
    dependency_pending_count: 0,
  });
}

export function dependencyFailureDetails(error) {
  if (!(error instanceof ManagedJobDependencyError)) return null;
  return {
    error_class: error.errorClass,
    ...error.details,
  };
}

export function readManagedJobDependencyStatus(jobRoot, jobId) {
  const dir = resolveManagedJobDirectory(jobRoot, jobId);
  const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "dependency job status");
  if (isTerminalManagedJobStatus(status?.status)) return status;
  const result = readJson(join(dir, "result.json"), 4 * 1024 * 1024, "dependency job result");
  if (!result) return status;
  if (!isTerminalManagedJobResult(result, jobId)) {
    throw new Error("managed job dependency terminal result is invalid");
  }
  return terminalStatusFromResult(status, result, { resultPersisted: true, updatedAt: result.finished_at });
}

function assertDependencyWitness(status, witness, jobId) {
  if (!status || status.job_id !== jobId
    || status.plan_sha256 !== witness?.plan_sha256
    || status.created_at !== witness?.created_at) {
    throw new ManagedJobDependencyError("dependency_changed", "managed job dependency identity changed after acceptance", {
      dependency_job_id: jobId,
    });
  }
}

export function managedJobDependencySucceeded(status) {
  return String(status?.status || "") === "succeeded" && status?.result_persisted !== false;
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
