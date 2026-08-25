import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { executionEnv } from "./shell.mjs";
import { attachChildProcessSettlement, childExitedBeforeTimeout } from "./child-process-settlement.mjs";
import { terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { removeOwnedJsonFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { currentProcessStartTimeMs, processState } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { managedJobCancellationRequested } from "./managed-job-cancellation.mjs";
import {
  clearManagedJobActiveChild, managedJobActiveChildFile, managedJobActiveChildRecoveryReady,
  publishManagedJobActiveChild, terminateManagedJobActiveChild,
} from "./managed-job-active-child.mjs";
import { assertManagedJobPlanIntegrity } from "./managed-job-plan-integrity.mjs";
import { createManagedJobResourceContext } from "./managed-job-resource-context.mjs";
import { managedJobResourcePathVariants, redactManagedJobOutput } from "./managed-job-output-redaction.mjs";
import {
  dependencyFailureDetails, ManagedJobDependencyError, managedJobRunnerDependencyState, waitForManagedJobDependencyGate,
} from "./managed-job-dependencies.mjs";
import { MacosIdleSleepAssertion } from "./macos-idle-sleep-assertion.mjs";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus, managedJobFinalStatus, persistManagedJobTerminal } from "./managed-job-terminal.mjs";
import { sanitizeLogText } from "./log.mjs";
import { confirmRunnerClaim } from "./managed-job-runner-claim.mjs";
import { ResourceCoordinator } from "./resource-admission.mjs";
import { acquireProcessResources, bindProcessResources, releaseProcessResources, releaseProcessResourcesQuietly } from "./resource-process-admission.mjs";
import { delegatedProcessCommand } from "./delegated-process-sandbox.mjs";

const RESOURCE_TOKEN = /\{\{resource:([a-z][a-z0-9._-]{0,63})\}\}/g;
const TEMP_TOKEN = /\{\{temp:([a-z][a-z0-9._-]{0,63})\}\}/g;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_JOB_CAPTURE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
const RECOVERY_LOCK_HANDOFF_WAIT_MS = 30_000;
const FATAL_IDENTITY_FIELDS = [
  "job_id", "name", "plan_sha256", "created_at", "approval", "owner_kind", "owner_account_id",
  "owner_account_version", "owner_client_id", "owner_family_id",
];

const options = parseArgs(process.argv.slice(2));
const jobDirInput = typeof options.jobDir === "string" ? options.jobDir.trim() : "";
if (!jobDirInput) throw new Error("--job-dir is required");
const jobDir = resolve(jobDirInput);
if (!MANAGED_JOB_ID.test(basename(jobDir))) throw new Error("--job-dir must name a managed job directory");
const recover = options.recover === true;
const recoveryLockToken = typeof process.env.MBM_RECOVERY_LOCK_TOKEN === "string" ? process.env.MBM_RECOVERY_LOCK_TOKEN : "";
const launchToken = typeof process.env.MBM_RUNNER_LAUNCH_TOKEN === "string" ? process.env.MBM_RUNNER_LAUNCH_TOKEN : "";
delete process.env.MBM_RECOVERY_LOCK_TOKEN;
delete process.env.MBM_RUNNER_LAUNCH_TOKEN;
const planFile = join(jobDir, "plan.json");
const statusFile = join(jobDir, "status.json");
const resultFile = join(jobDir, "result.json");
const cancelFile = join(jobDir, "cancel");
const runtimeDir = join(jobDir, "runtime");
const resourcesDir = join(runtimeDir, "resources");
const temporaryFilesDir = join(runtimeDir, "files");
const runnerPidFile = join(jobDir, "runner.pid");
const activeChildFile = managedJobActiveChildFile(jobDir);
const RUNNER_PROCESS_STARTED_AT = new Date(currentProcessStartTimeMs()).toISOString();
const resourceCoordinator = new ResourceCoordinator();

class JobCancelledError extends Error {
  constructor() {
    super("job cancellation requested");
    this.name = "JobCancelledError";
  }
}


let activeChild = null;
let activeChildCancellationAware = false;
let activeChildTermination = null;
let cancelRequested = false;
let runnerClaimConfirmed = false;
let jobIdleSleepAssertion = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => requestCancellation());
}

const initial = readJson(statusFile, MAX_STATUS_BYTES);
assertLaunchState(initial);
try {
  await confirmRunnerClaim({
    file: runnerPidFile, pid: process.pid, processStartedAt: RUNNER_PROCESS_STARTED_AT, launchToken,
  });
  if (initial.owner_kind === "account") {
    jobIdleSleepAssertion = new MacosIdleSleepAssertion({ logger: managedJobIdleSleepLogger() });
    jobIdleSleepAssertion.acquire();
  }
  if (recover) {
    await terminateManagedJobActiveChild(activeChildFile);
    await releaseRecoveryClaim();
  } else if (!managedJobActiveChildRecoveryReady(activeChildFile)) {
    throw new Error("managed job cannot start while prior active child ownership remains unsettled");
  }
  runnerClaimConfirmed = true;
  const plan = readJson(planFile, 1024 * 1024);
  assertManagedJobPlanIntegrity(plan, initial);
  await main(plan, initial);
} catch (error) {
  recordFatalRunnerError(error);
  process.exitCode = 1;
} finally {
  jobIdleSleepAssertion?.release();
}


async function releaseRecoveryClaim() {
  if (!/^[a-f0-9]{32}$/.test(recoveryLockToken)) throw new Error("recovery runner is missing its ownership token");
  const file = join(jobDir, "recovery.lock");
  const deadline = createMonotonicDeadline(RECOVERY_LOCK_HANDOFF_WAIT_MS);
  while (!deadline.expired()) {
    if (removeOwnedJsonFileSync(file, { pid: process.pid, token: recoveryLockToken })) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  throw new Error("recovery runner could not verify ownership of the recovery lock");
}

async function main(plan, initial) {
  const dependency = managedJobRunnerDependencyState(plan, initial, recover);
  const status = {
    ...initial,
    runner_pid: process.pid,
    runner_process_started_at: RUNNER_PROCESS_STARTED_AT,
    started_at: initial.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: dependency.status,
    current_phase: dependency.currentPhase,
    current_step: null,
    dependency_total: dependency.total,
    dependency_pending_count: dependency.pending,
    cleanup_guarantee: "best-effort-finally-and-recovery",
  };
  writeJson(statusFile, status, MAX_STATUS_BYTES);

  const mainResults = [];
  const cleanupResults = [];
  const captureBudget = { remaining: MAX_JOB_CAPTURE_BYTES };
  let mainError = null;
  let cleanupError = null;
  const resourceContext = createManagedJobResourceContext(() => {
    const value = materializeResources(plan.resources || {});
    value.temporaryPaths = materializeTemporaryFiles(plan.temporary_files || []);
    return value;
  });

  try {
    if (recover) {
      resourceContext.ensure();
    } else {
      await waitForManagedJobDependencyGate({
        jobRoot: dirname(jobDir),
        dependencyIds: dependency.dependencyIds,
        witnesses: Array.isArray(initial.dependency_witnesses) ? initial.dependency_witnesses : [],
        waiting: dependency.waiting,
        throwIfCancelled: () => { if (isCancellationRequested()) throw new JobCancelledError(); },
        updateStatus: (changes) => updateStatus(status, changes),
      });
      resourceContext.ensure();
      for (let index = 0; index < plan.steps.length; index += 1) {
        if (isCancellationRequested()) throw new JobCancelledError();
        updateStatus(status, { status: "running", current_phase: "steps", current_step: index });
        const result = await runStep(plan.steps[index], index, "steps", plan, resourceContext.value, true, captureBudget, status);
        mainResults.push(result);
        if (result.timed_out && !plan.steps[index].allow_failure) throw new Error(`step ${index + 1} timed out`);
        if (result.code !== 0 && !plan.steps[index].allow_failure) throw new Error(`step ${index + 1} exited ${result.code}`);
      }
    }
  } catch (error) {
    mainError = error;
  } finally {
    updateStatus(status, { status: "cleaning", current_phase: recover ? "recovery-cleanup" : "finally_steps", current_step: null });
    try {
      if (plan.finally_steps.length > 0 && !resourceContext.attempted) resourceContext.ensure();
      for (let index = 0; index < plan.finally_steps.length; index += 1) {
        updateStatus(status, { status: "cleaning", current_phase: recover ? "recovery-cleanup" : "finally_steps", current_step: index });
        const result = await runStep(plan.finally_steps[index], index, "finally_steps", plan, resourceContext.value, false, captureBudget, status);
        cleanupResults.push(result);
        if (result.timed_out && !plan.finally_steps[index].allow_failure && !cleanupError) cleanupError = new Error(`cleanup step ${index + 1} timed out`);
        if (result.code !== 0 && !plan.finally_steps[index].allow_failure && !cleanupError) cleanupError = new Error(`cleanup step ${index + 1} exited ${result.code}`);
      }
    } catch (error) {
      cleanupError ||= error;
    }
  }

  let cancellationMarker = false;
  try { cancellationMarker = managedJobCancellationRequested(cancelFile); }
  catch (error) {
    mainError = mainError
      ? new AggregateError([mainError, error], "managed job failed and cancellation state could not be verified")
      : error;
  }
  const cancelled = mainError instanceof JobCancelledError || cancellationMarker;
  const finalStatus = managedJobFinalStatus({ recover, cancelled, mainError, cleanupError });
  if (cleanupError && classifyError(cleanupError) === "resource_error") {
    const stage = cleanupError?.details?.admission_reason || cleanupError?.details?.reason || cleanupError?.code
      || (/resource lease/i.test(String(cleanupError?.message || "")) ? "resource_lease" : "resource_operation");
    try { process.stderr.write(`managed job cleanup infrastructure failure: stage=${sanitizeLogText(stage, 64)}\n`); }
    catch { /* Last-resort diagnostics must not replace the managed job's primary failure. */ }
  }

  const result = {
    job_id: status.job_id,
    name: plan.name,
    status: finalStatus,
    recovered: recover,
    steps: mainResults,
    finally_steps: cleanupResults,
    error_class: classifyError(mainError),
    cleanup_error_class: classifyError(cleanupError),
    ...(dependencyFailureDetails(mainError) ? { dependency_failure: dependencyFailureDetails(mainError) } : {}),
    capture_limit_bytes: MAX_JOB_CAPTURE_BYTES,
    capture_remaining_bytes: captureBudget.remaining,
    finished_at: new Date().toISOString(),
  };
  const terminal = persistManagedJobTerminal({
    statusFile, resultFile,
    artifacts: [runtimeDir, planFile, runnerPidFile, cancelFile],
    status: { ...status, runner_pid: process.pid, runner_process_started_at: RUNNER_PROCESS_STARTED_AT },
    result, writeJson,
    removeFile: (file) => rmSync(file, { recursive: true, force: true }),
    maxStatusBytes: MAX_STATUS_BYTES, maxResultBytes: MAX_RESULT_BYTES,
  });
  Object.assign(status, terminal.status);
  reportTerminalPersistenceFailure(terminal);
}

function assertLaunchState(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("job status is unavailable or invalid");
  const expected = recover ? "interrupted" : "queued";
  if (status.status !== expected) throw new Error(`runner cannot start job in status: ${status.status}`);
  if (status.approval !== "mcp") throw new Error("runner cannot start a managed job without direct execution authority");
}

function recordFatalRunnerError(error) {
  const now = new Date().toISOString();
  try {
    process.stderr.write(`managed job runner fatal: error_class=${classifyError(error)} message=${sanitizeLogText(error?.message || error, 512)}\n`);
  } catch { /* Last-resort diagnostics must not prevent terminal-state recovery. */ }
  if (!runnerClaimConfirmed) {
    reportFatalRecordSkipped("runner_claim_unconfirmed");
    return;
  }
  let status;
  try { status = readJson(statusFile, MAX_STATUS_BYTES); }
  catch (stateError) {
    reportFatalRecordSkipped(classifyError(stateError));
    return;
  }
  if (!fatalRunnerStatusIsCurrent(status, initial)) {
    reportFatalRecordSkipped("state_integrity");
    return;
  }
  const finalStatus = recover ? "recovery_failed" : "runner_failed";
  const result = {
    job_id: status.job_id ?? null,
    name: status.name ?? "managed job",
    status: finalStatus,
    recovered: recover,
    steps: [],
    finally_steps: [],
    error_class: classifyError(error),
    cleanup_error_class: recover ? classifyError(error) : null,
    finished_at: now,
  };
  const terminal = persistManagedJobTerminal({
    statusFile, resultFile,
    artifacts: [runtimeDir, planFile, runnerPidFile, cancelFile],
    status: {
      ...status,
      runner_pid: process.pid,
      runner_process_started_at: RUNNER_PROCESS_STARTED_AT,
      cleanup_guarantee: "best-effort-finally-and-recovery",
    },
    result, writeJson,
    removeFile: (file) => rmSync(file, { recursive: true, force: true }),
    maxStatusBytes: MAX_STATUS_BYTES, maxResultBytes: MAX_RESULT_BYTES,
  });
  reportTerminalPersistenceFailure(terminal);
}

function fatalRunnerStatusIsCurrent(status, accepted) {
  if (!status || typeof status !== "object" || Array.isArray(status)
      || !accepted || typeof accepted !== "object" || Array.isArray(accepted)) return false;
  if (isTerminalManagedJobStatus(status.status) || !ACTIVE_JOB_STATES.has(status.status)) return false;
  if (status.job_id !== basename(jobDir) || FATAL_IDENTITY_FIELDS.some((field) => status[field] !== accepted[field])) return false;
  const runnerPid = Number(status.runner_pid || 0);
  const acceptedPid = Number(accepted.runner_pid || 0);
  if (runnerPid && runnerPid !== process.pid && runnerPid !== acceptedPid) return false;
  const runnerStartedAt = String(status.runner_process_started_at || "");
  const acceptedStartedAt = String(accepted.runner_process_started_at || "");
  return !runnerStartedAt || runnerStartedAt === RUNNER_PROCESS_STARTED_AT || runnerStartedAt === acceptedStartedAt;
}

function reportFatalRecordSkipped(reason) {
  try { process.stderr.write(`managed job fatal terminal record skipped: reason=${sanitizeLogText(reason, 64)}\n`); }
  catch { /* A closed diagnostic stream is irrelevant to the already-decided state transition. */ }
}

function reportTerminalPersistenceFailure(terminal) {
  if (terminal.statusPersisted && terminal.artifactsScrubbed && !terminal.statusErrorClass) return;
  const fields = [
    `status_persisted=${terminal.statusPersisted}`,
    `result_persisted=${terminal.resultPersisted}`,
    `artifacts_scrubbed=${terminal.artifactsScrubbed}`,
    `status_error=${terminal.statusErrorClass || "none"}`,
    `result_error=${terminal.resultErrorClass || "none"}`,
    `cleanup_error=${terminal.cleanupErrorClass || "none"}`,
  ];
  try { process.stderr.write(`managed job terminal persistence incomplete: ${fields.join(" ")}\n`); }
  catch { /* Persistence outcome is authoritative even if its fallback diagnostic cannot be written. */ }
}

function managedJobIdleSleepLogger() {
  return { event(_level, _name, fields) {
    try { process.stderr.write(`managed job idle-sleep assertion unavailable: error_class=${sanitizeLogText(fields?.error_class || "unknown", 64)}\n`); }
    catch { /* Auxiliary power diagnostics must not replace managed-job settlement. */ }
  } };
}

async function runStep(step, index, phase, plan, resourceContext, cancellationAware, captureBudget, status) {
  const argv = step.argv.map((value) => substitute(value, plan, resourceContext));
  const envOverrides = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, substitute(value, plan, resourceContext)]));
  const envResourceValues = Object.fromEntries(Object.entries(step.env_resources || {}).map(([key, name]) => [key, resourceEnvValue(name, resourceContext.bytes)]));
  const env = {
    ...executionEnv(plan.workspace, { fullEnv: plan.full_env === true, runtimeDir }),
    ...envOverrides,
    ...envResourceValues,
  };
  const input = step.stdin_resource
    ? readResourceBytes(step.stdin_resource, resourceContext.paths)
    : step.stdin === null || step.stdin === undefined
      ? null
      : Buffer.from(step.stdin, "utf8");
  const started = performance.now();
  const raw = await spawnStep(argv, {
    cwd: step.cwd,
    env,
    input,
    timeoutMs: Number(step.timeout_seconds) * 1000,
    cancellationAware,
    captureOutput: step.capture_output !== "discard",
    captureBudget,
    resourcePriority: plan?.execution_priority === "interactive" ? "interactive" : "background",
    delegatedProcess: plan?.delegated_process === true,
    workspace: plan.workspace,
    onAdmissionStart: () => updateStatus(status, {
      status: phase === "steps" ? "running" : "cleaning",
      current_phase: "resource_admission",
      current_step: index,
    }),
    onAdmissionComplete: () => updateStatus(status, {
      status: phase === "steps" ? "running" : "cleaning",
      current_phase: phase === "finally_steps" && recover ? "recovery-cleanup" : phase,
      current_step: index,
    }),
  });
  return {
    index,
    phase,
    name: step.name,
    command: basename(argv[0]),
    code: raw.code,
    signal: raw.signal,
    timed_out: raw.timedOut,
    duration_ms: performance.now() - started,
    resource_admission_ms: raw.resourceAdmissionMs,
    stdout: step.capture_output === "discard" ? "" : redactManagedJobOutput(raw.stdout, resourceContext, runtimeDir),
    stderr: step.capture_output === "discard" ? "" : redactManagedJobOutput(raw.stderr, resourceContext, runtimeDir),
    output_discarded: step.capture_output === "discard",
    stdout_truncated_bytes: step.capture_output === "discard" ? 0 : raw.stdoutTruncated,
    stderr_truncated_bytes: step.capture_output === "discard" ? 0 : raw.stderrTruncated,
    stdout_omitted_bytes: step.capture_output === "discard" ? raw.stdoutTruncated : 0,
    stderr_omitted_bytes: step.capture_output === "discard" ? raw.stderrTruncated : 0,
  };
}

async function spawnStep(argv, {
  cwd, env, input, timeoutMs, cancellationAware, captureOutput, captureBudget,
  resourcePriority = "background", delegatedProcess = false, workspace = "",
  onAdmissionStart = null, onAdmissionComplete = null,
}) {
  if (cancellationAware && isCancellationRequested()) throw new JobCancelledError();
  const admissionStarted = performance.now();
  onAdmissionStart?.();
  let admitted;
  let resourceAdmissionMs = 0;
  try {
    admitted = await acquireProcessResources(resourceCoordinator, argv[0], argv.slice(1), env, {
      cwd, priority: resourcePriority, waitMs: relayContract.maximumManagedJobResourceAdmissionWaitMs,
      cancelCheck: () => { if (cancellationAware && isCancellationRequested()) throw new JobCancelledError(); },
    });
    onAdmissionComplete?.();
    resourceAdmissionMs = performance.now() - admissionStarted;
  } catch (error) {
    if (admitted?.lease) {
      try { await releaseProcessResources(admitted.lease); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "managed job admission status update and resource lease cleanup both failed");
      }
    }
    throw error;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      const launch = delegatedProcess
        ? delegatedProcessCommand({
            command: admitted.command,
            args: admitted.args,
            workspace,
            runtimeDir,
            forceDelegated: true,
          })
        : { command: admitted.command, args: admitted.args };
      // This synchronous marker read is the launch decision point. A cancellation visible here
      // prevents spawn; cancellation that becomes visible afterward is post-dispatch termination.
      if (cancellationAware && isCancellationRequested()) throw new JobCancelledError();
      child = spawn(launch.command, launch.args, {
        cwd, env: admitted.environment, detached: process.platform !== "win32", windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      void releaseProcessResourcesQuietly(admitted.lease).then(() => rejectPromise(error));
      return;
    }
    activeChild = child;
    activeChildCancellationAware = cancellationAware;
    let terminationSettlement = null;
    const terminateAndSettle = () => {
      if (terminationSettlement) return terminationSettlement;
      terminationSettlement = new Promise((resolveTermination) => {
        try {
          terminateProcessTreeWithEscalation(child, {
            onTerminationSettled: resolveTermination,
          });
        } catch {
          resolveTermination();
        }
      });
      return terminationSettlement;
    };
    activeChildTermination = terminateAndSettle;
    let resourceBindError = null; let childError = null; let activeChildClaim = null;
    try {
      activeChildClaim = publishManagedJobActiveChild(activeChildFile, child);
    } catch (error) {
      childError = error;
      void terminateAndSettle();
    }
    const resourceBinding = bindProcessResources(admitted.lease, child).catch((error) => {
      resourceBindError = error;
      void terminateAndSettle();
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = 0;
    let stderrTruncated = 0;
    let timedOut = false;
    let closed = false;
    const timer = setTimeout(() => {
      if (childExitedBeforeTimeout({ exitCode: child.exitCode, signalCode: child.signalCode, processState: processState(child.pid) })) {
        settlement.onExit(child.exitCode, child.signalCode);
        return;
      }
      timedOut = true;
      void terminateAndSettle();
    }, timeoutMs);
    timer.unref?.();
    const cancellationPoll = setInterval(() => {
      if (!cancellationAware || !isCancellationRequested()) return;
      requestCancellation();
    }, 250);
    cancellationPoll.unref?.();

    child.stdout.on("data", (chunk) => {
      if (!captureOutput) { stdoutTruncated += chunk.length; return; }
      const next = appendLimited(stdout, chunk, MAX_OUTPUT_BYTES, captureBudget);
      stdout = next.buffer;
      stdoutTruncated += next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      if (!captureOutput) { stderrTruncated += chunk.length; return; }
      const next = appendLimited(stderr, chunk, MAX_OUTPUT_BYTES, captureBudget);
      stderr = next.buffer;
      stderrTruncated += next.truncated;
    });
    const settlement = attachChildProcessSettlement(child, {
      onSettle(code, signal) {
        finish(() => {
          if (resourceBindError) { rejectPromise(resourceBindError); return; }
          if (childError) { rejectPromise(childError); return; }
          if (cancellationAware && isCancellationRequested()) { rejectPromise(new JobCancelledError()); return; }
          resolvePromise({
            code: Number.isInteger(code) ? code : 1,
            signal: signal ? String(signal) : null,
            timedOut, resourceAdmissionMs, stdout, stderr, stdoutTruncated, stderrTruncated,
          });
        });
      },
    });
    child.on("error", (error) => { childError ||= error; });
    if (input && input.length) child.stdin.end(input);
    else child.stdin.end();

    function finish(callback) {
      if (closed) return;
      closed = true;
      settlement.cancel();
      clearTimeout(timer);
      clearInterval(cancellationPoll);
      activeChild = null;
      activeChildCancellationAware = false;
      activeChildTermination = null;
      void resourceBinding
        .then(() => terminationSettlement || undefined)
        .then(() => releaseProcessResources(admitted.lease))
        .then(() => { if (activeChildClaim) clearManagedJobActiveChild(activeChildFile, activeChildClaim); })
        .then(callback, rejectPromise);
    }
  });
}

function materializeResources(resources) {
  mkdirSync(resourcesDir, { recursive: true, mode: 0o700 });
  chmodSync(resourcesDir, 0o700);
  const paths = {};
  const sourcePaths = {};
  const bytes = {};
  const redactions = {};
  for (const [name, resource] of Object.entries(resources)) {
    if (!resource || resource.kind !== "file") throw new Error(`unsupported resource kind: ${name}`);
    const data = readBoundedFile(resource.path, MAX_RESOURCE_BYTES);
    const actualHash = createHash("sha256").update(data).digest("hex");
    if (!resource.sha256 || actualHash !== resource.sha256) throw new Error(`local resource changed after job submission: ${name}`);
    const target = join(resourcesDir, name);
    writeFileSync(target, data, { mode: 0o600, flag: "wx" });
    paths[name] = target;
    sourcePaths[name] = [...new Set([
      ...managedJobResourcePathVariants(resource.path),
      ...(Array.isArray(resource.pathAliases) ? resource.pathAliases.flatMap(managedJobResourcePathVariants) : []),
    ])].sort((left, right) => right.length - left.length);
    bytes[name] = data;
    const patterns = [];
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.length > 0) patterns.push(text);
      const trimmed = text.replace(/[\r\n]+$/, "");
      if (trimmed.length > 0 && trimmed !== text) patterns.push(trimmed);
    } catch { /* Binary resources still use byte-level base64/hex redaction below. */ }
    if (data.length > 0 && data.length <= 64 * 1024) {
      patterns.push(data.toString("base64"), data.toString("hex"));
    }
    redactions[name] = [...new Set(patterns.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  }
  return { paths, sourcePaths, bytes, redactions };
}

function materializeTemporaryFiles(files) {
  mkdirSync(temporaryFilesDir, { recursive: true, mode: 0o700 });
  chmodSync(temporaryFilesDir, 0o700);
  const paths = {};
  for (const file of files) {
    const target = join(temporaryFilesDir, file.name);
    writeFileSync(target, file.content, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
    paths[file.name] = target;
  }
  return paths;
}

function readResourceBytes(name, paths) {
  const path = paths[name];
  if (!path) throw new Error(`resource was not materialized: ${name}`);
  return readBoundedFile(path, MAX_RESOURCE_BYTES);
}

function resourceEnvValue(name, bytes) {
  const data = bytes[name];
  if (!Buffer.isBuffer(data)) throw new Error(`resource was not materialized: ${name}`);
  if (data.length > 64 * 1024) throw new Error(`resource is too large for an environment variable: ${name}`);
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch {
    throw new Error(`resource is not UTF-8 text for environment injection: ${name}`);
  }
  value = value.replace(/[\r\n]+$/, "");
  if (value.includes("\0")) throw new Error(`resource contains a NUL byte and cannot be used as an environment variable: ${name}`);
  return value;
}

function substitute(value, plan, context) {
  return String(value)
    .replaceAll("{{job:runtime}}", runtimeDir)
    .replaceAll("{{job:workspace}}", plan.workspace)
    .replace(RESOURCE_TOKEN, (_, name) => {
      const path = context.paths[name];
      if (!path) throw new Error(`resource was not materialized: ${name}`);
      return path;
    })
    .replace(TEMP_TOKEN, (_, name) => {
      const path = context.temporaryPaths[name];
      if (!path) throw new Error(`temporary file was not materialized: ${name}`);
      return path;
    });
}

function updateStatus(status, changes) {
  Object.assign(status, changes, { runner_pid: process.pid, runner_process_started_at: RUNNER_PROCESS_STARTED_AT, updated_at: new Date().toISOString() });
  writeJson(statusFile, status, MAX_STATUS_BYTES);
}

function requestCancellation() {
  cancelRequested = true;
  if (!activeChild || !activeChildCancellationAware) return;
  void activeChildTermination?.();
}

function isCancellationRequested() {
  return cancelRequested || managedJobCancellationRequested(cancelFile);
}

function appendLimited(current, chunk, limit, budget) {
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
  const streamRemaining = Math.max(0, limit - current.length);
  const jobRemaining = Math.max(0, Number(budget?.remaining || 0));
  const acceptedLength = Math.min(input.length, streamRemaining, jobRemaining);
  const accepted = input.subarray(0, acceptedLength);
  if (budget) budget.remaining = Math.max(0, jobRemaining - acceptedLength);
  return {
    buffer: accepted.length ? (current.length ? Buffer.concat([current, accepted]) : Buffer.from(accepted)) : current,
    truncated: input.length - accepted.length,
  };
}

function writeJson(file, value, maxBytes) {
  const text = `${JSON.stringify(value, null, 2)}
`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`job JSON exceeds ${maxBytes} bytes`);
  replaceFileAtomicallySync(file, text, { mode: 0o600 });
}

function readJson(file, maxBytes) {
  return JSON.parse(readBoundedRegularFileSync(file, maxBytes, "managed job runner state", {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  }).toString("utf8"));
}

function readBoundedFile(file, maxBytes) {
  return readBoundedRegularFileSync(file, maxBytes);
}

function classifyError(error) {
  if (!error) return null;
  if (error instanceof JobCancelledError) return "cancelled";
  if (error instanceof ManagedJobDependencyError) return error.errorClass;
  const message = String(error?.message || error);
  if (/timed out/i.test(message)) return "timeout";
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/resource/i.test(message)) return "resource_error";
  return "execution_failed";
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--recover") out.recover = true;
    else if (value === "--job-dir") out.jobDir = argv[++index];
    else throw new Error(`unknown runner option: ${value}`);
  }
  return out;
}
