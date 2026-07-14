import { performance } from "node:perf_hooks";

export function createMonotonicDeadline(timeoutMs, now = () => performance.now()) {
  const durationMs = Number(timeoutMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError("timeoutMs must be a finite non-negative number");
  let lastSample = readSample(now);
  const startedAt = lastSample;

  function elapsedMs() {
    const sample = readSample(now);
    if (sample > lastSample) lastSample = sample;
    return Math.max(0, lastSample - startedAt);
  }

  return Object.freeze({
    expired() {
      return elapsedMs() >= durationMs;
    },
    remainingMs() {
      return Math.max(0, durationMs - elapsedMs());
    },
    elapsedMs,
  });
}

function readSample(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new TypeError("monotonic clock returned a non-finite value");
  return value;
}
