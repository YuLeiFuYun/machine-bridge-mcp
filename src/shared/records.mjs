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

/**
 * Return value as object record if it is a non-null non-array object, or an empty object.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * Check that a value is a non-null non-array object record.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Format a call ID compactly.
 * @param {unknown} value
 * @returns {string}
 */
export function shortCallId(value) {
  const text = String(value || "");
  return text.length <= 18 ? text : `${text.slice(0, 10)}...${text.slice(-5)}`;
}
