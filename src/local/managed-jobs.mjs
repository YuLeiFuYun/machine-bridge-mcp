import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnerOnlyDir, ownerOnlyFile } from "./state.mjs";
import { replaceFileSync } from "./atomic-fs.mjs";

const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const RESOURCE_TOKEN = /\{\{resource:([a-z][a-z0-9._-]{0,63})\}\}/g;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_JOB_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCES = 64;
const MAX_JOBS = 50;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_TEMPORARY_FILE_BYTES = 512 * 1024;
const MAX_RECOVERY_ATTEMPTS = 3;
const RUNNER_PATH = fileURLToPath(new URL("./job-runner.mjs", import.meta.url));
const ACTIVE_JOB_STATES = new Set(["queued", "running", "cleaning", "interrupted"]);
const PLAN_RETAINING_STATES = new Set(["staged", ...ACTIVE_JOB_STATES]);

export class ManagedJobManager {
  constructor({ jobRoot, workspace, policy, resources = {}, resourceStatePath = "", logger = console, recover = true }) {
    const jobRootInput = resolve(jobRoot);
    ensureOwnerOnlyDir(jobRootInput);
    this.jobRoot = realpathSync.native ? realpathSync.native(jobRootInput) : realpathSync(jobRootInput);
    const workspaceInput = resolve(workspace);
    this.workspace = realpathSync.native ? realpathSync.native(workspaceInput) : realpathSync(workspaceInput);
    this.policy = policy;
    this.resources = normalizeResourceRegistry(resources);
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.logger = logger;
    this.prune();
    if (recover) this.recoverInterruptedJobs();
  }

  status() {
    const jobs = this.list({ limit: MAX_JOBS }).jobs;
    return {
      active: jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status)).length,
      staged: jobs.filter((job) => job.status === "staged").length,
      retained: jobs.length,
      maximum: MAX_JOBS,
    };
  }

  resourceInfo() {
    const resources = this.currentResources();
    return {
      count: Object.keys(resources).length,
      names: Object.keys(resources).sort(),
      values_exposed: false,
    };
  }

  listResources() {
    const resources = [];
    for (const [name, resource] of Object.entries(this.currentResources()).sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true });
        resources.push({ name, kind: "file", available: true, size: inspected.size, mode: inspected.mode });
      } catch (error) {
        resources.push({ name, kind: "file", available: false, error_class: resourceErrorClass(error) });
      }
    }
    return { resources, count: resources.length, values_exposed: false, paths_exposed: false };
  }

  diagnoseStorage() {
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
    if (this.policy.allowWrite !== true) throw new Error("stage_job is disabled by daemon policy");
    return this.createJob(args, { launch: false });
  }

  start(args = {}) {
    this.assertEnabled("start_job");
    return this.createJob(args, { launch: true });
  }

  approve(args = {}, { localOperator = false } = {}) {
    if (!localOperator) this.assertEnabled("approve_job");
    const dir = this.jobDir(args.job_id);
    const statusFile = join(dir, "status.json");
    const status = readRequiredJson(statusFile, 256 * 1024, "job status");
    if (status.status !== "staged") throw new Error(`job is not staged: ${status.status}`);
    readRequiredJson(join(dir, "plan.json"), MAX_PLAN_BYTES, "job plan");
    status.status = "queued";
    status.updated_at = new Date().toISOString();
    status.approved_at = status.updated_at;
    status.approval = localOperator ? "local-operator" : "mcp";
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
      cleanup: {
        resource_copies: "best-effort",
        finally_steps: "best-effort-if-declared",
        restart_recovery: "best-effort-on-next-runtime-or-cli-start",
      },
    };
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
    this.prune();
    const limit = clampInt(args.limit, 20, 1, MAX_JOBS);
    const jobs = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      const dir = join(this.jobRoot, entry.name);
      this.reconcileStatus(dir);
      const status = readJson(join(dir, "status.json"), 256 * 1024);
      if (!status) continue;
      jobs.push(publicStatus(status));
    }
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { jobs: jobs.slice(0, limit), retained: jobs.length, maximum: MAX_JOBS };
  }

  read(args = {}) {
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
    const dir = this.jobDir(args.job_id);
    this.reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "job status");
    const plan = readJson(join(dir, "plan.json"), MAX_PLAN_BYTES);
    return {
      ...publicStatus(status),
      ...(plan ? { review_plan: reviewablePlan(plan) } : {}),
    };
  }

  cancel(args = {}) {
    const dir = this.jobDir(args.job_id);
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

  }

  currentResources() {
    if (!this.resourceStatePath) return this.resources;
    const state = readJson(this.resourceStatePath, 2 * 1024 * 1024);
    if (!state || typeof state !== "object" || Array.isArray(state)) return existsSync(this.resourceStatePath) ? {} : this.resources;
    return normalizeResourceRegistry(state.resources);
  }

  assertEnabled(tool) {
    if (this.policy.execMode !== "direct" && this.policy.execMode !== "shell") {
      throw new Error(`${tool} is disabled by daemon policy`);
    }
  }

  jobDir(value) {
    const id = String(value || "");
    if (!JOB_ID.test(id)) throw new Error("invalid job id");
    const dir = join(this.jobRoot, id);
    if (!existsSync(dir)) throw new Error("job not found or expired");
    return dir;
  }

  reconcileStatus(dir) {
    const file = join(dir, "status.json");
    const initial = readJson(file, 256 * 1024);
    if (!initial || !ACTIVE_JOB_STATES.has(initial.status)) {
      if (initial) scrubFinishedPlan(dir, initial);
      return;
    }
    const initialPid = Number(initial.runner_pid) || readRunnerPid(dir);
    if (Number.isInteger(initialPid) && initialPid > 0 && isPidAlive(initialPid)) return;
    const updated = Date.parse(initial.updated_at || initial.created_at || "");
    if (Number.isFinite(updated) && Date.now() - updated < 10_000) return;

    const recoveryLock = acquireRecoveryLock(dir);
    if (!recoveryLock) return;
    let handedOff = false;
    try {
      const status = readJson(file, 256 * 1024);
      if (!status || !ACTIVE_JOB_STATES.has(status.status)) return;
      const pid = Number(status.runner_pid) || readRunnerPid(dir);
      if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) return;
      const recoveryAttempts = Number(status.recovery_attempts || 0);
      if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        const now = new Date().toISOString();
        status.status = "recovery_exhausted";
        status.updated_at = now;
        status.finished_at = now;
        status.error_class = "recovery_exhausted";
        status.current_phase = null;
        status.current_step = null;
        atomicWriteJson(file, status, 256 * 1024);
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
        return;
      }
      status.status = "interrupted";
      status.updated_at = new Date().toISOString();
      status.finished_at = status.updated_at;
      status.error_class = "runner_interrupted";
      status.recovery_attempts = recoveryAttempts + 1;
      atomicWriteJson(file, status, 256 * 1024);
      rmSync(join(dir, "runtime"), { recursive: true, force: true });
      const runnerPid = launchRunner(dir, true);
      recoveryLock.handoff(runnerPid);
      handedOff = true;
    } finally {
      if (!handedOff) recoveryLock.release();
    }
  }

  recoverInterruptedJobs() {
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      this.reconcileStatus(join(this.jobRoot, entry.name));
    }
  }

  prune() {
    const entries = [];
    for (const entry of safeReadDir(this.jobRoot)) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      const dir = join(this.jobRoot, entry.name);
      const status = readJson(join(dir, "status.json"), 256 * 1024);
      const mtime = safeMtime(dir);
      if (!status) {
        const pid = readRunnerPid(dir);
        if ((!pid || !isPidAlive(pid)) && Date.now() - mtime > 60_000) {
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
  const jobs = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const status = readJson(join(dir, "status.json"), 256 * 1024);
    const pid = Number(status?.runner_pid) || readRunnerPid(dir);
    const runnerAlive = Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
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

export function validateResourceName(value) {
  const name = String(value || "").trim();
  if (!RESOURCE_NAME.test(name)) throw new Error("resource name must match [a-z][a-z0-9._-]{0,63}");
  return name;
}

export function inspectResourceFile(inputPath, { allowInsecurePermissions = false, includeHash = false } = {}) {
  const path = resolve(String(inputPath || ""));
  const canonical = realpathFile(path);
  const { buffer: content, info } = readBoundedFileWithInfo(canonical, MAX_RESOURCE_BYTES);
  if (process.platform !== "win32" && !allowInsecurePermissions && (info.mode & 0o077) !== 0) {
    throw new Error("resource file is readable by group or others; restrict permissions or use --allow-insecure-permissions");
  }
  return {
    kind: "file",
    path: canonical,
    size: info.size,
    mode: process.platform === "win32" ? null : `0${(info.mode & 0o777).toString(8)}`,
    updatedAt: new Date().toISOString(),
    allowInsecurePermissions: allowInsecurePermissions === true,
    ...(includeHash ? { sha256: createHash("sha256").update(content).digest("hex") } : {}),
  };
}

export function publicResourceRegistry(resources = {}) {
  const normalized = normalizeResourceRegistry(resources);
  return Object.fromEntries(Object.entries(normalized).map(([name, value]) => [name, {
    kind: value.kind,
    path: value.path,
    size: value.size ?? null,
    mode: value.mode ?? null,
    updatedAt: value.updatedAt ?? null,
    allowInsecurePermissions: value.allowInsecurePermissions === true,
  }]));
}

function validatePlan(args, context) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("job arguments must be an object");
  const allowed = new Set(["name", "steps", "finally_steps", "temporary_files"]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`job contains unknown field: ${key}`);
  const name = String(args.name || "managed job").trim().slice(0, 128) || "managed job";
  const steps = validateSteps(args.steps, "steps", context);
  const finallySteps = validateSteps(args.finally_steps || [], "finally_steps", context, true);
  const temporaryFiles = validateTemporaryFiles(args.temporary_files || []);
  if (!steps.length) throw new Error("steps must contain at least one step");
  return {
    version: 1,
    name,
    workspace: context.workspace,
    full_env: context.fullEnv,
    resources: referencedResources([...steps, ...finallySteps], context.resources),
    temporary_files: temporaryFiles,
    steps,
    finally_steps: finallySteps,
  };
}

function validateTemporaryFiles(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("temporary_files must contain 0-16 files");
  const seen = new Set();
  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`temporary_files[${index}] must be an object`);
    for (const key of Object.keys(item)) if (!["name", "content", "executable"].includes(key)) throw new Error(`temporary_files[${index}] contains unknown field: ${key}`);
    const name = validateResourceName(item.name);
    if (seen.has(name)) throw new Error(`duplicate temporary file name: ${name}`);
    seen.add(name);
    const content = boundedString(item.content, 256 * 1024, `temporary_files[${index}].content`);
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_TEMPORARY_FILE_BYTES) throw new Error(`temporary file contents exceed ${MAX_TEMPORARY_FILE_BYTES} bytes`);
    return { name, content, executable: item.executable === true };
  });
}

function validateSteps(value, label, context, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 16) {
    throw new Error(`${label} must contain ${allowEmpty ? "0-16" : "1-16"} steps`);
  }
  return value.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label}[${index}] must be an object`);
    const allowed = new Set(["name", "argv", "cwd", "env", "env_resources", "stdin", "stdin_resource", "timeout_seconds", "allow_failure", "capture_output"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`${label}[${index}] contains unknown field: ${key}`);
    if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 256) throw new Error(`${label}[${index}].argv must contain 1-256 strings`);
    const argv = input.argv.map((item) => boundedString(item, 16 * 1024, `${label}[${index}].argv`));
    if (Buffer.byteLength(JSON.stringify(argv)) > 64 * 1024) throw new Error(`${label}[${index}].argv exceeds 64 KiB`);
    const cwd = input.cwd === undefined ? context.workspace : resolveJobCwd(input.cwd, context.workspace, context.unrestrictedPaths);
    const env = validateEnv(input.env, `${label}[${index}].env`);
    const envResources = validateEnvResources(input.env_resources, `${label}[${index}].env_resources`);
    for (const key of Object.keys(envResources)) if (Object.prototype.hasOwnProperty.call(env, key)) throw new Error(`${label}[${index}] duplicates ${key} in env and env_resources`);
    const stdin = input.stdin === undefined ? null : boundedString(input.stdin, 256 * 1024, `${label}[${index}].stdin`);
    const stdinResource = input.stdin_resource === undefined ? null : validateResourceName(input.stdin_resource);
    if (stdin !== null && stdinResource !== null) throw new Error(`${label}[${index}] cannot combine stdin and stdin_resource`);
    return {
      name: String(input.name || basename(argv[0]) || `step ${index + 1}`).slice(0, 128),
      argv,
      cwd,
      env,
      env_resources: envResources,
      stdin,
      stdin_resource: stdinResource,
      timeout_seconds: clampInt(input.timeout_seconds, 600, 1, 3600),
      allow_failure: input.allow_failure === true,
      capture_output: input.capture_output === "discard" ? "discard" : "redacted",
    };
  });
}

function validateEnv(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${label} has too many entries`);
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`${label} contains invalid variable name: ${key}`);
    out[key] = boundedString(raw, 16 * 1024, `${label}.${key}`);
  }
  return out;
}

function validateEnvResources(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error(`${label} has too many entries`);
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`${label} contains invalid variable name: ${key}`);
    out[key] = validateResourceName(raw);
  }
  return out;
}

function referencedResources(steps, registry) {
  const names = new Set();
  for (const step of steps) {
    if (step.stdin_resource) names.add(step.stdin_resource);
    for (const name of Object.values(step.env_resources || {})) names.add(name);
    for (const value of [...step.argv, ...Object.values(step.env)]) {
      for (const match of String(value).matchAll(RESOURCE_TOKEN)) names.add(match[1]);
    }
  }
  if (names.size > MAX_RESOURCES) throw new Error(`job references more than ${MAX_RESOURCES} local resources`);
  const out = {};
  let totalBytes = 0;
  for (const name of names) {
    const resource = registry[name];
    if (!resource) throw new Error(`unknown local resource: ${name}`);
    const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true, includeHash: true });
    totalBytes += inspected.size;
    if (totalBytes > MAX_JOB_RESOURCE_BYTES) throw new Error(`job resources exceed ${MAX_JOB_RESOURCE_BYTES} bytes`);
    out[name] = { ...inspected, allowInsecurePermissions: resource.allowInsecurePermissions === true };
  }
  return out;
}

function normalizeResourceRegistry(resources) {
  const out = {};
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return out;
  for (const [rawName, rawValue] of Object.entries(resources).slice(0, MAX_RESOURCES)) {
    const name = validateResourceName(rawName);
    if (!rawValue || rawValue.kind !== "file" || typeof rawValue.path !== "string") continue;
    out[name] = {
      kind: "file",
      path: resolve(rawValue.path),
      size: Number.isFinite(Number(rawValue.size)) ? Number(rawValue.size) : null,
      mode: rawValue.mode ?? null,
      updatedAt: rawValue.updatedAt ?? null,
      allowInsecurePermissions: rawValue.allowInsecurePermissions === true,
    };
  }
  return out;
}

function resolveJobCwd(value, workspace, unrestrictedPaths) {
  const raw = boundedString(value, 4096, "cwd");
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
  const canonical = realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
  const info = statSync(canonical);
  if (!info.isDirectory()) throw new Error("managed job cwd is not a directory");
  if (!unrestrictedPaths) {
    const rel = relative(workspace, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("managed job cwd is outside the configured workspace");
  }
  return canonical;
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

function acquireRecoveryLock(dir) {
  const file = join(dir, "recovery.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      return {
        handoff(pid) {
          if (Number.isInteger(pid) && pid > 0) writeFileSync(file, `${pid}\n`, { mode: 0o600 });
        },
        release() { rmSync(file, { force: true }); },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0;
      try { owner = Number.parseInt(readBoundedFile(file, 64).toString("utf8").trim(), 10); } catch {}
      const age = Date.now() - safeMtime(file);
      if ((owner > 0 && isPidAlive(owner)) || age < 60_000) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function launchRunner(dir, recover = false) {
  const args = [RUNNER_PATH, "--job-dir", dir];
  if (recover) args.push("--recover");
  const stdoutFile = join(dir, "runner.out.log");
  const stderrFile = join(dir, "runner.err.log");
  trimDiagnosticFile(stdoutFile);
  trimDiagnosticFile(stderrFile);
  const stdoutFd = openSync(stdoutFile, "a", 0o600);
  const stderrFd = openSync(stderrFile, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  ownerOnlyFile(stdoutFile);
  ownerOnlyFile(stderrFile);
  child.unref();
  return child.pid;
}


function readRunnerPid(dir) {
  try {
    const value = Number.parseInt(readBoundedFile(join(dir, "runner.pid"), 64).toString("utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function scrubFinishedPlan(dir, status) {
  if (PLAN_RETAINING_STATES.has(status.status)) return;
  rmSync(join(dir, "plan.json"), { force: true });
  rmSync(join(dir, "runner.pid"), { force: true });
  rmSync(join(dir, "recovery.lock"), { force: true });
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
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes`);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  replaceFileSync(temp, file);
  ownerOnlyFile(file);
}

function readJson(file, maxBytes) {
  try { return JSON.parse(readBoundedFile(file, maxBytes).toString("utf8")); } catch { return null; }
}

function readRequiredJson(file, maxBytes, label) {
  const value = readJson(file, maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable or invalid`);
  return value;
}

function readBoundedFile(file, maxBytes) {
  return readBoundedFileWithInfo(file, maxBytes).buffer;
}

function readBoundedFileWithInfo(file, maxBytes) {
  const flags = Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(file, flags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("path is not a regular file");
    if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return { buffer: buffer.subarray(0, offset), info };
  } finally {
    closeSync(fd);
  }
}

function trimDiagnosticFile(file, maxBytes = 64 * 1024, keepBytes = 32 * 1024) {
  let fd;
  try {
    const flags = Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW || 0);
    fd = openSync(file, flags);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= maxBytes) return;
    const length = Math.min(keepBytes, info.size);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, info.size - length + offset);
      if (!count) break;
      offset += count;
    }
    let tail = buffer.subarray(0, offset);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline < tail.length - 1) tail = tail.subarray(newline + 1);
    closeSync(fd);
    fd = undefined;
    writeFileSync(file, tail, { mode: 0o600 });
  } catch {
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function realpathFile(path) {
  const input = resolve(path);
  const linkInfo = lstatSync(input);
  if (!linkInfo.isFile() && !linkInfo.isSymbolicLink()) throw new Error("resource path is not a regular file");
  return realpathSync.native ? realpathSync.native(input) : realpathSync(input);
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
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function safeMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function boundedString(value, maxBytes, label) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} must be a string without NUL bytes`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, min), max);
}
