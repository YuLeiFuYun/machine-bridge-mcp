export function normalizeRelayHeartbeatTiming(options = {}) {
  const intervalMs = positiveInteger(options.intervalMs, 25_000);
  const timeoutMs = positiveInteger(options.timeoutMs, 75_000);
  return {
    intervalMs,
    timeoutMs,
    stallThresholdMs: positiveInteger(options.stallThresholdMs, Math.max(1000, Math.floor(intervalMs / 2))),
    recoveryGraceMs: positiveInteger(options.recoveryGraceMs, Math.max(intervalMs, Math.min(timeoutMs, 30_000))),
    dispatchTimeoutMs: positiveInteger(options.dispatchTimeoutMs, Math.max(30_000, timeoutMs * 3)),
  };
}

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
