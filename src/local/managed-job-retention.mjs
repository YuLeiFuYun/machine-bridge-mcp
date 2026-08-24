import { rmSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { managedJobDependencyProtection } from "./managed-job-dependency-retention.mjs";
import { inspectManagedJobDirectoryGeneration, pruneRetiredManagedJobDirectories, removeManagedJobDirectoryIfCurrent } from "./managed-job-directory-generation.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS } from "./managed-job-capacity.mjs";
import { runnerProcessIsCurrent } from "./managed-job-runner.mjs";
import { acquireJobTransitionLock } from "./managed-job-lock.mjs";
import { JOB_RETENTION_MS, stagedPlanExpired, terminalEvictionPriority, terminalRetentionTime } from "./managed-job-retention-policy.mjs";
import { atomicWriteJson, readJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus, persistManagedJobTerminal } from "./managed-job-terminal.mjs";
import { scrubTerminalJobArtifacts } from "./managed-job-terminal-maintenance.mjs";
export const PLAN_RETAINING_STATES = new Set(["staged", ...ACTIVE_JOB_STATES]);
export function pruneManagedJobs({ jobRoot, logger = console, reserveSlots = 0, protectedJobIds = new Set() }) {
  const reserved = Math.max(0, Math.min(MAX_JOBS, Math.floor(Number(reserveSlots) || 0)));
  const targetMaximum = MAX_JOBS - reserved;
  pruneRetiredManagedJobDirectories(jobRoot, logger);
  const entries = [];
  for (const entry of safeReadDir(jobRoot)) {
    if (!MANAGED_JOB_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) { logger.warn?.("managed job pruning retained wrong-type job state", { error_class: "integrity_error" }); continue; }
    const dir = join(jobRoot, entry.name);
    let status;
    let mtime;
    let generation;
    try {
      status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
      const observed = inspectManagedJobDirectoryGeneration(dir);
      mtime = observed.mtimeMs;
      generation = observed.identity;
    } catch (error) {
      logger.warn?.("managed job pruning skipped unreadable state; retaining it for inspection", { error_class: resourceErrorClass(error) });
      continue;
    }
    if (!status) {
      const fallbackOwner = { startedAt: new Date(mtime).toISOString() };
      let runnerAlive;
      try { runnerAlive = runnerProcessIsCurrent(fallbackOwner, dir, { ownerOnly: true }); }
      catch (error) {
        logger.warn?.("managed job pruning skipped unreadable runner ownership; retaining it for inspection", { error_class: resourceErrorClass(error) });
        entries.push({ dir, status, mtime });
        continue;
      }
      if (!runnerAlive && Date.now() - mtime > 60_000) {
        removeManagedJobDirectoryIfCurrent(dir, generation);
        continue;
      }
    }
    if (status && status.job_id !== entry.name) {
      logger.warn?.("managed job pruning skipped mismatched directory identity; retaining it for inspection", { error_class: "integrity_error" });
      entries.push({ dir, status: null, mtime });
      continue;
    }
    if (status?.status === "staged" && stagedPlanExpired(status, mtime)) {
      const transition = acquireJobTransitionLock(dir);
      if (!transition) {
        entries.push({ dir, status, mtime });
        continue;
      }
      try {
        try { status = readJson(join(dir, "status.json"), 256 * 1024, "job status"); }
        catch (error) {
          logger.warn?.("managed job pruning skipped unreadable staged state; retaining it for inspection", { error_class: resourceErrorClass(error) });
          entries.push({ dir, status, mtime });
          continue;
        }
        if (status?.status === "staged" && stagedPlanExpired(status, mtime)) status = expireStagedJob(dir, status);
      } finally {
        transition.release();
      }
    }
    if (status && !PLAN_RETAINING_STATES.has(status.status) && !isTerminalManagedJobStatus(status.status)) {
      logger.warn?.("managed job pruning skipped invalid status; retaining it for inspection", { error_class: "integrity_error" }); entries.push({ dir, status, mtime }); continue;
    }
    if (status && isTerminalManagedJobStatus(status.status)) {
      try {
        scrubTerminalJobArtifacts(dir, status);
        generation = inspectManagedJobDirectoryGeneration(dir).identity;
      } catch (error) {
        logger.warn?.("managed job pruning retained inconsistent terminal state", { error_class: error?.code === "integrity_error" ? "integrity_error" : resourceErrorClass(error) });
        entries.push({ dir, status: null, mtime }); continue;
      }
    }
    entries.push({ dir, status, mtime, generation });
  }
  const dependencyProtection = managedJobDependencyProtection(entries, logger, protectedJobIds);
  if (!dependencyProtection.complete) return;
  const finished = entries
    .filter(({ status }) => status && isTerminalManagedJobStatus(status.status))
    .sort((a, b) => terminalRetentionTime(b.status, b.mtime) - terminalRetentionTime(a.status, a.mtime));
  const now = Date.now();
  for (const item of finished) {
    if (!dependencyProtection.ids.has(item.status.job_id)
      && now - terminalRetentionTime(item.status, item.mtime) > JOB_RETENTION_MS) {
      removeManagedJobDirectoryIfCurrent(item.dir, item.generation);
    }
  }
  const retainedCount = () => managedJobCapacitySnapshot(jobRoot).retained_state;
  if (retainedCount() <= targetMaximum) return;
  const removable = entries
    .filter(({ status }) => status && isTerminalManagedJobStatus(status.status) && !dependencyProtection.ids.has(status.job_id))
    .sort((a, b) => terminalEvictionPriority(a.status) - terminalEvictionPriority(b.status) || terminalRetentionTime(a.status, a.mtime) - terminalRetentionTime(b.status, b.mtime));
  for (const item of removable) {
    if (retainedCount() <= targetMaximum) break;
    removeManagedJobDirectoryIfCurrent(item.dir, item.generation);
  }
}
function expireStagedJob(dir, status) {
  const finishedAt = new Date().toISOString();
  const result = {
    job_id: status.job_id, name: status.name, status: "expired_before_start",
    steps: [], finally_steps: [], error_class: "expired", cleanup_error_class: null, finished_at: finishedAt,
  };
  const terminal = persistManagedJobTerminal({
    statusFile: join(dir, "status.json"), resultFile: join(dir, "result.json"),
    artifacts: [join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel")],
    status: { ...status, cleanup_guarantee: "not-started" }, result,
    writeJson: atomicWriteJson, removeFile: (file) => rmSync(file, { recursive: true, force: true }),
    maxStatusBytes: 256 * 1024, maxResultBytes: 4 * 1024 * 1024, classifyPersistenceError: resourceErrorClass,
  });
  if (!terminal.statusPersisted) throw new Error(`managed job staged expiry status persistence failed: ${terminal.statusErrorClass}`);
  return terminal.status;
}
