// @ts-check

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { BridgeError } from "./errors.mjs";

/** @typedef {(path: string) => Promise<string>} ReadText */
/** @typedef {(path: string, options?: {force?: boolean}) => Promise<unknown>} RemovePath */

/** @param {string} value */
export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** @param {string} filePath @param {string} content @param {number} mode @param {RemovePath} remove */
export async function writeFlushedText(filePath, content, mode, remove) {
  const handle = await open(filePath, "wx", mode);
  let failure = null;
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    try { await handle.chmod(mode); } catch (error) { if (process.platform !== "win32") throw error; }
    await handle.sync();
  } catch (error) { failure = error; }
  try { await handle.close(); } catch (error) {
    failure = failure ? new AggregateError([failure, error], "staged file write and close both failed") : error;
  }
  if (!failure) return;
  try { await remove(filePath, { force: true }); } catch (cleanupError) {
    throw incompleteMutationError("staged file write failed and cleanup was incomplete", failure, [cleanupError]);
  }
  throw failure;
}

/** @param {string[]} paths @param {RemovePath} remove */
export async function removeArtifacts(paths, remove) {
  const failures = [];
  for (const path of paths) {
    try { await remove(path, { force: true }); } catch (error) { failures.push(error); }
  }
  return failures;
}

/** @param {unknown} primary @param {unknown[]} recoveryFailures */
export function patchRecoveryIncompleteError(primary, recoveryFailures) {
  const message = "patch transaction may have partially modified files because recovery was incomplete; inspect affected paths before retrying";
  return new BridgeError("execution_failed", message, {
    cause: new AggregateError([primary, ...recoveryFailures], message),
    expose: true,
    retryable: false,
    details: { reason: "patch_recovery_incomplete" },
  });
}

/** @param {string} message @param {unknown} primary @param {unknown[]} cleanupFailures */
export function incompleteMutationError(message, primary, cleanupFailures) {
  return new BridgeError("internal_error", message, {
    cause: new AggregateError([primary, ...cleanupFailures], message),
    expose: false,
  });
}

/** @param {unknown} value @param {boolean} required @returns {ReadText} */
export function requiredReadText(value, required) {
  if (typeof value === "function") return /** @type {ReadText} */ (value);
  if (required) throw new TypeError("workspace file transaction requires a bounded text reader");
  return async () => { throw new TypeError("workspace file transaction text reader was not configured"); };
}

/** @param {unknown} error @param {string} code */
export function hasErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error
    && /** @type {{code?: unknown}} */ (error).code === code);
}
