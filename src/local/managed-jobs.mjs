import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, ftruncateSync, lstatSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStateMaintenanceAvailable, ensureOwnerOnlyDir, ownerOnlyFile } from "./state.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeMs } from "./process-identity.mjs";
import { openRegularFileSync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { createToolAuthorizer } from "./policy.mjs";
import { BridgeError } from "./errors.mjs";
import { inspectResourceFile, normalizeResourceRegistry, validatePlan } from "./managed-job-plan.mjs";
export { inspectResourceFile, publicResourceRegistry, validateResourceName } from "./managed-job-plan.mjs";
import { clampInteger } from "./numbers.mjs";

const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const MAX_JOBS = 50;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_RECOVERY_ATTEMPTS = 3;
const RUNNER_PATH = fileURLToPath(new URL("./job-runner.mjs", import.meta.url));
const ACTIVE_JOB_STATES = new Set(["queued", "running", "cleaning", "interrupted"]);
const PLAN_RETAINING_STATES = new Set(["staged", ...ACTIVE_JOB_STATES]);

export class ManagedJobManager {
  constructor({ jobRoot, workspace, policy, authorizeTool = null, resources = {}, resourceStatePath = "", stateRoot = "", logger = console, recover = true }) {
    const jobRootInput = resolve(jobRoot);
    ensureOwnerOnlyDir(jobRootInput);
    this.jobRoot = realpathSync.native ? realpathSync.native(jobRootInput) : realpathSync(jobRootInput);
    const workspaceInput = resolve(workspace);
    this.workspace = realpathSync.native ? realpathSync.native(workspaceInput) : realpathSync(workspaceInput);
    this.policy = policy;
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
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

  listResources() {
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


  stage(args = {}) {
    this.authorizeTool("stage_job");
    this.assertMaintenanceAvailable();
    return this.createJob(args, { launch: false });
  }

  start(args = {}) {
    this.authorizeTool("start_job");
    this.assertMaintenanceAvailable();
    return this.createJob(args, { launch: true });
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
        launchRunner(dir);
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

  createJob(args, { launch }) {
    this.prune();
    const retained = safeReadDir(this.jobRoot).filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).length;
    if (retained >= MAX_JOBS) throw new Error(`managed job limit reached (${MAX_JOBS})`);
    const plan = validatePlan(args, {
      workspace: this.workspace,
      resources: this.currentResources(),
      fullEnv: this.policy.minimalEnv === false,
      unrestrictedPaths: this.policy.unrestrictedPaths === true,
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
    };
    atomicWriteJson(join(dir, "status.json"), status, 256 * 1024);
    if (launch) {
      try {
        launchRunner(dir);
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
      local_inspection_command: `machine-mcp job inspect ${id}`,
      local_approval_command: `machine-mcp job approve ${id}`,
      plan_expires_after_days: 7,
    };
  }


  list(args = {}) {
    this.authorizeTool("list_jobs");
    this.assertMaintenanceAvailable();
    this.prune();
    const limit = clampInteger(args.limit, 20, 1, MAX_JOBS);
    const jobs = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      const dir = join(this.jobRoot, entry.name);
      try {
        this.reconcileStatus(dir);
        const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
        if (!status) continue;
        jobs.push(publicStatus(status));
      } catch (error) {
        this.logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: resourceErrorClass(error) });
        jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: resourceErrorClass(error) });
      }
    }
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { jobs: jobs.slice(0, limit), retained: jobs.length, maximum: MAX_JOBS };
  }

  read(args = {}) {
    this.authorizeTool("read_job");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    this.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
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

  cancel(args = {}) {
    this.authorizeTool("cancel_job");
    this.assertMaintenanceAvailable();
    const dir = this.jobDir(args.job_id);
    const transition = acquireJobTransitionLock(dir);
    if (!transition) throw new Error("job state is being modified by another process; retry after inspecting its current status");
    try {
      this.reconcileStatus(dir);
      const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
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
      writeFileSync(join(dir, "cancel"), `${new Date().toISOString()}\n`, { mode: 0o600 });
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
    const id = String(value || "");
    if (!JOB_ID.test(id)) throw new Error("invalid job id");
    const dir = join(this.jobRoot, id);
    if (!existsSync(dir)) throw new Error("job not found or expired");
    return dir;
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
      const runnerPid = relaunchInterruptedJob(dir, file, status, recoveryAttempts, recoveryLock.token);
      recoveryLock.handoff(runnerPid);
      handedOff = true;
    } finally {
      if (!handedOff) recoveryLock.release();
    }
  }

  recoverInterruptedJobs() {
    this.assertMaintenanceAvailable();
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
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
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
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
        const runner = readRunnerOwner(dir, { startedAt: new Date(mtime).toISOString() });
        if (!runnerProcessIsCurrent(runner, dir, { ownerOnly: true }) && Date.now() - mtime > 60_000) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
      }
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
      if (safeReadDir(this.jobRoot).filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).length <= MAX_JOBS) break;
      rmSync(item.dir, { recursive: true, force: true });
    }
  }
}

export function activeManagedJobs(jobRoot) {
  const root = resolve(jobRoot);
  if (!existsSync(root)) return [];
  const jobs = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
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
  const linkInfo = lstatSync(path);
  if (linkInfo.isSymbolicLink()) throw new Error("job plan must not be a symbolic link");
  if (!linkInfo.isFile()) throw new Error("job plan is not a regular file");
  let value;
  try { value = JSON.parse(readBoundedFile(path, MAX_PLAN_BYTES).toString("utf8")); } catch (error) {
    if (/exceeds/.test(String(error?.message || error))) throw error;
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

function relaunchInterruptedJob(dir, statusFile, status, recoveryAttempts, recoveryToken) {
  status.status = "interrupted";
  status.updated_at = new Date().toISOString();
  status.finished_at = status.updated_at;
  status.error_class = "runner_interrupted";
  status.recovery_attempts = recoveryAttempts + 1;
  atomicWriteJson(statusFile, status, 256 * 1024);
  rmSync(join(dir, "runtime"), { recursive: true, force: true });
  rmSync(join(dir, "runner.pid"), { force: true });
  return launchRunner(dir, true, recoveryToken);
}

function acquireRecoveryLock(dir) {
  return acquirePidLock(join(dir, "recovery.lock"), { allowHandoff: true });
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

function acquireJobTransitionLock(dir) {
  return acquirePidLock(join(dir, "transition.lock"));
}

function acquirePidLock(file, { allowHandoff = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = pidLockOwner(process.pid, currentProcessStartTimeMs());
    try {
      createExclusiveFileSync(file, `${JSON.stringify(owner)}
`, { mode: 0o600 });
      return {
        ...(allowHandoff ? {
          handoff(pid) {
            if (!Number.isInteger(pid) || pid <= 0) return;
            const nextOwner = { ...pidLockOwner(pid, processStartTimeMs(pid)), token: owner.token };
            replacePrivateTextFile(file, `${JSON.stringify(nextOwner)}
`);
          },
        } : {}),
        token: owner.token,
        release() { removePidLockOwnedBy(file, owner.token); },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const snapshot = readPidLockSnapshot(file);
      if (!snapshot) continue;
      const age = Date.now() - snapshot.info.mtimeMs;
      const identity = snapshot.owner ? inspectProcessInstance(snapshot.owner, { maxAgeMs: 5 * 60_000 }) : null;
      const definitelyStale = !snapshot.owner
        ? age >= 60_000
        : identity.reclaimable === true;
      if (!definitelyStale) return null;
      removePidLockSnapshot(file, snapshot);
    }
  }
  return null;
}

function pidLockOwner(pid, startedAtMs) {
  return {
    pid,
    token: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
    processStartedAt: Number.isFinite(startedAtMs) && startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
  };
}

function readPidLockSnapshot(file) {
  let info;
  try { info = lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("job lock must be a regular non-symbolic-link file");
  let owner = null;
  try {
    const parsed = JSON.parse(readBoundedFile(file, 1024).toString("utf8").trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
  }
  return { owner, info: pidLockIdentity(info) };
}

function removePidLockOwnedBy(file, token) {
  const snapshot = readPidLockSnapshot(file);
  if (!snapshot || snapshot.owner?.token !== token) return false;
  return removePidLockSnapshot(file, snapshot);
}

function removePidLockSnapshot(file, snapshot) {
  let current;
  try { current = lstatSync(file); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!samePidLockIdentity(snapshot.info, pidLockIdentity(current))) return false;
  if (snapshot.owner?.token) {
    const currentOwner = readPidLockSnapshot(file)?.owner;
    if (currentOwner?.token !== snapshot.owner.token) return false;
  }
  try { rmSync(file); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function pidLockIdentity(info) {
  return { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs) };
}

function samePidLockIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function replacePrivateTextFile(file, content) {
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  ownerOnlyFile(file);
}

function launchRunner(dir, recover = false, recoveryToken = "") {
  const args = [RUNNER_PATH, "--job-dir", dir];
  if (recover) args.push("--recover");
  const stdoutFile = join(dir, "runner.out.log");
  const stderrFile = join(dir, "runner.err.log");
  trimDiagnosticFile(stdoutFile);
  trimDiagnosticFile(stderrFile);
  let stdoutFd;
  let stderrFd;
  let child;
  try {
    stdoutFd = openPrivateAppendFile(stdoutFile);
    stderrFd = openPrivateAppendFile(stderrFile);
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: recoveryToken ? { ...process.env, MBM_RECOVERY_LOCK_TOKEN: recoveryToken } : process.env,
    });
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  ownerOnlyFile(stdoutFile);
  ownerOnlyFile(stderrFile);
  child.unref();
  return child.pid;
}


function readRunnerOwner(dir, fallback = {}) {
  try {
    const parsed = JSON.parse(readBoundedFile(join(dir, "runner.pid"), 1024).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...fallback };
    return { ...fallback, ...parsed };
  } catch {
    return { ...fallback };
  }
}

function runnerProcessIsCurrent(status, dir, { ownerOnly = false } = {}) {
  const fallback = ownerOnly ? status : {
    pid: Number(status?.runner_pid) || undefined,
    processStartedAt: status?.runner_process_started_at,
    startedAt: status?.started_at || status?.updated_at || status?.created_at,
  };
  const owner = readRunnerOwner(dir, fallback);
  if (!owner.pid) return false;
  const identity = inspectProcessInstance(owner, { maxAgeMs: Number.POSITIVE_INFINITY });
  return identity.current || (identity.alive && !identity.reclaimable);
}

function scrubFinishedPlan(dir, status) {
  if (PLAN_RETAINING_STATES.has(status.status)) return;
  const safeRm = (path) => {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      if (!["ENOENT", "EPERM", "EACCES"].includes(error.code)) throw error;
    }
  };
  safeRm(join(dir, "plan.json"));
  safeRm(join(dir, "runner.pid"));
  safeRm(join(dir, "recovery.lock"));
  safeRm(join(dir, "transition.lock"));
}

function reviewablePlan(plan) {
  return {
    version: plan.version,
    name: plan.name,
    workspace: plan.workspace,
    full_env: plan.full_env === true,
    resources: Object.fromEntries(Object.entries(plan.resources || {}).map(([name, value]) => [name, {
      kind: value.kind,
      size: value.size ?? null,
      mode: value.mode ?? null,
      allow_insecure_permissions: value.allowInsecurePermissions === true,
    }])),
    temporary_files: plan.temporary_files || [],
    steps: plan.steps || [],
    finally_steps: plan.finally_steps || [],
  };
}

function publicStatus(status) {
  return {
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    created_at: status.created_at,
    started_at: status.started_at ?? null,
    finished_at: status.finished_at ?? null,
    current_phase: status.current_phase ?? null,
    current_step: status.current_step ?? null,
    approval: status.approval ?? null,
    plan_sha256: status.plan_sha256 ?? null,
    cleanup_guarantee: status.cleanup_guarantee ?? "best-effort-finally-and-recovery",
    error_class: status.error_class ?? null,
    recovery_attempts: Number(status.recovery_attempts || 0),
  };
}

function atomicWriteJson(file, value, maxBytes) {
  ensureOwnerOnlyDir(dirname(file));
  const text = `${JSON.stringify(value, null, 2)}
`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes`);
  replaceFileAtomicallySync(file, text, { mode: 0o600 });
  ownerOnlyFile(file);
}

function readJson(file, maxBytes, label = "JSON") {
  let buffer;
  try { buffer = readBoundedFile(file, maxBytes); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} is unavailable (${resourceErrorClass(error)})`);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readRequiredJson(file, maxBytes, label) {
  const value = readJson(file, maxBytes, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable or invalid`);
  return value;
}

function readBoundedFile(file, maxBytes) {
  return readBoundedRegularFileSync(file, maxBytes);
}

function openPrivateAppendFile(file) {
  return openRegularFileSync(
    file,
    Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_APPEND),
    { label: "runner diagnostic path", mode: 0o600, chmod: 0o600 },
  ).fd;
}

function trimDiagnosticFile(file, maxBytes = 64 * 1024, keepBytes = 32 * 1024) {
  let fd;
  try {
    const opened = openRegularFileSync(file, fsConstants.O_RDWR, {
      label: "runner diagnostic path",
      chmod: 0o600,
    });
    fd = opened.fd;
    if (opened.info.size <= maxBytes) return;
    const length = Math.min(keepBytes, opened.info.size);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, opened.info.size - length + offset);
      if (!count) break;
      offset += count;
    }
    let tail = buffer.subarray(0, offset);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline < tail.length - 1) tail = tail.subarray(newline + 1);
    ftruncateSync(fd, 0);
    if (tail.length) writeSync(fd, tail, 0, tail.length, 0);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {
        // Descriptor close is best effort after the trim result is already determined.
      }
    }
  }
}

function resourceErrorClass(error) {
  const message = String(error?.message || error || "");
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/symbolic link/i.test(message)) return "symbolic_link_denied";
  if (/readable by group|permissions/i.test(message)) return "insecure_permissions";
  if (/exceeds/i.test(message)) return "size_limit";
  return "resource_unavailable";
}

function safeReadDir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}
