// @ts-check

/**
 * Check that a value is a plain record, including null-prototype dictionaries.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
