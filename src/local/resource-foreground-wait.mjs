const DEFAULT_MINIMUM_WAIT_MS = 2_000;
const DEFAULT_MAXIMUM_WAIT_MS = 10_000;
const MAXIMUM_CONFIGURED_WAIT_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_FRACTION = 0.2;

export function foregroundResourceWaitMs(executionTimeoutMs, configuredWaitMs = undefined) {
  if (configuredWaitMs !== undefined) return configuredResourceWaitMs(configuredWaitMs);
  const timeout = positiveInteger(executionTimeoutMs, "foreground execution timeout");
  const proportional = Math.floor(timeout * DEFAULT_TIMEOUT_FRACTION);
  return Math.min(timeout, DEFAULT_MAXIMUM_WAIT_MS, Math.max(DEFAULT_MINIMUM_WAIT_MS, proportional));
}

export function processSessionResourceWaitMs(configuredWaitMs = undefined) {
  return configuredWaitMs === undefined ? DEFAULT_MAXIMUM_WAIT_MS : configuredResourceWaitMs(configuredWaitMs);
}

function configuredResourceWaitMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new TypeError("resource wait must be a non-negative finite duration");
  return Math.min(MAXIMUM_CONFIGURED_WAIT_MS, Math.floor(numeric));
}

function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new TypeError(`${label} must be positive`);
  return Math.max(1, Math.floor(numeric));
}
