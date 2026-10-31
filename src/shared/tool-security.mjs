// @ts-check
import { isPlainRecord } from "./records.mjs";

const FAMILIES = new Set([
  "automatic", "shell", "persistent-job", "application-control", "computer-use",
  "credential-operation", "browser-session", "browser-upload",
  "protected-resource-inventory", "file-write", "file-read", "patch",
]);
/** @typedef {{family: string, effect: "read-only" | "side-effecting"}} ToolSecurityEntry */
/** Validate before deriving dispatch sets: an unknown family must never become automatic.
 * @param {unknown} contract
 * @returns {Map<string, Readonly<ToolSecurityEntry>>}
 */
export function createToolSecurityIndex(contract) {
  if (!isPlainRecord(contract) || contract.schema_version !== 1 || !isPlainRecord(contract.tools)) {
    throw new Error("invalid static tool security contract");
  }
  const entries = Object.entries(contract.tools);
  if (!entries.length) throw new Error("empty static tool security contract");
  /** @type {Map<string, Readonly<ToolSecurityEntry>>} */
  const index = new Map();
  for (const [name, entry] of entries) {
    if (!name || !isPlainRecord(entry) || typeof entry.family !== "string" || !FAMILIES.has(entry.family)
      || (entry.effect !== "read-only" && entry.effect !== "side-effecting")) {
      throw new Error(`invalid static security classification for ${name}`);
    }
    index.set(name, Object.freeze({ family: entry.family, effect: entry.effect }));
  }
  return index;
}
