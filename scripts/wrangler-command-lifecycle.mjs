import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_COMPLETION_EXIT_GRACE_MS = 500;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export async function runCompletedWranglerCommand(options = {}) {
  const cwd = requiredString(options.cwd, "cwd");
  const wranglerPath = requiredString(options.wranglerPath, "wranglerPath");
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const label = requiredString(options.label, "label");
  const completionMarker = requiredString(options.completionMarker, "completionMarker");
  const completionCheck = typeof options.completionCheck === "function" ? options.completionCheck : () => true;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const completionExitGraceMs = positiveInteger(options.completionExitGraceMs, DEFAULT_COMPLETION_EXIT_GRACE_MS, "completionExitGraceMs");
  const terminationGraceMs = positiveInteger(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, "terminationGraceMs");
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const child = spawn(process.execPath, [wranglerPath, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  await new Promise((resolvePromise, rejectPromise) => {
    let completionObserved = false;
    let cleanupRequested = false;
    let forceKillUsed = false;
    let hardTimedOut = false;
    let outputTail = "";
    let completionTimer;
    let forceTimer;
    let settled = false;

    const hardTimer = setTimeout(() => {
      hardTimedOut = true;
      requestTermination();
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(hardTimer);
      clearTimeout(completionTimer);
      clearTimeout(forceTimer);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const requestTermination = () => {
      if (cleanupRequested) return;
      cleanupRequested = true;
      try { child.kill("SIGTERM"); }
      catch (error) { finish(new Error(`${label} could not request graceful cleanup`, { cause: error })); return; }
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        forceKillUsed = true;
        try {
          if (child.kill("SIGKILL") !== true) finish(new Error(`${label} could not force cleanup`));
        } catch (error) { finish(new Error(`${label} could not force cleanup`, { cause: error })); }
      }, terminationGraceMs);
    };
    const observeOutput = (destination, chunk) => {
      destination.write(chunk);
      outputTail = `${outputTail}${String(chunk)}`.slice(-4096);
      if (completionObserved || !outputTail.includes(completionMarker)) return;
      completionObserved = true;
      completionTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) requestTermination();
      }, completionExitGraceMs);
    };
    const completionIsValid = () => {
      try { return completionCheck() === true; }
      catch (error) { finish(error); return false; }
    };

    child.stdout.on("data", (chunk) => observeOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => observeOutput(stderr, chunk));
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (hardTimedOut) { finish(new Error(`${label} timed out after ${timeoutMs}ms`)); return; }
      if (forceKillUsed) { finish(new Error(`${label} completed but did not terminate after graceful cleanup`)); return; }
      if (code === 0 && completionIsValid()) { finish(); return; }
      if (cleanupRequested && completionObserved && signal === "SIGTERM" && completionIsValid()) {
        stderr.write(`${label} completed but did not exit; terminated the completed CLI after a bounded grace period\n`);
        finish();
        return;
      }
      if (settled) return;
      const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      finish(new Error(`${label} failed with ${status}`));
    });
  });
}

function requiredString(value, name) {
  const text = String(value || "");
  if (!text) throw new TypeError(`${name} must be a non-empty string`);
  return text;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}
