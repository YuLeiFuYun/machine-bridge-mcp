import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";

const FAILURE_OUTPUT_BYTES_PER_STREAM = 64 * 1024;
const MAX_VERIFICATION_CONCURRENCY = 16;
const DIRECT_NODE_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const SPARSE_PROGRESS_TASKS = new Map([
  ["self-test", ["local self-test phase started:", "local self-test phase completed:"]],
]);

export async function runVerificationPlan(options) {
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
  } = options;
  if (!npmCli) throw new Error("check runner must run through npm so npm_execpath is available");
  const workerCount = normalizeConcurrency(concurrency);
  const parallel = parallelTaskNames instanceof Set ? parallelTaskNames : new Set(parallelTaskNames || []);
  const planStartedAt = performance.now();
  stdout.write(`running ${mode} verification plan (${tasks.length} tasks; up to ${workerCount} parallel)\n`);

  let index = 0;
  while (index < tasks.length) {
    if (!parallel.has(tasks[index]) || workerCount === 1) {
      const failure = await executeTask({ index, tasks, npmCli, cwd, env, verbose, stdout, spawnProcess, packageScripts });
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
    });
    if (failure) throwVerificationFailure(failure, stderr);
    index = end;
  }

  const totalSeconds = ((performance.now() - planStartedAt) / 1000).toFixed(1);
  stdout.write(`\n${mode} verification plan passed in ${totalSeconds}s\n`);
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

async function executeTask({ index, tasks, npmCli, cwd, env, verbose, stdout, spawnProcess, packageScripts }) {
  const task = tasks[index];
  const invocation = taskInvocation(task, packageScripts, npmCli, cwd, env);
  const taskStartedAt = performance.now();
  stdout.write(`[${index + 1}/${tasks.length}] ${invocation.label}\n`);
  const result = await runTask({
    invocation,
    cwd,
    verbose,
    spawnProcess,
    progressOutput: stdout,
    progressPrefixes: SPARSE_PROGRESS_TASKS.get(task),
  });
  const elapsedSeconds = ((performance.now() - taskStartedAt) / 1000).toFixed(1);
  if (result.error || result.code !== 0) return { index, task, elapsedSeconds, result };
  stdout.write(`[${index + 1}/${tasks.length}] completed ${task} in ${elapsedSeconds}s\n`);
  return null;
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

function runTask({ invocation, cwd, verbose, spawnProcess, progressOutput, progressPrefixes }) {
  return new Promise((resolvePromise) => {
    const stdout = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    const stderr = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    const progress = !verbose && progressPrefixes?.length
      ? sparseLineForwarder(progressOutput, progressPrefixes)
      : null;
    let child;
    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        cwd,
        env: invocation.env,
        stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolvePromise({ code: 1, error, stdout, stderr });
      return;
    }
    child.stdout?.on?.("data", (chunk) => { stdout?.append(chunk); progress?.push(chunk); });
    child.stderr?.on?.("data", (chunk) => stderr?.append(chunk));
    child.once("error", (error) => resolvePromise({ code: 1, error, stdout, stderr }));
    child.once("close", (code) => {
      progress?.flush();
      resolvePromise({ code: Number.isInteger(code) ? code : 1, stdout, stderr });
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

function taskInvocation(task, packageScripts, npmCli, cwd, env) {
  const cleanEnvironment = {
    ...nestedNpmEnvironment(env),
    NO_COLOR: env.NO_COLOR || "1",
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
    args: [npmCli, "run", "--workspaces=false", "--global=false", "--ignore-scripts=false", "--if-present=false", "--prefix", cwd, "--silent", task],
    env: cleanEnvironment,
    label: `npm run ${task}`,
  };
}

function directNodeInvocation(task, packageScripts) {
  if (!packageScripts || typeof packageScripts !== "object" || Array.isArray(packageScripts)) return null;
  if (packageScripts[`pre${task}`] || packageScripts[`post${task}`]) return null;
  const script = packageScripts[task];
  if (typeof script !== "string") return null;
  const tokens = script.trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] !== "node" || tokens.slice(1).some((token) => !DIRECT_NODE_TOKEN.test(token))) return null;
  return { script, args: tokens.slice(1) };
}

function emitFailureDiagnostics(result, output) {
  const stdoutText = result.stdout?.text?.() || "";
  const stderrText = result.stderr?.text?.() || "";
  if (stdoutText) output.write(`\n--- task stdout ---\n${ensureNewline(stdoutText)}`);
  if (stderrText) output.write(`\n--- task stderr ---\n${ensureNewline(stderrText)}`);
  if (!stdoutText && !stderrText) output.write("task produced no captured output\n");
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
