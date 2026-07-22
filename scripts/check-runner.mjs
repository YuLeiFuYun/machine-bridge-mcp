import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { BoundedOutput } from "../src/local/bounded-output.mjs";

const FAILURE_OUTPUT_BYTES_PER_STREAM = 64 * 1024;

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
  } = options;
  if (!npmCli) throw new Error("check runner must run through npm so npm_execpath is available");
  const planStartedAt = performance.now();
  stdout.write(`running ${mode} verification plan (${tasks.length} tasks)\n`);
  for (const [index, task] of tasks.entries()) {
    const taskStartedAt = performance.now();
    stdout.write(`\n[${index + 1}/${tasks.length}] npm run ${task}\n`);
    const result = await runTask({ task, npmCli, cwd, env, verbose, spawnProcess });
    const elapsedSeconds = ((performance.now() - taskStartedAt) / 1000).toFixed(1);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      stderr.write(`verification task failed after ${elapsedSeconds}s: ${task}\n`);
      emitFailureDiagnostics(result, stderr);
      const error = new Error(`verification task failed: ${task}`);
      error.exitCode = result.code || 1;
      throw error;
    }
    stdout.write(`completed ${task} in ${elapsedSeconds}s\n`);
  }
  const totalSeconds = ((performance.now() - planStartedAt) / 1000).toFixed(1);
  stdout.write(`\n${mode} verification plan passed in ${totalSeconds}s\n`);
}

function runTask({ task, npmCli, cwd, env, verbose, spawnProcess }) {
  return new Promise((resolvePromise) => {
    const stdout = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    const stderr = verbose ? null : new BoundedOutput(FAILURE_OUTPUT_BYTES_PER_STREAM);
    let child;
    try {
      child = spawnProcess(process.execPath, [npmCli, "run", "--silent", task], {
        cwd,
        env: {
          ...env,
          NO_COLOR: env.NO_COLOR || "1",
        },
        stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolvePromise({ code: 1, error, stdout, stderr });
      return;
    }
    child.stdout?.on?.("data", (chunk) => stdout?.append(chunk));
    child.stderr?.on?.("data", (chunk) => stderr?.append(chunk));
    child.once("error", (error) => resolvePromise({ code: 1, error, stdout, stderr }));
    child.once("close", (code) => resolvePromise({ code: Number.isInteger(code) ? code : 1, stdout, stderr }));
  });
}

function emitFailureDiagnostics(result, output) {
  const stdoutText = result.stdout?.text?.() || "";
  const stderrText = result.stderr?.text?.() || "";
  if (stdoutText) output.write(`\n--- task stdout ---\n${ensureNewline(stdoutText)}`);
  if (stderrText) output.write(`\n--- task stderr ---\n${ensureNewline(stderrText)}`);
  if (!stdoutText && !stderrText) output.write("task produced no captured output\n");
}

function ensureNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}
