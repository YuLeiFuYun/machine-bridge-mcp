// @ts-check

import { trimAutostartLogs } from "./service.mjs";

const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Keep long-lived background-service logs within the same bounds enforced at
 * startup. The injected scheduler/trim hooks keep the lifecycle deterministic
 * in tests without weakening the production file-safety checks.
 *
 * @param {string} stateRoot
 * @param {{
 *   intervalMs?: number,
 *   trim?: (stateRoot: string) => void,
 *   onError?: (error: unknown) => void,
 *   scheduler?: {setInterval: (callback: () => void, delay: number) => any},
 * }} [options]
 */
export function startAutostartLogMaintenance(stateRoot, options = {}) {
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_MAINTENANCE_INTERVAL_MS);
  const trim = typeof options.trim === "function" ? options.trim : trimAutostartLogs;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const scheduler = options.scheduler || { setInterval };
  const maintain = () => {
    try { trim(stateRoot); } catch (error) { onError(error); }
  };
  const timer = scheduler.setInterval(maintain, intervalMs);
  timer?.unref?.();
  return { intervalMs, maintain };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
