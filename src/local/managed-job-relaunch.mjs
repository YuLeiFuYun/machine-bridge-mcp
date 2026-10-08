import { join } from "node:path";
import { removePathSync } from "./atomic-fs.mjs";
import { assertManagedJobPlanIntegrity } from "./managed-job-plan-integrity.mjs";
import { launchRunner } from "./managed-job-runner.mjs";
import { appendManagedJobRecovery } from "./managed-job-recovery-history.mjs";
import { atomicWriteJson, readRequiredJson } from "./managed-job-storage.mjs";

const MAX_PLAN_BYTES = 1024 * 1024;

export function relaunchInterruptedManagedJob({
  dir, statusFile, status, recoveryToken, logger, runnerEnvironmentOverrides, runnerSpawnProcess, onRunnerExit,
}) {
  const plan = readVerifiedPlan(dir, status);
  clearRunnerRuntime(dir);
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
  clearRunnerRuntime(dir);
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

function clearRunnerRuntime(dir) {
  removePathSync(join(dir, "runtime"), { recursive: true, force: true });
  removePathSync(join(dir, "runner.pid"), { force: true });
}

function runnerLaunchOptions(plan, logger, overrides, onExit, spawnProcess) {
  return { logger, fullEnv: plan.full_env === true, env: { ...process.env, ...overrides }, onExit, ...(spawnProcess ? { spawnProcess } : {}) };
}
