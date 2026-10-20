// @ts-check

// Shared by the Worker transport and local stdio transport so progress values
// remain monotonic even if the wall clock changes during a long-running call.
export const PROGRESS_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

/**
 * Start reporting progress for one in-flight request.
 * @param {object} options
 * @param {string | number | undefined} options.progressToken
 * @param {(notification: { progressToken: string | number, progress: number, message: string }) => void} options.emit
 * @param {() => number} [options.now]
 * @param {(callback: () => void, delay: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @param {string} [options.label]
 * @returns {() => void}
 */
export function createProgressReporter({
  progressToken,
  emit,
  now = () => performance.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  label = "tool call",
}) {
  if (progressToken === undefined || progressToken === null) return () => {};
  if (typeof emit !== "function") throw new TypeError("progress reporter requires an emit callback");
  const startedAt = now();
  let attempt = 1;
  let lastProgress = 0;
  /** @type {unknown} */
  let handle;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const elapsed = Math.max(lastProgress + 1, Math.floor(now() - startedAt));
    lastProgress = elapsed;
    try { emit({ progressToken, progress: elapsed, message: `${label} still running (${formatElapsed(elapsed)})` }); }
    catch { /* A failed notification must not abort the operation it describes. */ }
    const delay = PROGRESS_BACKOFF_MS[Math.min(attempt, PROGRESS_BACKOFF_MS.length - 1)];
    attempt += 1;
    handle = schedule(tick, delay);
    /** @type {{ unref?: () => void }} */ (handle)?.unref?.();
  };

  handle = schedule(tick, PROGRESS_BACKOFF_MS[0]);
  /** @type {{ unref?: () => void }} */ (handle)?.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    if (handle !== undefined) cancel(handle);
  };
}

/** @param {number} milliseconds */
export function formatElapsed(milliseconds) {
  const totalSeconds = Math.round(Math.max(0, milliseconds) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}
