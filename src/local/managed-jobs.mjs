import { createHash, randomBytes } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertStateMaintenanceAvailable } from "./state.mjs";
import { ensureOwnerOnlyDir, inspectPathIfPresentSync } from "./secure-file.mjs";
import { createToolAuthorizer } from "./policy.mjs";
import { BridgeError } from "./errors.mjs";
import { assertOwnedByContext, principalBinding, visibleToContext } from "./authority-context.mjs";
import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";
import { inspectResourceFile, normalizeResourceRegistry, validatePlan } from "./managed-job-plan.mjs";
export { inspectResourceFile, publicResourceRegistry, validateResourceName } from "./managed-job-plan.mjs";
import { clampInteger } from "./numbers.mjs";
import { acquireJobCapacityLock, acquireJobTransitionLock, acquireRecoveryLock } from "./managed-job-lock.mjs";
import { publicStatus, reviewablePlan } from "./managed-job-projection.mjs";
import { atomicWriteJson, readBoundedFile, readJson, readRequiredJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { launchRunner, runnerProcessIsCurrent } from "./managed-job-runner.mjs";
import { MANAGED_JOB_ID, resolveManagedJobDirectory, resolveManagedJobRootIfPresent } from "./managed-job-directory.mjs";
import { retiredManagedJobDirectories } from "./managed-job-directory-generation.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS } from "./managed-job-capacity.mjs";
import { writeManagedJobCancellation } from "./managed-job-cancellation.mjs";
import { pruneManagedJobs } from "./managed-job-retention.mjs";
import { assertTerminalJobEvidence, scrubTerminalJobArtifacts } from "./managed-job-terminal-maintenance.mjs";
import {
  ACTIVE_JOB_STATES, isTerminalManagedJobResult, isTerminalManagedJobStatus, persistManagedJobTerminal, terminalStatusFromResult,
} from "./managed-job-terminal.mjs";
export { launchRunner } from "./managed-job-runner.mjs";
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_RECOVERY_ATTEMPTS = 3;

export class ManagedJobManager {
  constructor({ jobRoot, workspace, policy, authorizeTool = null, policyForContext = null, resources = {}, resourceStatePath = "", stateRoot = "", logger = console, recover = true, runnerEnvironmentOverrides = {} }) {
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
    this.runnerEnvironmentOverrides = { ...runnerEnvironmentOverrides };
    this.assertMaintenanceAvailable();
    this.prune();
    if (recover) this.recoverInterruptedJobs();
  }

  status(context = {}) {
    this.assertMaintenanceAvailable();
    const listing = this.list({ limit: MAX_JOBS }, context);
    const jobs = listing.jobs;
    return {
      active: jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status)).length,
      staged: jobs.filter((job) => job.status === "staged").length,
      retained: jobs.length,
      maximum: MAX_JOBS,
      ...(listing.capacity ? { capacity: listing.capacity } : {}),
    };
  }

  resourceInfo(context = {}) {
    this.assertMaintenanceAvailable();
    if (context?.authority?.owner === false) {
      return { count: null, names: [], values_exposed: false, inventory_hidden_by_authority: true };
    }
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

  createJob(args, { launch }, context = {}) {
    const effectivePolicy = this.policyForContext(context);
    const idempotencyKey = launch ? normalizeJobIdempotencyKey(args?.idempotency_key) : null;
    const planArgs = idempotencyKey === null ? args : omitJobIdempotencyKey(args);
    const plan = validatePlan(planArgs, {
      workspace: this.workspace,
      resources: this.currentResources(),
      fullEnv: effectivePolicy.minimalEnv === false,
      unrestrictedPaths: effectivePolicy.unrestrictedPaths === true,
    });
    const planSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const idempotencyDigest = idempotencyKey === null ? null : managedJobIdempotencyDigest(idempotencyKey, context);
    const id = idempotencyDigest === null ? `job_${randomBytes(24).toString("base64url")}` : `job_${idempotencyDigest}`;
    const dir = join(this.jobRoot, id);
    const capacity = acquireJobCapacityLock(this.jobRoot);
    if (!capacity) {
      throw new BridgeError("conflict", "managed-job capacity is being committed by another process; retry after inspecting current jobs", {
        retryable: true,
        details: { capacity_commit_pending: true },
      });
    }
    try {
      const existingInfo = inspectPathIfPresentSync(dir, "managed job directory");
      if (existingInfo && (existingInfo.isSymbolicLink() || !existingInfo.isDirectory())) {
        throw new BridgeError("integrity_error", "managed job directory is not a real directory");
      }
      const alreadyExists = Boolean(existingInfo);
      if (alreadyExists) ensureOwnerOnlyDir(dir);
      pruneManagedJobs({ jobRoot: this.jobRoot, logger: this.logger, reserveSlots: alreadyExists ? 0 : 1 });
      const capacitySnapshot = managedJobCapacitySnapshot(this.jobRoot);
      if (!alreadyExists && capacitySnapshot.retained_state >= MAX_JOBS) {
        throw new BridgeError("limit_exceeded", `managed job capacity is fully occupied (${MAX_JOBS})`, {
          retryable: true,
          details: { maximum: MAX_JOBS, ...capacitySnapshot },
        });
      }
      ensureOwnerOnlyDir(dir);
      const transition = idempotencyDigest === null ? null : acquireJobTransitionLock(dir);
      if (idempotencyDigest !== null && !transition) {
        throw new BridgeError("conflict", "managed-job idempotency key is being committed by another process; inspect or retry the same request", {
          retryable: true,
          details: { idempotency_replay_pending: true },
        });
      }
      try {
        const statusFile = join(dir, "status.json");
        const statusEvidence = idempotencyDigest === null ? null : readJson(statusFile, 256 * 1024, "job status");
        if (statusEvidence !== null) {
          this.reconcileStatus(dir);
          const existing = readRequiredJson(statusFile, 256 * 1024, "job status");
          assertKnownManagedJobStatus(existing);
          assertOwnedByContext(existing, context, "managed job");
          assertManagedJobDirectoryIdentity(dir, existing);
          if (existing.plan_sha256 !== planSha256) {
            throw new BridgeError("conflict", "idempotency key is already bound to a different managed-job plan", {
              retryable: false,
              details: { existing_job_id: id },
            });
          }
          if (existing.status === "queued" && !runnerProcessIsCurrent(existing, dir)) {
            try {
              launchRunner(dir, false, "", runnerLaunchOptions(plan.full_env === true, this.logger, this.runnerEnvironmentOverrides));
            } catch (error) {
              failRunnerLaunch(dir, existing, error);
              throw error;
            }
          }
          return acceptedJobProjection(existing, plan, { idempotencyReplay: true });
        }
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
          approval: launch ? "mcp" : "review-only",
          plan_sha256: planSha256,
          cleanup_guarantee: launch ? "best-effort-finally-and-recovery" : "not-started",
          ...principalBinding(context),
        };
        atomicWriteJson(statusFile, status, 256 * 1024);
        if (launch) {
          try {
            launchRunner(dir, false, "", runnerLaunchOptions(plan.full_env === true, this.logger, this.runnerEnvironmentOverrides));
          } catch (error) {
            failRunnerLaunch(dir, status, error);
            throw error;
          }
        }
        return launch
          ? acceptedJobProjection(status, plan, { idempotencyReplay: false, idempotencyAccepted: idempotencyDigest !== null })
          : {
            staged: true,
            job_id: id,
            name: plan.name,
            status: "staged",
            execution_started: false,
            plan_sha256: planSha256,
            continuation: "review this draft; execution requires a separate start_job submission and never promotes this staged record",
            plan_expires_after_hours: 24,
          };
      } finally {
        transition?.release();
      }
    } finally {
      capacity.release();
    }
  }


  list(args = {}, context = {}) {
    this.authorizeTool("list_jobs");
    this.assertMaintenanceAvailable();
    this.prune();
    const limit = clampInteger(args.limit, 20, 1, MAX_JOBS);
    const jobs = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!MANAGED_JOB_ID.test(entry.name)) continue;
      if (!entry.isDirectory()) {
        this.logger.warn?.("managed job entry has the wrong type; retaining it for inspection", { error_class: "integrity_error" });
        if (context?.authority?.owner !== false) jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: "integrity_error" });
        continue;
      }
      const dir = join(this.jobRoot, entry.name);
      try {
        this.reconcileStatus(dir);
        const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
        if (!status || !visibleToContext(status, context)) continue;
        assertManagedJobDirectoryIdentity(dir, status);
        assertKnownManagedJobStatus(status);
        jobs.push(publicStatus(status));
      } catch (error) {
        this.logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: resourceErrorClass(error) });
        if (context?.authority?.owner !== false) jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: resourceErrorClass(error) });
      }
    }
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const ownerCapacity = context?.authority?.owner !== false ? { capacity: managedJobCapacitySnapshot(this.jobRoot) } : {};
    return { jobs: jobs.slice(0, limit), retained: jobs.length, maximum: MAX_JOBS, ...ownerCapacity };
  }

  read(args = {}, context = {}) {
    this.authorizeTool("read_job");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    this.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
    assertManagedJobDirectoryIdentity(dir, status);
    assertKnownManagedJobStatus(status);
    assertOwnedByContext(status, context, "managed job");
    const result = status.result_persisted === false ? null : readJson(join(dir, "result.json"), 4 * 1024 * 1024);
    if (!result && status.result_persisted !== false && !ACTIVE_JOB_STATES.has(status.status) && status.status !== "staged") {
      throw new BridgeError("integrity_error", "managed job terminal result is missing");
    }
    if (result && !isTerminalManagedJobResult(result, status.job_id)) {
      throw new BridgeError("integrity_error", "managed job result is invalid or belongs to another job");
    }
    if (result && !ACTIVE_JOB_STATES.has(status.status) && result.status !== status.status) {
      throw new BridgeError("integrity_error", "managed job status and result disagree");
    }
    const projectedStatus = ACTIVE_JOB_STATES.has(status.status) && result
      ? terminalStatusFromResult(status, result, { resultPersisted: true, updatedAt: result.finished_at })
      : status;
    return {
      ...publicStatus(projectedStatus),
      ...(result ? { result } : {}),
    };
  }

  inspectLocal(args = {}) {
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    const transition = acquireJobTransitionLock(dir);
    if (!transition) throw new Error("job state is being modified by another process; retry after inspecting its current status");
    try {
      this.reconcileStatus(dir);
      const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
      assertManagedJobDirectoryIdentity(dir, status);
      assertKnownManagedJobStatus(status);
      const plan = readJson(join(dir, "plan.json"), MAX_PLAN_BYTES);
      if (plan) assertPlanIntegrity(plan, status);
      return {
        ...publicStatus(status),
        plan_integrity_verified: Boolean(plan),
        ...(plan ? { review_plan: reviewablePlan(plan) } : {}),
      };
    } finally {
      transition.release();
    }
  }

  cancel(args = {}, context = {}) {
    this.authorizeTool("cancel_job");
    return cancelManagedJob(this, args, context);
  }

  revokeAuthority(revocation) {
    let revoked = 0;
    let failure = null;
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !MANAGED_JOB_ID.test(entry.name)) continue;
      try {
        const dir = join(this.jobRoot, entry.name);
        this.reconcileStatus(dir);
        const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
        assertManagedJobDirectoryIdentity(dir, status);
        assertKnownManagedJobStatus(status);
        if (!recordMatchesAuthorityRevocation(status, revocation)) continue;
        const principal = { kind: "account", accountId: status.owner_account_id, accountVersion: status.owner_account_version, clientId: status.owner_client_id, familyId: status.owner_family_id, role: "revocation" };
        if (cancelManagedJob(this, { job_id: entry.name }, { authority: { principal } }).cancellation_requested) revoked += 1;
      } catch (error) {
        failure ||= error;
        this.logger.warn?.("managed job authority revocation could not be applied", { error_class: resourceErrorClass(error) });
      }
    }
    if (failure) {
      throw new BridgeError("unavailable", "managed job authority revocation was incomplete; retained revocation must be retried", {
        cause: failure, retryable: true,
      });
    }
    return revoked;
  }

  currentResources() {
    this.assertMaintenanceAvailable();
    if (!this.resourceStatePath) return this.resources;
    const state = readJson(this.resourceStatePath, 2 * 1024 * 1024, "resource state");
    if (!state) return this.resources;
    if (typeof state !== "object" || Array.isArray(state)) throw new Error("resource state is not a JSON object");
    if (!state.resources || typeof state.resources !== "object" || Array.isArray(state.resources)) {
      throw new Error("resource state registry is invalid");
    }
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
    if (!initial) return;
    assertManagedJobDirectoryIdentity(dir, initial);
    if (initial.status === "staged") return;
    if (isTerminalManagedJobStatus(initial.status)) {
      scrubTerminalJobArtifacts(dir, initial);
      return;
    }
    if (!ACTIVE_JOB_STATES.has(initial.status)) {
      throw new BridgeError("integrity_error", "managed job status is invalid");
    }
    if (runnerProcessIsCurrent(initial, dir)) return;
    const terminalResult = readJson(join(dir, "result.json"), 4 * 1024 * 1024, "job result");
    if (terminalResult && !isTerminalManagedJobResult(terminalResult, initial.job_id)) {
      throw new BridgeError("integrity_error", "managed job result is invalid or belongs to another job");
    }
    if (terminalResult) {
      const recoveredStatus = terminalStatusFromResult(initial, terminalResult, {
        resultPersisted: true, updatedAt: new Date().toISOString(),
      });
      atomicWriteJson(file, recoveredStatus, 256 * 1024);
      scrubTerminalJobArtifacts(dir, recoveredStatus);
      return;
    }
    const updated = Date.parse(initial.updated_at || initial.created_at || "");
    if (Number.isFinite(updated) && Date.now() - updated < 10_000) return;

    const recoveryLock = acquireRecoveryLock(dir);
    if (!recoveryLock) return;
    let handedOff = false;
    try {
      const status = readJson(file, 256 * 1024);
      if (!status) return;
      assertManagedJobDirectoryIdentity(dir, status);
      if (status.status === "staged" || isTerminalManagedJobStatus(status.status)) return;
      if (!ACTIVE_JOB_STATES.has(status.status)) {
        throw new BridgeError("integrity_error", "managed job status is invalid");
      }
      if (runnerProcessIsCurrent(status, dir)) return;
      const recoveryAttempts = Number(status.recovery_attempts || 0);
      if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        markRecoveryExhausted(dir, file, status, recoveryAttempts);
        return;
      }
      const runnerPid = relaunchInterruptedJob(dir, file, status, recoveryAttempts, recoveryLock.token, this.logger, this.runnerEnvironmentOverrides);
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

  prune({ reserveSlots = 0 } = {}) {
    this.assertMaintenanceAvailable();
    const capacity = acquireJobCapacityLock(this.jobRoot);
    if (!capacity) return false;
    try {
      pruneManagedJobs({ jobRoot: this.jobRoot, logger: this.logger, reserveSlots });
      return true;
    } finally {
      capacity.release();
    }
  }
}

function cancelManagedJob(manager, args = {}, context = {}) {
  manager.assertMaintenanceAvailable();
  const dir = manager.jobDir(args.job_id);
  const transition = acquireJobTransitionLock(dir);
  if (!transition) throw new Error("job state is being modified by another process; retry after inspecting its current status");
  try {
    manager.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
    assertManagedJobDirectoryIdentity(dir, status);
    assertKnownManagedJobStatus(status);
    assertOwnedByContext(status, context, "managed job");
    if (status.status === "staged") {
      const now = new Date().toISOString();
      status.cleanup_guarantee = "not-started";
      const result = {
        job_id: status.job_id, name: status.name, status: "cancelled_before_start",
        steps: [], finally_steps: [], error_class: "cancelled", cleanup_error_class: null, finished_at: now,
      };
      const terminal = persistManagedJobTerminal({
        statusFile: join(dir, "status.json"), resultFile: join(dir, "result.json"),
        artifacts: [join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel")],
        status, result, writeJson: atomicWriteJson,
        removeFile: (file) => rmSync(file, { recursive: true, force: true }),
        maxStatusBytes: 256 * 1024, maxResultBytes: 4 * 1024 * 1024, classifyPersistenceError: resourceErrorClass,
      });
      Object.assign(status, terminal.status);
      if (!terminal.statusPersisted) throw new Error(`managed job staged cancellation status persistence failed: ${terminal.statusErrorClass}`);
      return { ...publicStatus(status), cancellation_requested: true, cleanup_will_run: false, execution_started: false };
    }
    if (!ACTIVE_JOB_STATES.has(status.status)) {
      return { ...publicStatus(status), cancellation_requested: false, already_finished: true };
    }
    writeManagedJobCancellation(join(dir, "cancel"));
    return {
      ...publicStatus(status), cancellation_requested: true,
      cancellation_delivery: "runner-poll", cleanup_will_run: true,
    };
  } finally {
    transition.release();
  }
}

function isKnownManagedJobStatus(value) {
  return value === "staged" || ACTIVE_JOB_STATES.has(value) || isTerminalManagedJobStatus(value);
}

function assertManagedJobDirectoryIdentity(dir, status) {
  if (status?.job_id !== basename(dir)) {
    throw new BridgeError("integrity_error", "managed job state does not match its directory");
  }
}

function assertKnownManagedJobStatus(status) {
  if (!isKnownManagedJobStatus(status?.status)) {
    throw new BridgeError("integrity_error", "managed job status is invalid");
  }
}

export function activeManagedJobs(jobRoot) {
  const root = resolveManagedJobRootIfPresent(jobRoot);
  if (!root) return [];
  const jobs = [];
  for (const retired of retiredManagedJobDirectories(root)) {
    jobs.push(retired.reclaimable
      ? { state_kind: "retired_managed_job", status: "retired_cleanup_pending", runner_alive: false, error_class: null }
      : { state_kind: "retired_managed_job", status: "unreadable", runner_alive: true, error_class: retired.error_class || "integrity_error" });
  }
  for (const entry of safeReadDir(root)) {
    if (!MANAGED_JOB_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: "integrity_error" });
      continue;
    }
    const dir = join(root, entry.name);
    let status;
    try {
      status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
    } catch (error) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: resourceErrorClass(error) });
      continue;
    }
    if (status && status.job_id !== entry.name) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: "integrity_error" });
      continue;
    }
    if (status && !isKnownManagedJobStatus(status.status)) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: "integrity_error" });
      continue;
    }
    if (status && isTerminalManagedJobStatus(status.status)) {
      try { assertTerminalJobEvidence(dir, status); }
      catch (error) {
        jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: error?.code === "integrity_error" ? "integrity_error" : resourceErrorClass(error) });
        continue;
      }
    }
    let runnerAlive;
    try { runnerAlive = runnerProcessIsCurrent(status, dir); }
    catch (error) {
      jobs.push({ job_id: entry.name, status: "unreadable", runner_alive: true, error_class: resourceErrorClass(error) });
      continue;
    }
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
  const errorClass = resourceErrorClass(error);
  const result = {
    job_id: status.job_id, name: status.name, status: "runner_launch_failed", steps: [], finally_steps: [],
    error_class: errorClass, cleanup_error_class: null, finished_at: now,
  };
  const terminal = persistManagedJobTerminal({
    statusFile: join(dir, "status.json"), resultFile: join(dir, "result.json"),
    artifacts: [join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel")],
    status: { ...status, cleanup_guarantee: "not-started", error_class: errorClass }, result,
    writeJson: atomicWriteJson, removeFile: (file) => rmSync(file, { recursive: true, force: true }),
    maxStatusBytes: 256 * 1024, maxResultBytes: 4 * 1024 * 1024, classifyPersistenceError: resourceErrorClass,
  });
  if (!terminal.statusPersisted) throw new Error(`managed job launch-failure status persistence failed: ${terminal.statusErrorClass}`);
}

function markRecoveryExhausted(dir, statusFile, status, recoveryAttempts) {
  const now = new Date().toISOString();
  const result = {
    job_id: status.job_id, name: status.name, status: "recovery_exhausted", recovered: true,
    steps: [], finally_steps: [], error_class: "recovery_exhausted", cleanup_error_class: "recovery_exhausted",
    recovery_attempts: recoveryAttempts, finished_at: now,
  };
  const terminal = persistManagedJobTerminal({
    statusFile, resultFile: join(dir, "result.json"),
    artifacts: [join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel")],
    status, result, writeJson: atomicWriteJson, removeFile: (file) => rmSync(file, { recursive: true, force: true }),
    maxStatusBytes: 256 * 1024, maxResultBytes: 4 * 1024 * 1024, classifyPersistenceError: resourceErrorClass,
  });
  if (!terminal.statusPersisted) throw new Error(`managed job recovery-exhausted status persistence failed: ${terminal.statusErrorClass}`);
}

function relaunchInterruptedJob(dir, statusFile, status, recoveryAttempts, recoveryToken, logger, runnerEnvironmentOverrides) {
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
  return launchRunner(dir, true, recoveryToken, runnerLaunchOptions(plan.full_env === true, logger, runnerEnvironmentOverrides));
}

function runnerLaunchOptions(fullEnv, logger, overrides = {}) {
  return { logger, fullEnv, env: { ...process.env, ...overrides } };
}

function normalizeJobIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(value)) {
    throw new BridgeError("invalid_request", "idempotency_key must be a 1-128 character identifier using letters, digits, dot, underscore, tilde, colon, or hyphen");
  }
  return value;
}

function omitJobIdempotencyKey(args) {
  const { idempotency_key: _ignored, ...planArgs } = args;
  return planArgs;
}

function managedJobIdempotencyDigest(key, context) {
  const binding = principalBinding(context);
  const scope = binding.owner_kind === "account"
    ? [binding.owner_kind, binding.owner_account_id, binding.owner_account_version, binding.owner_client_id, binding.owner_family_id].join("\0")
    : "local";
  return createHash("sha256")
    .update("machine-bridge-managed-job-idempotency-v1\0")
    .update(scope)
    .update("\0")
    .update(key)
    .digest("hex");
}

function acceptedJobProjection(status, plan, { idempotencyReplay = false, idempotencyAccepted = true } = {}) {
  return {
    accepted: true,
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    detached: true,
    continues_without_mcp_connection: true,
    approval: status.approval,
    plan_sha256: status.plan_sha256,
    ...(idempotencyAccepted ? { idempotency_key_accepted: true, idempotency_replay: idempotencyReplay } : {}),
    cleanup: {
      resource_copies: "best-effort",
      finally_steps: plan.finally_steps.length ? "best-effort" : "none-declared",
      restart_recovery: "best-effort-on-next-runtime-or-cli-start",
    },
  };
}

function planSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function assertPlanIntegrity(plan, status) {
  const expected = String(status?.plan_sha256 || "");
  const actual = planSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error("managed job plan integrity check failed; inspect the plan and do not submit or execute it");
  }
  return actual;
}
