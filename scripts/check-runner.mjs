import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { terminateProcessTreeAndWait, terminateProcessTreeWithEscalation } from "../src/local/process-tree.mjs";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { releaseDiagnostic } from "./release-diagnostic.mjs";
import { verificationChildEnvironment } from "./verification-environment.mjs";

const FAILURE_OUTPUT_BYTES_PER_STREAM = 64 * 1024;
const MAX_VERIFICATION_CONCURRENCY = 16;
const DEFAULT_TASK_TIMEOUT_MS = 180_000;
const TASK_KILL_GRACE_MS = 5_000;
const TASK_TIMEOUT_OVERRIDES = new Map([
  ["cf-project:test", 400_000],
  ["coverage:test", 400_000],
  ["install:test", 400_000],
  ["self-test", 300_000],
  ["cli-entrypoint:test", 300_000],
  ["worker:integration-test", 300_000],
  ["stdio:integration-test", 300_000],
  ["browser-bridge:test", 300_000],
  ["browser-page-automation:test", 300_000],
  ["oauth-browser:test", 300_000],
  ["managed-jobs:test", 500_000],
]);
const DIRECT_NODE_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const SPARSE_PROGRESS_TASKS = new Map([
  ["self-test", ["local self-test phase started:", "local self-test phase completed:"]],
]);

export const COVERAGE_FIXTURE_TESTS = Object.freeze([
  "tests/policy-test.mjs",
  "tests/runtime-infrastructure-test.mjs",
  "tests/control-plane-resilience-test.mjs",
  "tests/process-output-continuation-test.mjs",
  "tests/process-nonreplayable-test.mjs",
  "tests/runtime-boundaries-test.mjs",
  "tests/git-commit-test.mjs",
  "tests/privacy-test.mjs",
  "tests/worker-runtime-infrastructure-test.mjs",
  "tests/mcp-protocol-test.mjs",
  "tests/mcp-controller-test.mjs",
  "tests/mcp-response-proxy-test.mjs",
  "tests/tool-argument-validation-test.mjs",
  "tests/worker-oauth-controller-test.mjs",
  "tests/logging-structure-test.mjs",
  "tests/runtime-handler-matrix-test.mjs",
  "tests/cli-entrypoint-test.mjs",
  "tests/cli-service-test.mjs",
  "tests/service-restart-handoff-test.mjs",
  "tests/service-platform-test.mjs",
  "tests/process-lock-test.mjs",
  "tests/secure-file-test.mjs",
  "tests/worker-secret-file-test.mjs",
  "tests/atomic-fs-test.mjs",
  "tests/coverage-range-merge-test.mjs",
  "tests/coverage-generation-test.mjs",
  "tests/check-runner-test.mjs",
  "tests/full-verification-receipt-test.mjs",
  "tests/resource-admission-test.mjs",
  "tests/resource-build-root-test.mjs",
  "tests/runtime-activation-test.mjs",
  "tests/prerelease-activation-test.mjs",
  "tests/release-publication-guard-test.mjs",
  "tests/local-self-test.mjs",
  "tests/numbers-test.mjs",
  "tests/records-test.mjs",
  "tests/project-metadata-test.mjs",
  "tests/state-inventory-test.mjs",
  "tests/state-root-retirement-test.mjs",
  "tests/worker-deployment-test.mjs",
  "tests/hardened-npm-test.mjs",
  "tests/wrangler-toolchain-test.mjs",
  "tests/agent-context-test.mjs",
  "tests/agent-workflows-test.mjs",
  "tests/affected-checks-test.mjs",
  "tests/fixtures/agent-audit/regression.mjs",
  "tests/fixtures/agent-audit/guidance.mjs",
  "tests/agent-boundaries-test.mjs",
  "tests/capability-ranking-test.mjs",
  "tests/execution-routing-test.mjs",
  "tests/browser-broker-auth-test.mjs",
  "tests/browser-pairing-launch-test.mjs",
  "tests/browser-bridge-test.mjs",
  "tests/browser-request-settlement-test.mjs",
  "tests/browser-operation-service-test.mjs",
  "tests/browser-devtools-input-test.mjs",
  "tests/browser-devtools-observation-test.mjs",
  "tests/browser-service-worker-test.mjs",
  "tests/app-automation-test.mjs",
  "tests/macos-background-input-test.mjs",
  "tests/computer-use-application-observation-test.mjs",
  "tests/browser-computer-observation-test.mjs",
  "tests/computer-use-test.mjs",
  "tests/computer-use-result-budget-test.mjs",
  "tests/relay-connection-test.mjs",
  "tests/relay-http-fallback-test.mjs",
  "tests/managed-job-boundary-test.mjs",
  "tests/managed-job-terminal-maintenance-test.mjs",
  "tests/managed-jobs-test.mjs",
  "tests/account-admin-test.mjs",
  "tests/monotonic-deadline-test.mjs",
  "tests/device-auth-test.mjs",
  "tests/operation-authorization-test.mjs",
  "tests/security-audit-log-test.mjs",
  "tests/delegated-process-sandbox-test.mjs",
  "tests/dpop-test.mjs",
  "tests/worker-security-boundaries-test.mjs",
  "tests/ssh-key-test.mjs"
]);

export async function runVerificationPlan(options) {
  const controller = new AbortController();
  const signal = options.signal || controller.signal;
  const onInterrupt = () => controller.abort("SIGINT");
  const onTerminate = () => controller.abort("SIGTERM");
  if (!options.signal) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  try { return await executeVerificationPlan({ ...options, signal }); }
  finally {
    if (!options.signal) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
}

async function executeVerificationPlan(options) {
  const {
    mode,
    tasks,
    npmCli,
    cwd = process.cwd(),
    env = process.env,
    verbose = false,
    stdout = process.stdout,
    stderr = process.stderr,
    spawnProcess = spawn,
    concurrency = 1,
    parallelTaskNames = new Set(),
    packageScripts = null,
    taskEnvironments = null,
    taskTimeouts = null,
    signal,
  } = options;
  if (!npmCli) throw new Error("check runner must run through npm so npm_execpath is available");
  const workerCount = normalizeConcurrency(concurrency);
  const parallel = parallelTaskNames instanceof Set ? parallelTaskNames : new Set(parallelTaskNames || []);
  const planStartedAt = performance.now();
  stdout.write(`running ${mode} verification plan (${tasks.length} tasks; up to ${workerCount} parallel)\n`);
  const skipped = [];

  let index = 0;
  while (index < tasks.length) {
    if (!parallel.has(tasks[index]) || workerCount === 1) {
      const failure = await executeTask({ index, tasks, npmCli, cwd, env, verbose, stdout, spawnProcess, packageScripts, taskEnvironments, taskTimeouts, skipped, signal });
      if (failure) throwVerificationFailure(failure, stderr);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < tasks.length && parallel.has(tasks[end])) end += 1;
    const failure = await executeConcurrentRange({
      start: index,
      end,
      tasks,
      npmCli,
      cwd,
      env,
      verbose,
      stdout,
      spawnProcess,
      concurrency: workerCount,
      packageScripts,
      taskEnvironments,
      taskTimeouts,
      skipped,
      signal,
    });
    if (failure) throwVerificationFailure(failure, stderr);
    index = end;
  }

  const totalSeconds = ((performance.now() - planStartedAt) / 1000).toFixed(1);
  // A skip is not a pass. Report the exact counts so a green plan cannot hide an
  // unexercised task; callers that persist evidence receive the same list.
  const passed = tasks.length - skipped.length;
  stdout.write(`\n${mode} verification plan passed in ${totalSeconds}s (${passed} passed${skipped.length ? `, ${skipped.length} skipped` : ""})\n`);
  for (const entry of skipped) stdout.write(`  skipped ${entry.task}: ${entry.reason}\n`);
  return { skipped: skipped.map((entry) => ({ ...entry })) };
}

async function executeConcurrentRange(options) {
  const { start, end, concurrency } = options;
  let nextIndex = start;
  const failures = [];

  async function worker() {
    while (!failures.length) {
      const index = nextIndex;
      if (index >= end) return;
      nextIndex += 1;
      const failure = await executeTask({ ...options, index });
      if (failure) failures.push(failure);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, end - start) }, () => worker());
  await Promise.all(workers);
  return failures.sort((a, b) => a.index - b.index)[0] || null;
}

async function executeTask({ index, tasks, npmCli, cwd, env, verbose, stdout, spawnProcess, packageScripts, taskEnvironments, taskTimeouts = null, skipped = null, signal }) {
  const task = tasks[index];
  const invocation = taskInvocation(task, packageScripts, npmCli, cwd, env, taskEnvironments);
  const taskStartedAt = performance.now();
  stdout.write(`[${index + 1}/${tasks.length}] ${invocation.label}\n`);
  const result = await runTask({
    invocation,
    cwd,
    verbose,
    spawnProcess,
    progressOutput: stdout,
    progressPrefixes: SPARSE_PROGRESS_TASKS.get(task),
    timeoutMs: taskTimeoutMs(task, taskTimeouts),
    signal,
  });
  const elapsedSeconds = ((performance.now() - taskStartedAt) / 1000).toFixed(1);
  if (result.error || result.code !== 0) return { index, task, elapsedSeconds, result };
  const skip = skipReason(result.stdout);
  if (skip) {
    stdout.write(`[${index + 1}/${tasks.length}] skipped ${task}: ${skip}\n`);
    skipped?.push({ task, reason: skip });
    return null;
  }
  stdout.write(`[${index + 1}/${tasks.length}] completed ${task} in ${elapsedSeconds}s\n`);
  return null;
}

function skipReason(output) {
  const text = typeof output?.text === "function" ? output.text() : "";
  const prefix = "MBM_TEST_SKIP:";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim().slice(0, 300);
  }
  return "";
}

function taskTimeoutMs(task, taskTimeouts = null) {
  // Precedence: the plan's declared budget (workflow bundle) wins; the built-in table is
  // only a fallback for tasks the plan does not cover.
  const override = taskTimeouts instanceof Map
    ? taskTimeouts.get(task)
    : taskTimeouts?.[task];
  if (Number.isInteger(override) && override > 0) return override;
  return TASK_TIMEOUT_OVERRIDES.get(task) || DEFAULT_TASK_TIMEOUT_MS;
}

function throwVerificationFailure(failure, stderr) {
  const { task, elapsedSeconds, result } = failure;
  stderr.write(`verification task failed after ${elapsedSeconds}s: ${task}\n`);
  emitFailureDiagnostics(result, stderr);
  if (result.error) {
    if (!Number.isInteger(result.error.exitCode)) result.error.exitCode = result.code || 1;
    throw result.error;
  }
  const error = new Error(`verification task failed: ${task}`);
  error.exitCode = result.code || 1;
  throw error;
}

function runTask({ invocation, cwd, verbose, spawnProcess, progressOutput, progressPrefixes, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, signal }) {
  return new Promise((resolvePromise) => {
    const stdout = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    const stderr = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    const progress = !verbose && progressPrefixes?.length
      ? sparseLineForwarder(progressOutput, progressPrefixes) : null;
    let child;
    let settled = false;
    let interrupted = false;
    let timeoutTimer = null;
    let abortListener = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      progress?.flush();
      resolvePromise(result);
    };
    const interruption = (timeout) => {
      const code = timeout ? 124 : signal?.reason === "SIGINT" ? 130 : 143;
      const error = new Error(timeout
        ? `verification task timed out after ${Math.round(timeoutMs / 1000)}s: ${invocation.label}`
        : `verification task cancelled: ${invocation.label}`);
      error.exitCode = code;
      return { code, error, stdout, stderr };
    };
    if (signal?.aborted) { finish(interruption(false)); return; }
    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        cwd, env: invocation.env,
        stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true, shell: false,
        // Own a process group so a shell/npm child cannot strand its descendants.
        detached: process.platform !== "win32",
      });
    } catch (error) { finish({ code: 1, error, stdout, stderr }); return; }
    const interrupt = (timeout) => {
      if (settled || interrupted) return;
      interrupted = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const result = interruption(timeout);
      stderr?.append(`${result.error.message}\n`);
      // A direct-child close must not cancel ownership-checked escalation. The
      // supervisor settles even when TERM killed the parent but not its children.
      if (process.platform === "win32") {
        // Force the Windows tree while the direct-child identity is still live.
        // A parent-first TERM can otherwise make later /T escalation impossible.
        void terminateProcessTreeAndWait(child, "SIGKILL").then(
          () => finish(result),
          () => finish(result),
        );
        return;
      }
      terminateProcessTreeWithEscalation(child, {
        graceMs: timeout ? TASK_KILL_GRACE_MS : 0,
        onTerminationSettled: () => finish(result),
      });
    };
    timeoutTimer = setTimeout(() => interrupt(true), timeoutMs);
    abortListener = () => interrupt(false);
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) interrupt(false);
    child.stdout?.on?.("data", (chunk) => { stdout?.append(chunk); progress?.push(chunk); });
    child.stderr?.on?.("data", (chunk) => stderr?.append(chunk));
    child.once("error", (error) => { if (!interrupted) finish({ code: 1, error, stdout, stderr }); });
    child.once("close", (code) => {
      if (!interrupted) finish({ code: Number.isInteger(code) ? code : 1, stdout, stderr });
    });
  });
}

function sparseLineForwarder(output, prefixes) {
  let pending = "";
  const emit = (line) => {
    if (prefixes.some((prefix) => line.startsWith(prefix))) output.write(`${line}\n`);
  };
  return {
    push(chunk) {
      pending += String(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emit(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 4096) pending = pending.slice(-4096);
    },
    flush() { if (pending) emit(pending.replace(/\r$/, "")); pending = ""; },
  };
}

function taskEnvironmentFor(taskEnvironments, task) {
  if (!taskEnvironments) return null;
  const value = taskEnvironments instanceof Map
    ? taskEnvironments.get(task)
    : taskEnvironments[task];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`verification task environment must be an object: ${task}`);
  }
  return value;
}

function taskInvocation(task, packageScripts, npmCli, cwd, env, taskEnvironments) {
  const taskEnvironment = taskEnvironmentFor(taskEnvironments, task);
  const mergedEnvironment = taskEnvironment ? { ...env, ...taskEnvironment } : env;
  const cleanEnvironment = {
    ...verificationChildEnvironment(mergedEnvironment),
    NO_COLOR: mergedEnvironment.NO_COLOR || "1",
  };
  const direct = directNodeInvocation(task, packageScripts);
  if (direct) {
    return {
      executable: process.execPath,
      args: direct.args,
      env: {
        ...cleanEnvironment,
        npm_lifecycle_event: task,
        npm_lifecycle_script: direct.script,
        npm_command: "run-script",
      },
      label: `node-direct ${task}`,
    };
  }
  return {
    executable: process.execPath,
    args: [npmCli, "run", "--workspaces=false", "--global=false", "--ignore-scripts=false", "--if-present=false", "--prefix", cwd, task],
    env: cleanEnvironment,
    label: `npm run ${task}`,
  };
}

export function directNodeInvocation(task, packageScripts) {
  if (!packageScripts || typeof packageScripts !== "object" || Array.isArray(packageScripts)) return null;
  if (packageScripts[`pre${task}`] || packageScripts[`post${task}`]) return null;
  const script = packageScripts[task];
  if (typeof script !== "string") return null;
  const tokens = script.trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] !== "node" || tokens.slice(1).some((token) => !DIRECT_NODE_TOKEN.test(token))) return null;
  return { script, args: tokens.slice(1) };
}

function emitFailureDiagnostics(result, output) {
  const stdoutText = verificationDiagnostic(result.stdout?.text?.() || "");
  const stderrText = verificationDiagnostic(result.stderr?.text?.() || "");
  if (stdoutText) output.write(`\n--- task stdout ---\n${ensureNewline(stdoutText)}`);
  if (stderrText) output.write(`\n--- task stderr ---\n${ensureNewline(stderrText)}`);
  if (!stdoutText && !stderrText) output.write("task produced no captured output\n");
}

function verificationDiagnostic(value) {
  return value ? releaseDiagnostic(value, FAILURE_OUTPUT_BYTES_PER_STREAM + 2048) : "";
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_VERIFICATION_CONCURRENCY) {
    throw new Error(`verification concurrency must be an integer from 1 to ${MAX_VERIFICATION_CONCURRENCY}`);
  }
  return parsed;
}

function ensureNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}
