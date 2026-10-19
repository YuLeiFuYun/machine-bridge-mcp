// @ts-check

import { rename as fsRename } from "node:fs/promises";
import { isTransientFilesystemMutationError } from "./atomic-fs.mjs";

/** @param {string} source @param {string} target @param {(source: string, target: string) => Promise<void>} [move] @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number}} [options] */
export async function renameWithRetry(source, target, move = fsRename, options = {}) {
  const attempts = clampInteger(options.attempts, 32, 1, 64);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  const maxDelayMs = Math.max(baseDelayMs, clampInteger(options.maxDelayMs, 250, 0, 2000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await move(source, target);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientFilesystemMutationError(error) || attempt === attempts) throw error;
      const exponential = Math.min(baseDelayMs * (2 ** Math.min(attempt - 1, 5)), maxDelayMs);
      const jitter = Math.floor(exponential * 0.5 * Math.random());
      await new Promise((resolve) => { setTimeout(resolve, Math.min(exponential + jitter, maxDelayMs)); });
    }
  }
  throw lastError || new Error("atomic file replacement failed");
}

/** @param {unknown} value @param {number} fallback @param {number} minimum @param {number} maximum */
function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}
