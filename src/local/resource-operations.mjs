import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectResourceFile, validateResourceName } from "./managed-jobs.mjs";
import { generateSshKeyPair } from "./ssh-key.mjs";
import { acquireStartupLockWithWait, loadState, saveState } from "./state.mjs";

export async function generateRegisteredSshKey({ workspace, stateDir, name: rawName, targetPath, comment = "" }) {
  const name = validateResourceName(rawName);
  if (typeof targetPath !== "string" || !targetPath.trim()) throw new Error("SSH private key target path is required");
  const target = resolve(targetPath);
  const state = loadState(workspace, { stateDir });
  const lock = await acquireStartupLockWithWait(state, { operation: "generate-ssh-key" });
  let key = null;
  try {
    state.resources ||= {};
    const existing = Object.hasOwn(state.resources, name) ? state.resources[name] : null;
    if (existing?.path && !samePathIdentity(existing.path, target)) {
      throw new Error(`local resource ${name} is already registered to a different file; remove it first`);
    }
    if (!existing && Object.keys(state.resources).length >= 64) throw new Error("local resource registry limit reached (64)");
    key = await generateSshKeyPair({
      privateKeyPath: target,
      type: "ed25519",
      comment: comment || `machine-mcp:${name}`,
    });
    const inspected = inspectResourceFile(key.privateKeyPath);
    state.resources[name] = inspected;
    try {
      saveState(state);
    } catch (error) {
      if (key.created) {
        await rm(key.privateKeyPath, { force: true }).catch(() => {});
        await rm(key.publicKeyPath, { force: true }).catch(() => {});
      }
      throw error;
    }
    return {
      name,
      created: key.created,
      registered: true,
      privateKeyPath: key.privateKeyPath,
      publicKeyPath: key.publicKeyPath,
      fingerprint: key.fingerprint,
      keyType: key.publicKeyType,
      privateMode: key.privateMode,
      publicMode: key.publicMode,
      privateKeyContentExposed: false,
      availableToNewJobsImmediately: true,
    };
  } finally {
    lock.release();
  }
}

function samePathIdentity(left, right) {
  const a = canonicalIfExisting(left);
  const b = canonicalIfExisting(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalIfExisting(value) {
  const absolute = resolve(String(value));
  try { return realpathSync.native ? realpathSync.native(absolute) : realpathSync(absolute); } catch { return absolute; }
}
