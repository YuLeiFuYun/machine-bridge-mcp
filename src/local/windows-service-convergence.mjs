// @ts-check

import { waitForStableActiveStatus } from "./service-convergence.mjs";

/** @typedef {{ statusAttempts?: unknown, statusDelayMs?: unknown, stableSamples?: unknown, sleep?: (milliseconds: number) => Promise<void> }} WindowsConvergenceOptions */
/** @typedef {Record<string, unknown> & { active?: boolean }} WindowsStatus */

/** @param {() => WindowsStatus | Promise<WindowsStatus>} readStatus @param {WindowsConvergenceOptions} [options] */
export async function stableWindowsStatus(readStatus, options = {}) {
  if (typeof readStatus !== "function") throw new TypeError("Windows status reader is required");
  return waitForStableActiveStatus(readStatus, {
    attempts: boundedPositiveInteger(options.statusAttempts, 10),
    delayMs: boundedPositiveInteger(options.statusDelayMs, 100),
    stableSamples: boundedPositiveInteger(options.stableSamples, 5),
    sleep: typeof options.sleep === "function" ? options.sleep : undefined,
  });
}

/** @param {() => WindowsStatus | Promise<WindowsStatus>} readStatus @param {(status: WindowsStatus) => boolean} predicate @param {WindowsConvergenceOptions} [options] */
export async function waitForWindowsStatus(readStatus, predicate, options = {}) {
  if (typeof readStatus !== "function") throw new TypeError("Windows status reader is required");
  if (typeof predicate !== "function") throw new TypeError("Windows status predicate is required");
  const attempts = boundedPositiveInteger(options.statusAttempts, 10);
  const delayMs = boundedPositiveInteger(options.statusDelayMs, 100);
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (/** @type {number} */ milliseconds) => new Promise(resolve => { setTimeout(resolve, milliseconds); });
  let status = await readStatus();
  for (let index = 1; index < attempts && !predicate(status); index += 1) {
    await sleep(delayMs);
    status = await readStatus();
  }
  return status;
}

/** @param {WindowsConvergenceOptions} [options] */
export function windowsStatusWaitOptions(options = {}) {
  return {
    attempts: boundedPositiveInteger(options.statusAttempts, 10),
    delayMs: boundedPositiveInteger(options.statusDelayMs, 100),
    sleep: typeof options.sleep === "function" ? options.sleep : undefined,
  };
}

/** @param {unknown} value @param {number} fallback */
export function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
