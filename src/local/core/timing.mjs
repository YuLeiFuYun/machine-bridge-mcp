// @ts-check
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import packageManifest from "../../../package.json" with { type: "json" };

/**
 * @param {number} timeoutMs
 * @param {() => number} [now]
 */
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

/** @param {() => number} now */
function readSample(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new TypeError("monotonic clock returned a non-finite value");
  return value;
}
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const packageName = String(packageManifest.name);

export const packageVersion = String(packageManifest.version);

export const appName = String(serverMetadata.name);
