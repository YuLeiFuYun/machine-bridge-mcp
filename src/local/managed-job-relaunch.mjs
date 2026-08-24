import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertManagedJobPlanIntegrity } from "./managed-job-plan-integrity.mjs";
import { launchRunner } from "./managed-job-runner.mjs";
import { atomicWriteJson, readRequiredJson } from "./managed-job-storage.mjs";

const MAX_PLAN_BYTES = 1024 * 1024;

export function relaunchInterruptedManagedJob({
  dir, statusFile, status, recoveryAttempts, recoveryToken, logger, runnerEnvironmentOverrides, onRunnerExit,
}) {
  const plan = readVerifiedPlan(dir, status);
  status.status = "interrupted";
  status.updated_at = new Date().toISOString();
  status.finished_at = status.updated_at;
  status.error_class = "runner_interrupted";
  status.recovery_attempts = recoveryAttempts + 1;
  atomicWriteJson(statusFile, status, 256 * 1024);
  clearRunnerRuntime(dir);
  return launchRunner(dir, true, recoveryToken, runnerLaunchOptions(plan, logger, runnerEnvironmentOverrides, onRunnerExit));
}

export function relaunchDependencyWaitManagedJob({
  dir, statusFile, status, recoveryAttempts, logger, runnerEnvironmentOverrides, onRunnerExit,
}) {
  const plan = readVerifiedPlan(dir, status);
  status.status = "queued";
  status.current_phase = "dependency_wait";
  status.updated_at = new Date().toISOString();
  status.error_class = null;
  status.recovery_attempts = recoveryAttempts + 1;
  status.runner_pid = null;
  status.runner_process_started_at = null;
  atomicWriteJson(statusFile, status, 256 * 1024);
  clearRunnerRuntime(dir);
  return launchRunner(dir, false, "", runnerLaunchOptions(plan, logger, runnerEnvironmentOverrides, onRunnerExit));
}

function readVerifiedPlan(dir, status) {
  const plan = readRequiredJson(join(dir, "plan.json"), MAX_PLAN_BYTES, "job plan");
  assertManagedJobPlanIntegrity(plan, status);
  return plan;
}

function clearRunnerRuntime(dir) {
  rmSync(join(dir, "runtime"), { recursive: true, force: true });
  rmSync(join(dir, "runner.pid"), { force: true });
}

function runnerLaunchOptions(plan, logger, overrides, onExit) {
  return { logger, fullEnv: plan.full_env === true, env: { ...process.env, ...overrides }, onExit };
}
