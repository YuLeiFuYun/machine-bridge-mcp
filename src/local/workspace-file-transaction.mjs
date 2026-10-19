// @ts-check
import { randomBytes } from "node:crypto";
import { link, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { fileMutationPathKey } from "./file-mutation-coordinator.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";
import { publishFileLinkWithIdentity, removeLinkedFileSnapshot, restoreFileSnapshotNoReplace, snapshotFileIdentitySync } from "./exclusive-publication-recovery.mjs";
import { renameWithRetry } from "./workspace-file-rename-retry.mjs";
import { hasErrorCode, incompleteMutationError, patchRecoveryIncompleteError, removeArtifacts, requiredReadText, sha256, writeFlushedText } from "./workspace-file-transaction-helpers.mjs";
export { sha256 } from "./workspace-file-transaction-helpers.mjs";

/** @typedef {{kind: string, source?: string, target: string, content?: string, originalHash?: string, mode?: number}} PatchOperation */
/** @typedef {(path: string) => Promise<string>} ReadText */
/** @typedef {(path: string, options?: {force?: boolean}) => Promise<unknown>} RemovePath */
/** @typedef {{expectedHash?: string, createOnly?: boolean, readText?: ReadText, remove?: RemovePath, link?: (source: string, target: string) => Promise<void>, rename?: (source: string, target: string) => Promise<void>, pathEntryIfExists?: (path: string) => Promise<import('node:fs').Stats | null>, restoreLink?: (source: string, target: string) => Promise<void>}} FileTransactionOptions */

/** @param {string} full @param {string} content @param {{mode: number} | null} [existing] @param {FileTransactionOptions} [options] */
export async function atomicWriteText(full, content, existing = null, options = {}) {
  const readText = requiredReadText(options.readText, Boolean(options.expectedHash));
  const remove = options.remove || rm;
  const createTarget = options.link || link;
  const move = options.rename || rename;
  await mkdir(dirname(full), { recursive: true });
  const temp = join(dirname(full), `.${basename(full)}.mbm-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let staged = false;
  try {
    await writeFlushedText(temp, content, existing ? existing.mode & 0o777 : 0o600, remove);
    staged = true;
    if (options.expectedHash) {
      let current;
      try { current = await readText(full); } catch (error) {
        if (hasErrorCode(error, "ENOENT")) throw new BridgeError("conflict", "file changed before atomic commit", { cause: error, details: { reason: "precondition_target_missing" } });
        throw error;
      }
      if (sha256(current) !== options.expectedHash) throw new BridgeError("conflict", "file changed before atomic commit", { details: { reason: "hash_mismatch" } });
    }
    if (options.createOnly) {
      await createTarget(temp, full);
      const cleanupFailures = await removeArtifacts([temp], remove);
      staged = cleanupFailures.length > 0;
      return {
        warnings: cleanupFailures.length
          ? ["File committed, but its internal staging link could not be removed; inspect the target directory for a .mbm-*.tmp artifact."]
          : [],
      };
    }
    await renameWithRetry(temp, full, move);
    return { warnings: [] };
  } catch (error) {
    if (!staged) throw error;
    const cleanupFailures = await removeArtifacts([temp], remove);
    if (cleanupFailures.length) throw incompleteMutationError("file mutation failed and staging cleanup was incomplete", error, cleanupFailures);
    throw error;
  }
}
/** @param {PatchOperation[]} operations @param {string} [platform] */
export function assertNoResolvedPatchCollisions(operations, platform = process.platform) {
  const owners = new Map();
  for (const operation of operations) {
    const paths = operation.source === operation.target
      ? [operation.source]
      : [operation.source, operation.target].filter(Boolean);
    for (const full of paths) {
      const key = fileMutationPathKey(full, platform);
      const previous = owners.get(key);
      if (previous && previous !== operation) throw new BridgeError("conflict", "patch operations resolve to the same path", { details: { reason: "resolved_path_collision" } });
      owners.set(key, operation);
    }
  }
}

/** @param {PatchOperation[]} operations @param {FileTransactionOptions} [options] */
export async function commitPatchTransaction(operations, options = {}) {
  const readText = requiredReadText(options.readText, operations.some((operation) => operation.source));
  const move = options.rename || rename;
  const createTarget = options.link || link;
  const remove = options.remove || rm;
  const exists = options.pathEntryIfExists || pathEntryIfExists;
  /** @type {{operation: PatchOperation, temp: string}[]} */
  const staged = [];
  /** @type {{operation: PatchOperation, backup: string | null, targetCreated: boolean, backupIdentity?: unknown, targetIdentity?: unknown}[]} */
  const committed = [];
  try {
    for (const operation of operations) {
      if (operation.content === undefined) continue;
      await mkdir(dirname(operation.target), { recursive: true });
      const temp = join(dirname(operation.target), `.${basename(operation.target)}.mbm-patch-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      await writeFlushedText(temp, operation.content, operation.mode ?? 0o600, remove);
      staged.push({ operation, temp });
    }

    for (const operation of operations) {
      if (operation.source) {
        const current = await readText(operation.source);
        if (sha256(current) !== operation.originalHash) throw new BridgeError("conflict", "patch source changed during apply", { details: { reason: "hash_mismatch" } });
      }
      if ((operation.kind === "add" || operation.kind === "move") && await exists(operation.target)) {
        throw new BridgeError("conflict", "patch target appeared during apply", { details: { reason: "target_appeared" } });
      }
    }

    for (const operation of operations) {
      let backup = null;
      if (operation.source) {
        backup = join(dirname(operation.source), `.${basename(operation.source)}.mbm-backup-${process.pid}-${randomBytes(6).toString("hex")}`);
        await move(operation.source, backup);
      }
      /** @type {{operation: PatchOperation, backup: string | null, targetCreated: boolean, backupIdentity?: unknown, targetIdentity?: unknown}} */
      const record = { operation, backup, targetCreated: false };
      committed.push(record);
      if (backup) record.backupIdentity = snapshotFileIdentitySync(backup);
      if (backup && sha256(await readText(backup)) !== operation.originalHash) {
        throw new BridgeError("conflict", "patch source changed during commit", { details: { reason: "hash_mismatch" } });
      }
      const stage = staged.find((item) => item.operation === operation);
      if (!stage) continue;
      try {
        await publishFileLinkWithIdentity(stage.temp, operation.target, createTarget, record);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          throw new BridgeError("conflict", "patch target appeared during apply", { cause: error, details: { reason: "target_appeared" } });
        }
        throw error;
      }
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const item of [...committed].reverse()) {
      if (item.targetCreated) {
        try { await removeLinkedFileSnapshot(item.operation.target, item.targetIdentity, remove); } catch (failure) { rollbackFailures.push(failure); }
      }
      if (item.backup) {
        try { await restoreFileSnapshotNoReplace(item.backup, item.operation.source, options.restoreLink || link, remove, item.backupIdentity); } catch (failure) { rollbackFailures.push(failure); }
      }
    }
    const stagingCleanupFailures = await removeArtifacts(staged.map((item) => item.temp), remove);
    if (rollbackFailures.length) throw patchRecoveryIncompleteError(error, [...rollbackFailures, ...stagingCleanupFailures]);
    if (stagingCleanupFailures.length) throw incompleteMutationError("patch transaction failed and staging cleanup was incomplete", error, stagingCleanupFailures);
    throw error;
  }

  const cleanupFailures = await removeArtifacts([
    ...staged.map((item) => item.temp),
    ...committed.map((item) => item.backup).filter((value) => typeof value === "string"),
  ], remove);
  return {
    warnings: cleanupFailures.length
      ? [`Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed; inspect affected directories for .mbm-backup-* or .mbm-patch-* files.`]
      : [],
  };
}
