import { join } from "node:path";
import { assertOwnedByContext } from "./authority-context.mjs";
import { BridgeError } from "./errors.mjs";
import { resolveManagedJobDirectory } from "./managed-job-directory.mjs";
import { managedJobDependencySucceeded } from "./managed-job-dependencies.mjs";
import { readRequiredJson } from "./managed-job-storage.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";

export function resolveManagedJobDependencies({ jobRoot, dependencyIds, currentJobId, context, reconcileStatus }) {
  const witnesses = [];
  let pending = 0;
  for (const jobId of dependencyIds || []) {
    if (jobId === currentJobId) {
      throw new BridgeError("invalid_request", "managed job cannot depend on itself", { retryable: false });
    }
    const dir = resolveManagedJobDirectory(jobRoot, jobId);
    reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "dependency job status");
    if (status.job_id !== jobId || (!ACTIVE_JOB_STATES.has(status.status)
      && status.status !== "staged" && !isTerminalManagedJobStatus(status.status))) {
      throw new BridgeError("integrity_error", "managed job dependency state is invalid");
    }
    assertOwnedByContext(status, context, "managed job dependency");
    if (status.status === "staged") {
      throw new BridgeError("invalid_request", "managed job dependency is staged and cannot become executable", {
        retryable: false, details: { dependency_job_id: jobId, dependency_status: status.status },
      });
    }
    if (isTerminalManagedJobStatus(status.status) && !managedJobDependencySucceeded(status)) {
      throw new BridgeError("conflict", "managed job dependency has already failed", {
        retryable: false,
        details: {
          reason: "dependency_failed",
          dependency_job_id: jobId,
          dependency_status: status.status,
          dependency_error_class: status.error_class ?? null,
        },
      });
    }
    if (!isTerminalManagedJobStatus(status.status)) pending += 1;
    witnesses.push({ job_id: jobId, plan_sha256: status.plan_sha256, created_at: status.created_at });
  }
  return { witnesses, pending };
}
