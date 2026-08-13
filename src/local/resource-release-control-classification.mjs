import path from "node:path";

const NODE_TARGET_NAMES = new Set(["node", "node.exe"]);
const CANARY_ENTRY_NAME = "release-oauth-canary.mjs";
const CANARY_FLAG = "--allow-live-oauth-canary";

export function releaseControlCommandIsLight(base, args = []) {
  const head = String(base || "").toLowerCase();
  if (!NODE_TARGET_NAMES.has(head)) return false;
  const values = args.map((value) => String(value));
  if (values.length !== 2 || values[1] !== CANARY_FLAG) return false;
  const entry = values[0];
  return path.isAbsolute(entry) && path.basename(entry).toLowerCase() === CANARY_ENTRY_NAME;
}
