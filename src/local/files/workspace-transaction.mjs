// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { open, rename as fsRename, link, mkdir, rename, rm } from "node:fs/promises";
import { BridgeError } from "../core/errors.mjs";
import { isTransientFilesystemMutationError, publishFileLinkWithIdentity, removeLinkedFileSnapshot, restoreFileSnapshotNoReplace, snapshotFileIdentitySync } from "../core/exclusive-file.mjs";
import { clampInteger } from "../../shared/numbers.mjs";
import { basename, dirname, join } from "node:path";
import { fileMutationPathKey, pathEntryIfExists } from "../core/filesystem-identity.mjs";

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
/** @param {string} source @param {string} target @param {(source: string, target: string) => Promise<void>} [move] @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number}} [options] */
export async function renameWithRetry(source, target, move = fsRename, options = {}) {
  const attempts = clampInteger(options.attempts, 32, 1, 64);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  const maxDelayMs = Math.max(baseDelayMs, clampInteger(options.maxDelayMs, 250, 0, 2000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await move(source, target);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientFilesystemMutationError(error) || attempt === attempts) throw error;
      const exponential = Math.min(baseDelayMs * (2 ** Math.min(attempt - 1, 5)), maxDelayMs);
      const jitter = Math.floor(exponential * 0.5 * Math.random());
      await new Promise((resolve) => { setTimeout(resolve, Math.min(exponential + jitter, maxDelayMs)); });
    }
  }
  throw lastError || new Error("atomic file replacement failed");
}
/** @typedef {{kind: string, source?: string, target: string, content?: string, originalHash?: string, mode?: number}} PatchOperation */
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
  const verifyPrecondition = async () => {
    if (!options.expectedHash) return;
    let current;
    try { current = await readText(full); } catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw new BridgeError("conflict", "file changed before atomic commit", { cause: error, details: { reason: "precondition_target_missing" } });
      throw error;
    }
    if (sha256(current) !== options.expectedHash) throw new BridgeError("conflict", "file changed before atomic commit", { details: { reason: "hash_mismatch" } });
  };
  try {
    await writeFlushedText(temp, content, existing ? existing.mode & 0o777 : 0o600, remove);
    staged = true;
    if (options.createOnly) {
      await verifyPrecondition();
      await createTarget(temp, full);
      const cleanupFailures = await removeArtifacts([temp], remove);
      staged = cleanupFailures.length > 0;
      return {
        warnings: cleanupFailures.length
          ? ["File committed, but its internal staging link could not be removed; inspect the target directory for a .mbm-*.tmp artifact."]
          : [],
      };
    }
    await renameWithRetry(temp, full, async (source, target) => {
      await verifyPrecondition();
      await move(source, target);
    });
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
export class BoundedOutput {
  /** @param {unknown} maximumBytes @param {{headBytes?: number}} [options] */
  constructor(maximumBytes, options = {}) {
    const maximum = Number(maximumBytes);
    if (!Number.isFinite(maximum) || maximum < 1) throw new Error("maximum output bytes must be positive");
    this.maximum = Math.floor(maximum);
    this.headLimit = Math.max(1, Math.min(this.maximum, Math.floor(Number(options.headBytes) || this.maximum / 3)));
    this.tailLimit = Math.max(0, this.maximum - this.headLimit);
    this.totalBytes = 0;
    this.truncated = false;
    this.fullBuffer = Buffer.alloc(this.maximum);
    this.fullBytes = 0;
    this.head = Buffer.alloc(0);
    this.tailBuffer = Buffer.alloc(this.tailLimit);
    this.tailWriteOffset = 0;
    this.tailBytes = 0;
  }

  get full() {
    return this.truncated ? null : Buffer.from(this.fullBuffer.subarray(0, this.fullBytes));
  }

  get tail() {
    if (!this.tailLimit || !this.tailBytes) return Buffer.alloc(0);
    const start = (this.tailWriteOffset - this.tailBytes + this.tailLimit) % this.tailLimit;
    const end = start + this.tailBytes;
    if (end <= this.tailLimit) return Buffer.from(this.tailBuffer.subarray(start, end));
    return Buffer.concat([
      this.tailBuffer.subarray(start),
      this.tailBuffer.subarray(0, end - this.tailLimit),
    ], this.tailBytes);
  }

  /** @param {unknown} chunk */
  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!bytes.length) return;
    this.totalBytes += bytes.length;

    if (!this.truncated && this.fullBytes + bytes.length <= this.maximum) {
      this.fullBuffer.set(bytes, this.fullBytes);
      this.fullBytes += bytes.length;
      return;
    }

    if (!this.truncated) {
      const previous = this.fullBuffer.subarray(0, this.fullBytes);
      const missing = Math.max(0, this.headLimit - previous.length);
      this.head = Buffer.concat([previous.subarray(0, this.headLimit), bytes.subarray(0, missing)]);
      this.truncated = true;
      appendCircularTail(this, previous);
    }
    appendCircularTail(this, bytes);
  }

  get truncatedBytes() {
    if (!this.truncated) return 0;
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    return Math.max(0, this.totalBytes - head.bytes - tail.bytes);
  }

  text() {
    if (!this.truncated) return this.fullBuffer.subarray(0, this.fullBytes).toString("utf8");
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    const omitted = Math.max(0, this.totalBytes - head.bytes - tail.bytes);
    const marker = `\n\n[truncated ${omitted} bytes; preserved beginning and end]\n\n`;
    return `${head.text}${marker}${tail.text}`;
  }

}

/** @param {{tailLimit: number, tailBuffer: Buffer, tailWriteOffset: number, tailBytes: number}} output @param {Buffer} bytes */
function appendCircularTail(output, bytes) {
  if (!output.tailLimit || !bytes.length) return;
  if (bytes.length >= output.tailLimit) {
    output.tailBuffer.set(bytes.subarray(bytes.length - output.tailLimit));
    output.tailWriteOffset = 0;
    output.tailBytes = output.tailLimit;
    return;
  }
  const first = Math.min(bytes.length, output.tailLimit - output.tailWriteOffset);
  output.tailBuffer.set(bytes.subarray(0, first), output.tailWriteOffset);
  if (first < bytes.length) output.tailBuffer.set(bytes.subarray(first), 0);
  output.tailWriteOffset = (output.tailWriteOffset + bytes.length) % output.tailLimit;
  output.tailBytes = Math.min(output.tailLimit, output.tailBytes + bytes.length);
}

/** @param {Buffer} buffer @param {"head" | "tail"} side */
function decodeUtf8Boundary(buffer, side) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const slice = side === "head"
      ? buffer.subarray(0, buffer.length - trim)
      : buffer.subarray(trim);
    try { return { text: decoder.decode(slice), bytes: slice.length }; } catch { /* try the next code-point boundary */ }
  }
  return { text: new TextDecoder("utf-8").decode(buffer), bytes: buffer.length };
}
