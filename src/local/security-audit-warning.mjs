const DEFAULT_WARNING_INTERVAL_MS = 60_000;

export function createSecurityAuditFailureReporter(logger, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_WARNING_INTERVAL_MS);
  const state = new Map();
  return {
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
