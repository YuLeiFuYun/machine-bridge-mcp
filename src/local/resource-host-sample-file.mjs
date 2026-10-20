// @ts-check
import { readResourceStateJson } from "./resource-state-file.mjs";

const HOST_SAMPLE_MAX_BYTES = 32 * 1024;

/**
 * @param {string} file
 * @param {Record<string, unknown>} [options]
 * @returns {unknown}
 */
export function readResourceHostSample(file, options = {}) {
  return readResourceStateJson(file, HOST_SAMPLE_MAX_BYTES, "resource host sample", options);
}
