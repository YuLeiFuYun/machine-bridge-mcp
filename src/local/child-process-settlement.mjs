// @ts-check

/**
 * @typedef {{
 *   onSettle?: (code: number | null, signal: string | null, source: "close" | "exit_fallback") => void,
 *   onFallback?: () => void,
 *   schedule?: (callback: () => void, delay: number) => unknown,
 *   clearSchedule?: (timer: unknown) => void,
 *   fallbackMs?: unknown,
 * }} ChildProcessSettlementOptions
 */

/** @param {ChildProcessSettlementOptions} [options] */
export function createChildProcessSettlement(options = {}) {
  if (typeof options.onSettle !== "function") throw new TypeError("child settlement requires onSettle");
  const onSettle = options.onSettle;
  /** @type {(callback: () => void, delay: number) => unknown} */
  const defaultSchedule = (callback, delay) => setTimeout(callback, delay);
  /** @type {(timer: unknown) => void} */
  const defaultClearSchedule = timer => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer));
  const schedule = typeof options.schedule === "function" ? options.schedule : defaultSchedule;
  const clearSchedule = typeof options.clearSchedule === "function" ? options.clearSchedule : defaultClearSchedule;
  const delay = boundedDelay(options.fallbackMs);
  let settled = false;
  /** @type {unknown} */
  let timer = null;
  let timerSet = false;

  /**
   * @param {number | null} code
   * @param {string | null} signal
   * @param {"close" | "exit_fallback"} source
   */
  function settle(code, signal, source) {
    if (settled) return false;
    settled = true;
    if (timerSet) clearSchedule(timer);
    timer = null;
    timerSet = false;
    onSettle(code, signal, source);
    return true;
  }

  /** @param {number | null} code @param {string | null} signal */
  function onClose(code, signal) { return settle(code, signal, "close"); }

  /** @param {number | null} code @param {string | null} signal */
  function onExit(code, signal) {
    if (settled || timerSet) return false;
    timerSet = true;
    timer = schedule(() => {
      timer = null;
      timerSet = false;
      options.onFallback?.();
      settle(code, signal, "exit_fallback");
    }, delay);
    return true;
  }

  function cancel() {
    if (settled) return false;
    settled = true;
    if (timerSet) clearSchedule(timer);
    timer = null;
    timerSet = false;
    return true;
  }

  return Object.freeze({ onClose, onExit, cancel });
}

/** @param {unknown} value */
function boundedDelay(value) {
  if (value === undefined) return 1000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
    throw new TypeError("child settlement fallback must be between 0 and 10000 milliseconds");
  }
  return Math.floor(parsed);
}
