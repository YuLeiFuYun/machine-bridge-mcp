import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";

export function inspectStateRootGeneration(root, label = "state root") {
  const info = inspectDirectory(root, label);
  return filesystemIdentity(info, label);
}

export function stateRootRetirementPath(root, identity, nonce = randomBytes(18).toString("base64url")) {
  if (!/^[A-Za-z0-9_-]{24}$/.test(nonce)) throw new Error("state-root retirement nonce is invalid");
  return join(dirname(root), `.${basename(root)}.retired_state_${nonce}_d${identity.dev}_i${identity.ino}`);
}

export function retiredStateRootDirectories(root) {
  const parent = dirname(root);
  const prefix = `.${basename(root)}.retired_state_`;
  let entries;
  try { entries = readdirSync(parent, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const retired = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const match = /^([A-Za-z0-9_-]{24})_d([0-9]+)_i([0-9]+)$/.exec(entry.name.slice(prefix.length));
    const path = join(parent, entry.name);
    if (!match) { retired.push({ path, identity: null, reclaimable: false }); continue; }
    if (!entry.isDirectory()) { retired.push({ path, identity: null, reclaimable: false }); continue; }
    try {
      const identity = filesystemIdentity(inspectDirectory(path, "retired state root"), "retired state root");
      retired.push({ path, identity, reclaimable: identity.dev === BigInt(match[2]) && identity.ino === BigInt(match[3]) });
    } catch (error) {
      if (error?.code !== "ENOENT") retired.push({ path, identity: null, reclaimable: false });
    }
  }
  return retired;
}

export function removeStateRootGenerationIfCurrent(root, expectedIdentity, verifyMovedRoot, options = {}) {
  const rename = typeof options.renameSync === "function" ? options.renameSync : renameSync;
  let current;
  try { current = inspectStateRootGeneration(root); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!sameFilesystemIdentity(expectedIdentity, current)) return false;
  const retired = stateRootRetirementPath(options.retirementRoot || root, expectedIdentity);
  try { rename(root, retired); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  const moved = inspectStateRootGeneration(retired, "retired state root");
  if (moved.dev !== expectedIdentity.dev || moved.ino !== expectedIdentity.ino) return false;
  verifyMovedRoot(retired);
  rmSync(retired, { recursive: true, force: false });
  return true;
}

export function pruneRetiredStateRootDirectories(root, verifyMovedRoot) {
  for (const retired of retiredStateRootDirectories(root)) {
    if (!retired.reclaimable || !retired.identity) throw new Error("retired state-root generation is inconsistent; state requires inspection");
    if (!removeStateRootGenerationIfCurrent(retired.path, retired.identity, verifyMovedRoot, { retirementRoot: root })) {
      throw new Error("retired state-root generation changed during cleanup; state requires inspection");
    }
  }
}

function inspectDirectory(path, label) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return info;
}
