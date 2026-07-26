import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectResourceFile, validateResourceName } from "./managed-jobs.mjs";
import { generateSshKeyPair } from "./ssh-key.mjs";
import { acquireStartupLockWithWait, loadState, saveState } from "./state.mjs";

export async function generateRegisteredSshKey(
  { workspace, stateDir, name: rawName, targetPath, comment = "" },
  options = {},
) {
  const name = validateResourceName(rawName);
  if (typeof targetPath !== "string" || !targetPath.trim()) throw new Error("SSH private key target path is required");
  const target = resolve(targetPath);
  const loadStateFn = options.loadState || loadState;
  const acquireLockFn = options.acquireStartupLockWithWait || acquireStartupLockWithWait;
  const generateKeyFn = options.generateSshKeyPair || generateSshKeyPair;
  const inspectResourceFn = options.inspectResourceFile || inspectResourceFile;
  const saveStateFn = options.saveState || saveState;
  const removeFileFn = options.removeFile || rm;
  const state = loadStateFn(workspace, { stateDir });
  const lock = await acquireLockFn(state, { operation: "generate-ssh-key" });
  let key = null;
  try {
    state.resources ||= {};
    const existing = Object.hasOwn(state.resources, name) ? state.resources[name] : null;
    if (existing?.path && !samePathIdentity(existing.path, target)) {
      throw new Error(`local resource ${name} is already registered to a different file; remove it first`);
    }
    if (!existing && Object.keys(state.resources).length >= 64) throw new Error("local resource registry limit reached (64)");
    key = await generateKeyFn({
      privateKeyPath: target,
      type: "ed25519",
      comment: comment || `machine-mcp:${name}`,
    });
    const inspected = inspectResourceFn(key.privateKeyPath);
    state.resources[name] = inspected;
    try {
      saveStateFn(state);
    } catch (error) {
      if (key.created) {
        try {
          await removeGeneratedSshKeyPair(key, removeFileFn);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "SSH key registration failed and generated-key rollback was incomplete",
          );
        }
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


export async function removeGeneratedSshKeyPair(key, removeFile = rm) {
  if (!key?.created) return;
  const failures = [];
  for (const [kind, filePath] of [["private", key.privateKeyPath], ["public", key.publicKeyPath]]) {
    try {
      await removeFile(filePath, { force: true });
    } catch (cause) {
      failures.push(new Error(`generated SSH ${kind} key cleanup failed`, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, "generated SSH key rollback was incomplete");
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
