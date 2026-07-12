import { renameSync } from "node:fs";

const TRANSIENT_REPLACE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function replaceFileSync(source, target, options = {}) {
  const rename = typeof options.rename === "function" ? options.rename : renameSync;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const attempts = clampInteger(options.attempts, 16, 1, 64);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  const maxDelayMs = Math.max(baseDelayMs, clampInteger(options.maxDelayMs, 250, 0, 2000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, target);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === attempts) throw error;
      sleep(retryDelayMs(attempt, baseDelayMs, maxDelayMs, random));
    }
  }
  throw lastError || new Error("atomic file replacement failed");
}

export function isTransientReplaceError(error) {
  return TRANSIENT_REPLACE_ERRORS.has(String(error?.code || ""));
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs, random) {
  if (baseDelayMs <= 0 || maxDelayMs <= 0) return 0;
  const exponential = Math.min(baseDelayMs * (2 ** Math.min(attempt - 1, 5)), maxDelayMs);
  const randomValue = Number(random());
  const normalizedRandom = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  const jitter = Math.floor(exponential * 0.5 * normalizedRandom);
  return Math.min(exponential + jitter, maxDelayMs);
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}
