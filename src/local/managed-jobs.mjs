import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertStateMaintenanceAvailable } from "./state.mjs";
import { ensureOwnerOnlyDir } from "./secure-file.mjs";
import { createToolAuthorizer } from "./policy.mjs";
import { BridgeError } from "./errors.mjs";
import { assertOwnedByContext, principalBinding, visibleToContext } from "./authority-context.mjs";
import { inspectResourceFile, normalizeResourceRegistry, validatePlan } from "./managed-job-plan.mjs";
export { inspectResourceFile, publicResourceRegistry, validateResourceName } from "./managed-job-plan.mjs";
import { clampInteger } from "./numbers.mjs";
import { acquireJobTransitionLock, acquireRecoveryLock } from "./managed-job-lock.mjs";
import { publicStatus, reviewablePlan } from "./managed-job-projection.mjs";
import {
  atomicWriteJson, readBoundedFile, readJson, readRequiredJson, resourceErrorClass, safeReadDir,
} from "./managed-job-storage.mjs";
import { launchRunner, runnerProcessIsCurrent } from "./managed-job-runner.mjs";
import { MANAGED_JOB_ID, resolveManagedJobDirectory, resolveManagedJobRootIfPresent } from "./managed-job-directory.mjs";
import { writeManagedJobCancellation } from "./managed-job-cancellation.mjs";
import {
  isTerminalManagedJobResult, scrubManagedJobArtifacts, terminalStatusFromResult,
} from "./managed-job-terminal.mjs";
export { launchRunner } from "./managed-job-runner.mjs";

const MAX_JOBS = 50;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGED_PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_RECOVERY_ATTEMPTS = 3;
const ACTIVE_JOB_STATES = new Set(["queued", "running", "cleaning", "interrupted"]);
const PLAN_RETAINING_STATES = new Set(["staged", ...ACTIVE_JOB_STATES]);

export class ManagedJobManager {
  constructor({ jobRoot, workspace, policy, authorizeTool = null, policyForContext = null, resources = {}, resourceStatePath = "", stateRoot = "", logger = console, recover = true }) {
    const jobRootInput = resolve(jobRoot);
    ensureOwnerOnlyDir(jobRootInput);
    this.jobRoot = realpathSync.native ? realpathSync.native(jobRootInput) : realpathSync(jobRootInput);
    const workspaceInput = resolve(workspace);
    this.workspace = realpathSync.native ? realpathSync.native(workspaceInput) : realpathSync(workspaceInput);
    this.policy = policy;
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.policyForContext = typeof policyForContext === "function" ? policyForContext : () => this.policy;
    this.resources = normalizeResourceRegistry(resources);
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.stateRoot = stateRoot ? resolve(stateRoot) : "";
    this.logger = logger;
    this.assertMaintenanceAvailable();
    this.prune();
    if (recover) this.recoverInterruptedJobs();
  }

  status() {
    this.assertMaintenanceAvailable();
    const jobs = this.list({ limit: MAX_JOBS }).jobs;
    return {
      active: jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status)).length,
      staged: jobs.filter((job) => job.status === "staged").length,
      retained: jobs.length,
      maximum: MAX_JOBS,
    };
  }

  resourceInfo() {
    this.assertMaintenanceAvailable();
    const resources = this.currentResources();
    return {
      count: Object.keys(resources).length,
      names: Object.keys(resources).sort(),
      values_exposed: false,
    };
  }

  listResources(_context = {}) {
    this.authorizeTool("list_local_resources");
    this.assertMaintenanceAvailable();
    const resources = [];
    for (const [name, resource] of Object.entries(this.currentResources()).sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true });
        resources.push({ name, kind: "file", available: true, size: inspected.size, mode: inspected.mode });
      } catch (error) {
        const errorClass = resourceErrorClass(error);
        if (errorClass === "resource_unavailable") throw error;
        resources.push({ name, kind: "file", available: false, error_class: errorClass });
      }
    }
    return { resources, count: resources.length, values_exposed: false, paths_exposed: false };
  }

  diagnoseStorage() {
    this.assertMaintenanceAvailable();
    const probe = join(this.jobRoot, `.probe-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(probe, "ok\n", { mode: 0o600, flag: "wx" });
      const content = readBoundedFile(probe, 64).toString("utf8");
      return { ok: content === "ok\n", error_class: content === "ok\n" ? null : "storage_mismatch" };
    } catch (error) {
      return { ok: false, error_class: resourceErrorClass(error) };
    } finally {
      rmSync(probe, { force: true });
    }
  }


  stage(args = {}, context = {}) {
    this.authorizeTool("stage_job");
    this.assertMaintenanceAvailable();
    return this.createJob(args, { launch: false }, context);
  }

  start(args = {}, context = {}) {
    this.authorizeTool("start_job");
    this.assertMaintenanceAvailable();
    return this.createJob(args, { launch: true }, context);
  }

  approve(args = {}, { localOperator = false } = {}) {
    if (!localOperator) throw new BridgeError("policy_denied", "job approval is a local-operator-only action");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    const transition = acquireJobTransitionLock(dir);
    if (!transition) throw new Error("job state is being modified by another process; retry after inspecting its current status");
    try {
      const statusFile = join(dir, "status.json");
      const status = readRequiredJson(statusFile, 256 * 1024, "job status");
      if (status.status !== "staged") throw new Error(`job is not staged: ${status.status}`);
      const plan = readRequiredJson(join(dir, "plan.json"), MAX_PLAN_BYTES, "job plan");
      assertPlanIntegrity(plan, status);
      status.status = "queued";
      status.updated_at = new Date().toISOString();
      status.approved_at = status.updated_at;
      status.approval = "local-operator";
      status.cleanup_guarantee = "best-effort-finally-and-recovery";
      atomicWriteJson(statusFile, status, 256 * 1024);
      try {
        launchRunner(dir, false, "", { logger: this.logger, fullEnv: plan.full_env === true });
      } catch (error) {
        failRunnerLaunch(dir, status, error);
        throw error;
      }
      return {
        accepted: true,
        job_id: status.job_id,
        name: status.name,
        status: "queued",
        detached: true,
        continues_without_mcp_connection: true,
        approval: status.approval,
        plan_sha256: status.plan_sha256,
        cleanup: {
          resource_copies: "best-effort",
          finally_steps: "best-effort-if-declared",
          restart_recovery: "best-effort-on-next-runtime-or-cli-start",
        },
      };
    } finally {
      transition.release();
    }
  }

  createJob(args, { launch }, context = {}) {
    this.prune();
    const retained = safeReadDir(this.jobRoot).filter((entry) => entry.isDirectory() && MANAGED_JOB_ID.test(entry.name)).length;
    if (retained >= MAX_JOBS) throw new Error(`managed job limit reached (${MAX_JOBS})`);
    const effectivePolicy = this.policyForContext(context);
    const plan = validatePlan(args, {
      workspace: this.workspace,
      resources: this.currentResources(),
      fullEnv: effectivePolicy.minimalEnv === false,
      unrestrictedPaths: effectivePolicy.unrestrictedPaths === true,
    });
    const planSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const id = `job_${randomBytes(24).toString("base64url")}`;
    const dir = join(this.jobRoot, id);
    ensureOwnerOnlyDir(dir);
    atomicWriteJson(join(dir, "plan.json"), plan, MAX_PLAN_BYTES);
    const now = new Date().toISOString();
    const status = {
      job_id: id,
      name: plan.name,
      status: launch ? "queued" : "staged",
      created_at: now,
      updated_at: now,
      current_phase: null,
      current_step: null,
      runner_pid: null,
      approval: launch ? "mcp" : "pending-local-operator",
      plan_sha256: planSha256,
      cleanup_guarantee: launch ? "best-effort-finally-and-recovery" : "not-started",
      ...principalBinding(context),
    };
    atomicWriteJson(join(dir, "status.json"), status, 256 * 1024);
    if (launch) {
      try {
        launchRunner(dir, false, "", { logger: this.logger, fullEnv: plan.full_env === true });
      } catch (error) {
        failRunnerLaunch(dir, status, error);
        throw error;
      }
    }
    return launch ? {
      accepted: true,
      job_id: id,
      name: plan.name,
      status: "queued",
      detached: true,
      continues_without_mcp_connection: true,
      approval: "mcp",
      plan_sha256: planSha256,
      cleanup: {
        resource_copies: "best-effort",
        finally_steps: plan.finally_steps.length ? "best-effort" : "none-declared",
        restart_recovery: "best-effort-on-next-runtime-or-cli-start",
      },
    } : {
      staged: true,
      job_id: id,
      name: plan.name,
      status: "staged",
      execution_started: false,
      plan_sha256: planSha256,
      continuation: "start the staged job through the same authenticated client when ready",
      plan_expires_after_hours: 24,
    };
  }


  list(args = {}, context = {}) {
    this.authorizeTool("list_jobs");
    this.assertMaintenanceAvailable();
    this.prune();
    const limit = clampInteger(args.limit, 20, 1, MAX_JOBS);
    const jobs = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !MANAGED_JOB_ID.test(entry.name)) continue;
      const dir = join(this.jobRoot, entry.name);
      try {
        this.reconcileStatus(dir);
        const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
        if (!status || !visibleToContext(status, context)) continue;
        jobs.push(publicStatus(status));
      } catch (error) {
        this.logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: resourceErrorClass(error) });
        if (context?.authority?.owner !== false) jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: resourceErrorClass(error) });
      }
    }
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { jobs: jobs.slice(0, limit), retained: jobs.length, maximum: MAX_JOBS };
  }

  read(args = {}, context = {}) {
    this.authorizeTool("read_job");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    this.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
    assertOwnedByContext(status, context, "managed job");
    const result = readJson(join(dir, "result.json"), 4 * 1024 * 1024);
    return {
      ...publicStatus(status),
      ...(result ? { result } : {}),
    };
  }

  inspectLocal(args = {}) {
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    this.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
    const plan = readJson(join(dir, "plan.json"), MAX_PLAN_BYTES);
    if (plan) assertPlanIntegrity(plan, status);
    return {
      ...publicStatus(status),
      plan_integrity_verified: Boolean(plan),
      ...(plan ? { review_plan: reviewablePlan(plan) } : {}),
    };
  }

  cancel(args = {}, context = {}) {
    this.authorizeTool("cancel_job");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    const transition = acquireJobTransitionLock(dir);
    if (!transition) throw new Error("job state is being modified by another process; retry after inspecting its current status");
    try {
      this.reconcileStatus(dir);
      const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
      assertOwnedByContext(status, context, "managed job");
      if (status.status === "staged") {
        const now = new Date().toISOString();
        status.status = "cancelled_before_start";
        status.updated_at = now;
        status.finished_at = now;
        status.error_class = "cancelled";
        status.cleanup_guarantee = "not-started";
        atomicWriteJson(join(dir, "status.json"), status, 256 * 1024);
        atomicWriteJson(join(dir, "result.json"), {
          job_id: status.job_id,
          name: status.name,
          status: status.status,
          steps: [],
          finally_steps: [],
          error_class: "cancelled",
          cleanup_error_class: null,
          finished_at: now,
        }, 4 * 1024 * 1024);
        scrubFinishedPlan(dir, status);
        return { ...publicStatus(status), cancellation_requested: true, cleanup_will_run: false, execution_started: false };
      }
      if (!ACTIVE_JOB_STATES.has(status.status)) {
        return { ...publicStatus(status), cancellation_requested: false, already_finished: true };
      }
      writeManagedJobCancellation(join(dir, "cancel"));
      return {
        ...publicStatus(status),
        cancellation_requested: true,
        cancellation_delivery: "runner-poll",
        cleanup_will_run: true,
      };
    } finally {
      transition.release();
    }
  }

  currentResources() {
    this.assertMaintenanceAvailable();
    if (!this.resourceStatePath) return this.resources;
    const state = readJson(this.resourceStatePath, 2 * 1024 * 1024, "resource state");
    if (!state) return this.resources;
    if (typeof state !== "object" || Array.isArray(state)) throw new Error("resource state is not a JSON object");
    return normalizeResourceRegistry(state.resources);
  }

  assertMaintenanceAvailable() {
    if (this.stateRoot) assertStateMaintenanceAvailable(this.stateRoot);
  }


  jobDir(value) {
    return resolveManagedJobDirectory(this.jobRoot, value);
  }

  reconcileStatus(dir) {
    this.assertMaintenanceAvailable();
    const file = join(dir, "status.json");
    const initial = readJson(file, 256 * 1024);
    if (!initial || !ACTIVE_JOB_STATES.has(initial.status)) {
      if (initial) scrubFinishedPlan(dir, initial);
      return;
    }
    if (runnerProcessIsCurrent(initial, dir)) return;
    const terminalResult = readJson(join(dir, "result.json"), 4 * 1024 * 1024, "job result");
    if (isTerminalManagedJobResult(terminalResult, initial.job_id)) {
      const recoveredStatus = terminalStatusFromResult(initial, terminalResult, {
        resultPersisted: true, updatedAt: new Date().toISOString(),
      });
      atomicWriteJson(file, recoveredStatus, 256 * 1024);
      scrubFinishedPlan(dir, recoveredStatus);
      return;
    }
    const updated = Date.parse(initial.updated_at || initial.created_at || "");
    if (Number.isFinite(updated) && Date.now() - updated < 10_000) return;

    const recoveryLock = acquireRecoveryLock(dir);
    if (!recoveryLock) return;
    let handedOff = false;
    try {
      const status = readJson(file, 256 * 1024);
      if (!status || !ACTIVE_JOB_STATES.has(status.status)) return;
      if (runnerProcessIsCurrent(status, dir)) return;
      const recoveryAttempts = Number(status.recovery_attempts || 0);
      if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        markRecoveryExhausted(dir, file, status, recoveryAttempts);
        return;
      }
      const runnerPid = relaunchInterruptedJob(dir, file, status, recoveryAttempts, recoveryLock.token, this.logger);
      recoveryLock.handoff(runnerPid);
      handedOff = true;
    } finally {
      if (!handedOff) recoveryLock.release();
    }
  }

  recoverInterruptedJobs() {
    this.assertMaintenanceAvailable();
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !MANAGED_JOB_ID.test(entry.name)) continue;
      try {
        this.reconcileStatus(join(this.jobRoot, entry.name));
      } catch (error) {
        this.logger.warn?.("managed job recovery skipped unreadable state; retaining it for inspection", { error_class: resourceErrorClass(error) });
      }
    }
  }

  prune() {
    this.assertMaintenanceAvailable();
    const entries = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !MANAGED_JOB_ID.test(entry.name)) continue;
      const dir = join(this.jobRoot, entry.name);
      let status;
      let mtime;
      try {
        status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
        mtime = statSync(dir).mtimeMs;
      } catch (error) {
        this.logger.warn?.("managed job pruning skipped unreadable state; retaining it for inspection", { error_class: resourceErrorClass(error) });
        continue;
      }
      if (!status) {
        const fallbackOwner = { startedAt: new Date(mtime).toISOString() };
        if (!runnerProcessIsCurrent(fallbackOwner, dir, { ownerOnly: true }) && Date.now() - mtime > 60_000) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
      }
      if (status?.status === "staged" && stagedPlanExpired(status, mtime)) status = expireStagedJob(dir, status);
      if (status && !PLAN_RETAINING_STATES.has(status.status)) scrubFinishedPlan(dir, status);
      entries.push({ dir, status, mtime });
    }
    const finished = entries
      .filter(({ status }) => status && !ACTIVE_JOB_STATES.has(status.status))
      .sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    for (const item of finished) {
      if (now - item.mtime > JOB_RETENTION_MS) rmSync(item.dir, { recursive: true, force: true });
    }
    const remaining = entries.filter((item) => existsSync(item.dir));
    if (remaining.length <= MAX_JOBS) return;
    const removable = remaining
      .filter(({ status }) => status && !ACTIVE_JOB_STATES.has(status.status))
      .sort((a, b) => a.mtime - b.mtime);
    for (const item of removable) {
      if (safeReadDir(this.jobRoot).filter((entry) => entry.isDirectory() && MANAGED_JOB_ID.test(entry.name)).length <= MAX_JOBS) break;
      rmSync(item.dir, { recursive: true, force: true });
    }
  }
}

export function activeManagedJobs(jobRoot) {
  const root = resolveManagedJobRootIfPresent(jobRoot);
  if (!root) return [];
  const jobs = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory() || !MANAGED_JOB_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    let status;
    try {
      status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
    } catch (error) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: resourceErrorClass(error) });
      continue;
    }
    const runnerAlive = runnerProcessIsCurrent(status, dir);
    const lifecycleActive = status && ACTIVE_JOB_STATES.has(status.status);
    if (runnerAlive || lifecycleActive) {
      jobs.push({
        job_id: entry.name,
        status: status?.status || "unknown",
        runner_alive: runnerAlive,
      });
    }
  }
  return jobs;
}

export function loadManagedJobPlan(inputPath) {
  const path = resolve(String(inputPath || ""));
  const buffer = readBoundedFile(path, MAX_PLAN_BYTES);
  let value;
  try { value = JSON.parse(buffer.toString("utf8")); } catch {
    throw new Error("job plan is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("job plan must contain a JSON object");
  return value;
}


function failRunnerLaunch(dir, status, error) {
  const now = new Date().toISOString();
  const failed = {
    ...status,
    status: "runner_launch_failed",
    updated_at: now,
    finished_at: now,
    error_class: resourceErrorClass(error),
    cleanup_guarantee: "not-started",
  };
  atomicWriteJson(join(dir, "status.json"), failed, 256 * 1024);
  atomicWriteJson(join(dir, "result.json"), {
    job_id: failed.job_id,
    name: failed.name,
    status: failed.status,
    steps: [],
    finally_steps: [],
    error_class: failed.error_class,
    cleanup_error_class: null,
    finished_at: now,
  }, 4 * 1024 * 1024);
  scrubFinishedPlan(dir, failed);
}

function markRecoveryExhausted(dir, statusFile, status, recoveryAttempts) {
  const now = new Date().toISOString();
  Object.assign(status, {
    status: "recovery_exhausted",
    updated_at: now,
    finished_at: now,
    error_class: "recovery_exhausted",
    current_phase: null,
    current_step: null,
  });
  atomicWriteJson(statusFile, status, 256 * 1024);
  atomicWriteJson(join(dir, "result.json"), {
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    recovered: true,
    steps: [],
    finally_steps: [],
    error_class: "recovery_exhausted",
    cleanup_error_class: "recovery_exhausted",
    recovery_attempts: recoveryAttempts,
    finished_at: now,
  }, 4 * 1024 * 1024);
  rmSync(join(dir, "runtime"), { recursive: true, force: true });
  scrubFinishedPlan(dir, status);
}

function relaunchInterruptedJob(dir, statusFile, status, recoveryAttempts, recoveryToken, logger) {
  const plan = readRequiredJson(join(dir, "plan.json"), MAX_PLAN_BYTES, "job plan");
  assertPlanIntegrity(plan, status);
  status.status = "interrupted";
  status.updated_at = new Date().toISOString();
  status.finished_at = status.updated_at;
  status.error_class = "runner_interrupted";
  status.recovery_attempts = recoveryAttempts + 1;
  atomicWriteJson(statusFile, status, 256 * 1024);
  rmSync(join(dir, "runtime"), { recursive: true, force: true });
  rmSync(join(dir, "runner.pid"), { force: true });
  return launchRunner(dir, true, recoveryToken, { logger, fullEnv: plan.full_env === true });
}

function stagedPlanExpired(status, fallbackMtime) {
  const createdAt = Date.parse(String(status?.created_at || ""));
  const baseline = Number.isFinite(createdAt) ? createdAt : fallbackMtime;
  return Number.isFinite(baseline) && Date.now() - baseline > STAGED_PLAN_RETENTION_MS;
}

function expireStagedJob(dir, status) {
  const now = new Date().toISOString();
  const expired = {
    ...status,
    status: "expired_before_start",
    updated_at: now,
    finished_at: now,
    current_phase: null,
    current_step: null,
    error_class: "expired",
    cleanup_guarantee: "not-started",
  };
  atomicWriteJson(join(dir, "status.json"), expired, 256 * 1024);
  atomicWriteJson(join(dir, "result.json"), {
    job_id: expired.job_id,
    name: expired.name,
    status: expired.status,
    steps: [],
    finally_steps: [],
    error_class: "expired",
    cleanup_error_class: null,
    finished_at: now,
  }, 4 * 1024 * 1024);
  scrubFinishedPlan(dir, expired);
  return expired;
}

function planSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function assertPlanIntegrity(plan, status) {
  const expected = String(status?.plan_sha256 || "");
  const actual = planSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error("managed job plan integrity check failed; inspect the plan and do not approve it");
  }
  return actual;
}

function scrubFinishedPlan(dir, status) {
  if (PLAN_RETAINING_STATES.has(status.status)) return { scrubbed: false, errorClass: null, failureCount: 0 };
  const cleanup = scrubManagedJobArtifacts([
    join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel"),
    join(dir, "recovery.lock"), join(dir, "transition.lock"),
  ], (file) => rmSync(file, { recursive: true, force: true }), resourceErrorClass);
  const pending = !cleanup.scrubbed;
  if (status.artifact_cleanup_pending !== pending
      || (status.artifact_cleanup_error_class || null) !== cleanup.errorClass) {
    status.artifact_cleanup_pending = pending;
    status.artifact_cleanup_error_class = cleanup.errorClass;
    status.updated_at = new Date().toISOString();
    atomicWriteJson(join(dir, "status.json"), status, 256 * 1024);
  }
  return cleanup;
}
