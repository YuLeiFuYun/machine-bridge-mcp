// @ts-check

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 */
export function clampInteger(value, fallback, minimum, maximum) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  const number = Number.isInteger(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

/** @param {unknown} value @param {number} fallback */
export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
