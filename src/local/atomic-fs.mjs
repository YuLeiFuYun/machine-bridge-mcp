import { renameSync } from "node:fs";

const TRANSIENT_REPLACE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function replaceFileSync(source, target, options = {}) {
  const rename = typeof options.rename === "function" ? options.rename : renameSync;
  const attempts = clampInteger(options.attempts, 8, 1, 32);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, target);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === attempts) throw error;
      sleepSync(Math.min(baseDelayMs * attempt, 250));
    }
  }
  throw lastError || new Error("atomic file replacement failed");
}

export function isTransientReplaceError(error) {
  return TRANSIENT_REPLACE_ERRORS.has(String(error?.code || ""));
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
