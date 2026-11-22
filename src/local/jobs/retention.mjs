import { join, basename } from "node:path";
import { visibleToContext } from "../core/authority.mjs";
import { publicStatus, assertManagedJobPlanIntegrity } from "./projection.mjs";
import { acquireJobTransitionLock, atomicWriteJson, cleanupIsolatedWorktreeDir, inspectManagedJobDirectoryGeneration, MANAGED_JOB_ID, pruneRetiredManagedJobDirectories, readJson, readRequiredJson, removeManagedJobDirectoryIfCurrent, resourceErrorClass, safeReadDir } from "./directory.mjs";
import { stagedPlanExpired, ACTIVE_JOB_STATES, isTerminalManagedJobStatus, JOB_RETENTION_MS, orderManagedJobTerminalEviction, terminalRetentionTime, transientProcessUndeliveredRecoveryProtected, persistManagedJobTerminal } from "./terminal-base.mjs";
import { removePathSync } from "../core/exclusive-file.mjs";
import { launchRunner, runnerProcessIsCurrent } from "./runner-lifecycle.mjs";
import { appendManagedJobRecovery } from "./redaction.mjs";
import { rmSync } from "node:fs";
import { managedJobDependencyProtection } from "./execution.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS, scrubTerminalJobArtifacts } from "./capacity.mjs";

export function readManagedJobListingRecords({ jobRoot, context, logger, reconcileStatus, assertKnownStatus }) {
  const records = [];
  let maintenanceRequired = false;
  for (const entry of safeReadDir(jobRoot)) {
    if (!MANAGED_JOB_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      logger.warn?.("managed job entry has the wrong type; retaining it for inspection", { error_class: "integrity_error" });
      if (context?.authority?.owner !== false) records.push({ job: { job_id: entry.name, name: "unavailable", status: "unreadable", error_class: "integrity_error" }, retentionClass: "", recoveryPending: false });
      continue;
    }
    const dir = join(jobRoot, entry.name);
    try {
      reconcileStatus(dir);
      const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
      if (!status) {
        maintenanceRequired = true;
        continue;
      }
      if ((status.status === "staged" || ACTIVE_JOB_STATES.has(status.status))
          && Number.isSafeInteger(status.dependency_total) && status.dependency_total > 0) maintenanceRequired = true;
      if (status.status === "staged" && stagedPlanExpired(status, 0)) maintenanceRequired = true;
      if (!visibleToContext(status, context)) continue;
      assertKnownStatus(dir, status);
      records.push({
        job: publicStatus(status),
        retentionClass: String(status.retention_class || ""),
        recoveryPending: status.transient_recovery_pending === true,
      });
    } catch (error) {
      maintenanceRequired = true;
      const errorClass = resourceErrorClass(error);
      logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: errorClass });
      if (context?.authority?.owner !== false) records.push({ job: { job_id: entry.name, name: "unavailable", status: "unreadable", error_class: errorClass }, retentionClass: "", recoveryPending: false });
    }
  }
  return { records, maintenanceRequired };
}
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
const MAX_PLAN_BYTES = 1024 * 1024;

export function relaunchInterruptedManagedJob({
  dir, statusFile, status, recoveryToken, logger, runnerEnvironmentOverrides, runnerSpawnProcess, onRunnerExit,
}) {
  const plan = readVerifiedPlan(dir, status);
  clearRunnerRuntime(dir, { preserveWorktree: plan.isolated_worktree === true, workspace: plan.workspace || "" });
  const recoveredAt = appendManagedJobRecovery(status, "runner_interrupted");
  status.status = "interrupted";
  status.updated_at = recoveredAt;
  status.finished_at = recoveredAt;
  status.error_class = "runner_interrupted";
  atomicWriteJson(statusFile, status, 256 * 1024);
  return launchRunner(dir, true, recoveryToken, runnerLaunchOptions(plan, logger, runnerEnvironmentOverrides, onRunnerExit, runnerSpawnProcess));
}

export function relaunchDependencyWaitManagedJob({
  dir, statusFile, status, logger, runnerEnvironmentOverrides, runnerSpawnProcess, onRunnerExit,
}) {
  const plan = readVerifiedPlan(dir, status);
  clearRunnerRuntime(dir, { preserveWorktree: false, workspace: plan.workspace || "" });
  const recoveredAt = appendManagedJobRecovery(status, "dependency_wait_runner_interrupted");
  status.status = "queued";
  status.current_phase = "dependency_wait";
  status.updated_at = recoveredAt;
  status.error_class = null;
  status.runner_pid = null;
  status.runner_process_started_at = null;
  atomicWriteJson(statusFile, status, 256 * 1024);
  return launchRunner(dir, false, "", runnerLaunchOptions(plan, logger, runnerEnvironmentOverrides, onRunnerExit, runnerSpawnProcess));
}

function readVerifiedPlan(dir, status) {
  const plan = readRequiredJson(join(dir, "plan.json"), MAX_PLAN_BYTES, "job plan");
  assertManagedJobPlanIntegrity(plan, status);
  return plan;
}

function clearRunnerRuntime(dir, { preserveWorktree = false, workspace = "" } = {}) {
  const runtimeDir = join(dir, "runtime");
  if (preserveWorktree) {
    try {
      for (const entry of safeReadDir(runtimeDir)) {
        if (entry.name === "worktree") continue;
        removePathSync(join(runtimeDir, entry.name), { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } else {
    cleanupIsolatedWorktreeDir(join(runtimeDir, "worktree"), workspace, runtimeDir);
    removePathSync(runtimeDir, { recursive: true, force: true });
  }
  removePathSync(join(dir, "runner.pid"), { force: true });
}

function runnerLaunchOptions(plan, logger, overrides, onExit, spawnProcess) {
  return { logger, fullEnv: plan.full_env === true, env: { ...process.env, ...overrides }, onExit, ...(spawnProcess ? { spawnProcess } : {}) };
}
export const PLAN_RETAINING_STATES = new Set(["staged", ...ACTIVE_JOB_STATES]);

export function pruneManagedJobs({ jobRoot, logger = console, reserveSlots = 0, protectedJobIds = new Set(), incomingRetentionClass }) {
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
    .filter(({ status, mtime }) => status && isTerminalManagedJobStatus(status.status)
      && !dependencyProtection.ids.has(status.job_id)
      && !transientProcessUndeliveredRecoveryProtected(status, mtime, now));
  orderManagedJobTerminalEviction(removable, { now, incomingRetentionClass, reservedSlots: reserved });
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
