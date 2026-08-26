import { classifyOperationalError } from "./log.mjs";

const DEFAULT_RECONCILE_DELAY_MS = 10_100;
const DEFAULT_RETRY_DELAY_MS = 10_100;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_ERROR_CLASSES = new Set(["permission_denied", "conflict", "timeout", "resource_unavailable"]);

export function createManagedJobRunnerExitRecovery({
  reconcileStatus,
  logger = console,
  delayMs = DEFAULT_RECONCILE_DELAY_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const timers = new Set();
  let enabled = true;
  const boundedMaxAttempts = Math.max(1, Math.min(10, Number.parseInt(String(maxAttempts), 10) || DEFAULT_MAX_ATTEMPTS));

  function schedule(dir, waitMs, attempt) {
    if (!enabled) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!enabled) return;
      try { reconcileStatus(dir); }
      catch (error) {
        const errorClass = classifyOperationalError(error);
        const retryScheduled = attempt < boundedMaxAttempts && RETRYABLE_ERROR_CLASSES.has(errorClass);
        logger.warn?.("managed job runner exit reconciliation failed; retaining state for later recovery", {
          error_class: errorClass,
          recovery_attempt: attempt,
          retry_scheduled: retryScheduled,
        });
        if (retryScheduled) schedule(dir, retryDelayMs, attempt + 1);
      }
    }, Math.max(0, Number(waitMs) || 0));
    timer.unref?.();
    timers.add(timer);
  }

  return {
    observe(dir) { schedule(dir, delayMs, 1); },
    stop() {
      enabled = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
