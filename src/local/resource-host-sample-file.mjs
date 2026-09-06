import { readResourceStateJson } from "./resource-state-file.mjs";

const HOST_SAMPLE_MAX_BYTES = 32 * 1024;

export function readResourceHostSample(file, options = {}) {
  return readResourceStateJson(file, HOST_SAMPLE_MAX_BYTES, "resource host sample", options);
}
