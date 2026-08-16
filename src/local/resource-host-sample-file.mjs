import { readBoundedRegularFileSync } from "./secure-file.mjs";

const HOST_SAMPLE_MAX_BYTES = 32 * 1024;
const HOST_SAMPLE_READ_ATTEMPTS = 4;

export function readResourceHostSample(file, options = {}) {
  const readFile = options.readFile || readBoundedRegularFileSync;
  for (let attempt = 1; attempt <= HOST_SAMPLE_READ_ATTEMPTS; attempt += 1) {
    try {
      const text = readFile(file, HOST_SAMPLE_MAX_BYTES, "resource host sample", {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
      }).toString("utf8");
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      if (options.optional === true && (error?.code === "ENOENT" || error?.cause?.code === "ENOENT")) return null;
      const identityChanged = error?.code === "MBM_IDENTITY_CHANGED" || error?.cause?.code === "MBM_IDENTITY_CHANGED";
      if (!identityChanged || attempt === HOST_SAMPLE_READ_ATTEMPTS) throw error;
    }
  }
  throw new Error("resource host sample generation did not settle");
}
