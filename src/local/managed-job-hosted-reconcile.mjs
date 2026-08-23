import { basename, join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { runnerProcessIsCurrentAsync } from "./managed-job-runner.mjs";
import { readJson } from "./managed-job-storage.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

export async function reconcileManagedJobStatusHosted(manager, dir) {
  manager.assertMaintenanceAvailable();
  const initial = readJson(join(dir, "status.json"), 256 * 1024);
  if (!initial) return;
  if (initial.job_id !== basename(dir)) {
    throw new BridgeError("integrity_error", "managed job state does not match its directory");
  }
  if (ACTIVE_JOB_STATES.has(initial.status) && await runnerProcessIsCurrentAsync(initial, dir)) return;
  manager.reconcileStatus(dir);
}
