// @ts-check

const FAMILY = /^[a-z][a-z0-9-]{0,47}$/;
const CONTENTION_KEY = /^[a-f0-9]{32}$/;
const RESOURCE_CLASSES = new Set(["adaptive", "cpu", "io", "mixed", "unbounded"]);
const PRIORITIES = new Set(["interactive", "ordinary", "background"]);
export const RESOURCE_REQUEST_KEYS = Object.freeze([
  "family", "resource_class", "priority", "cpu", "io", "memory_mb",
  "disk_reserve_bytes", "heavy", "compiler_jobs", "unbounded", "serialize_project", "contention_key",
]);

/**
 * @param {Record<string, unknown> | null | undefined} [request]
 * @returns {Record<string, unknown>}
 */
export function normalizeResourceRequest(request = {}) {
  const source = request && typeof request === "object" ? request : {};
  return Object.fromEntries(RESOURCE_REQUEST_KEYS.map((key) => [key, source[key] ?? null]));
}

/**
 * @param {Record<string, unknown>} request
 * @returns {Record<string, unknown>}
 */
export function validateResourceRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("resource request is invalid");
  if (typeof request.family !== "string" || !FAMILY.test(request.family) || !RESOURCE_CLASSES.has(/** @type {string} */ (request.resource_class))
      || !PRIORITIES.has(/** @type {string} */ (request.priority)) || request.heavy !== true
      || typeof request.unbounded !== "boolean" || typeof request.serialize_project !== "boolean") {
    throw new Error("resource request contract is invalid");
  }
  finiteRange(request.cpu, 0, 1024, "cpu");
  finiteRange(request.io, 0, 1024, "io");
  finiteRange(request.memory_mb, 0, 16 * 1024 * 1024, "memory");
  finiteRange(request.disk_reserve_bytes, 0, 1024 ** 5, "disk reservation");
  if (request.compiler_jobs !== null && (!Number.isInteger(request.compiler_jobs) || /** @type {number} */ (request.compiler_jobs) < 1 || /** @type {number} */ (request.compiler_jobs) > 1024)) {
    throw new Error("resource request compiler jobs are invalid");
  }
  if (request.contention_key !== null
      && (typeof request.contention_key !== "string" || !CONTENTION_KEY.test(request.contention_key))) {
    throw new Error("resource request contention key is invalid");
  }
  return request;
}

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @param {string} label
 */
function finiteRange(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`resource request ${label} is invalid`);
  }
}
