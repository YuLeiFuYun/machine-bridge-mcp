import { classifyOperationalError } from "./log.mjs";

const DEFAULT_RECONCILE_DELAY_MS = 10_100;

export function createManagedJobRunnerExitRecovery({ reconcileStatus, logger = console, delayMs = DEFAULT_RECONCILE_DELAY_MS }) {
  const timers = new Set();
  let enabled = true;
  return {
    observe(dir) {
      if (!enabled) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!enabled) return;
        try { reconcileStatus(dir); }
        catch (error) {
          logger.warn?.("managed job runner exit reconciliation failed; retaining state for later recovery", {
            error_class: classifyOperationalError(error),
          });
        }
      }, Math.max(0, Number(delayMs) || 0));
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      enabled = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
