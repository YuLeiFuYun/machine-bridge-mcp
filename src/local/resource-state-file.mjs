import { readBoundedRegularFileSync } from "./secure-file.mjs";

const RESOURCE_STATE_READ_ATTEMPTS = 4;

/**
 * Read coordinator state without mutating its link topology. An extra hard link can be an
 * attacker-controlled alias, so a normal read fails closed; only the explicit doctor repair
 * may replace an unattributable link. Directory staging recovery handles the attributable
 * `.tmp` alias before this reader is called.
 */
export function readResourceStateJson(file, maxBytes, label, options = {}) {
  const readFile = options.readFile || readBoundedRegularFileSync;
  for (let attempt = 1; attempt <= RESOURCE_STATE_READ_ATTEMPTS; attempt += 1) {
    try {
      const text = readFile(file, maxBytes, label, {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
      }).toString("utf8");
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      if (options.optional === true && (error?.code === "ENOENT" || error?.cause?.code === "ENOENT")) return null;
      const identityChanged = error?.code === "MBM_IDENTITY_CHANGED" || error?.cause?.code === "MBM_IDENTITY_CHANGED";
      if (!identityChanged || attempt === RESOURCE_STATE_READ_ATTEMPTS) throw error;
    }
  }
  throw new Error(`${label} generation did not settle`);
}
