// @ts-check
import { BridgeError } from "./errors.mjs";
/** @type {Readonly<Record<string, string>>} */
export const STRUCTURED_GIT_FIXED_ENVIRONMENT = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
});
/** @param {unknown} value @returns {Readonly<Record<string, string>>} */
export function validateFixedProcessEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", "internal process environment must be an object");
  }
  /** @type {Record<string, string>} */
  const normalized = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(STRUCTURED_GIT_FIXED_ENVIRONMENT, key) || raw !== STRUCTURED_GIT_FIXED_ENVIRONMENT[key]) {
      throw new BridgeError("invalid_request", "internal process environment override is not approved");
    }
    normalized[key] = raw;
  }
  return Object.freeze(normalized);
}
