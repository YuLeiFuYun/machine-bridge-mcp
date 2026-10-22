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
 * Format a call ID compactly.
 * @param {unknown} value
 * @returns {string}
 */
export function shortCallId(value) {
  const text = String(value || "");
  return text.length <= 18 ? text : `${text.slice(0, 10)}...${text.slice(-5)}`;
}
