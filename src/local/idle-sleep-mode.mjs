// @ts-check
export const IDLE_SLEEP_MODES = Object.freeze(/** @type {const} */ (["activity", "ac-continuous", "continuous"]));

/**
 * @param {string} [value]
 * @returns {string}
 */
export function normalizeIdleSleepMode(value = "activity") {
  const mode = String(value || "activity").trim().toLowerCase();
  if (!/** @type {readonly string[]} */ (IDLE_SLEEP_MODES).includes(mode)) {
    throw new Error(`idle-sleep mode must be one of: ${IDLE_SLEEP_MODES.join(", ")}`);
  }
  return mode;
}
