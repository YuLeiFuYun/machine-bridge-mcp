// @ts-check
import { positiveInteger } from "../shared/numbers.mjs";

const DEFAULT_WARNING_INTERVAL_MS = 60_000;

/**
 * @param {{ event?: (...args: any[]) => void }} [logger]
 * @param {{ now?: () => number, intervalMs?: number }} [options]
 */
export function createSecurityAuditFailureReporter(logger, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_WARNING_INTERVAL_MS);
  /** @type {Map<string, { lastAt: number, suppressed: number }>} */
  const state = new Map();
  return {
    /**
     * @param {string} event
     * @param {Record<string, unknown>} [fields]
     * @param {string} [message]
     */
    report(event, fields, message) {
      if (typeof logger?.event !== "function") return false;
      const key = String(event || "security.audit.failure");
      const current = Number(now()) || 0;
      const previous = state.get(key);
      if (previous && current - previous.lastAt < intervalMs) {
        previous.suppressed += 1;
        return false;
      }
      const suppressed = previous?.suppressed || 0;
      state.set(key, { lastAt: current, suppressed: 0 });
      logger.event("warn", key, {
        ...(fields && typeof fields === "object" ? fields : {}),
        ...(suppressed > 0 ? { suppressed } : {}),
      }, message);
      return true;
    },
  };
}
