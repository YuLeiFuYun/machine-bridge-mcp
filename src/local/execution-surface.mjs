// @ts-check
export const EXECUTION_SURFACE_ENV = "MBM_EXECUTION_SURFACE";

export const EXECUTION_SURFACE = Object.freeze({
  foregroundProcess: "foreground_process",
  processSession: "process_session",
  managedJob: "managed_job",
});

const KNOWN_SURFACES = /** @type {Set<string>} */ (new Set(Object.values(EXECUTION_SURFACE)));

/**
 * @param {Record<string, any>} environment
 * @param {string} surface
 * @returns {Record<string, any>}
 */
export function withExecutionSurface(environment, surface) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("execution surface requires an environment record");
  }
  if (!KNOWN_SURFACES.has(surface)) throw new TypeError("execution surface is invalid");
  return { ...environment, [EXECUTION_SURFACE_ENV]: surface };
}

/**
 * @param {Record<string, any>} [environment]
 * @returns {string}
 */
export function executionSurface(environment = process.env) {
  const value = String(environment?.[EXECUTION_SURFACE_ENV] || "");
  if (!value) return "";
  return KNOWN_SURFACES.has(value) ? value : "unknown";
}
