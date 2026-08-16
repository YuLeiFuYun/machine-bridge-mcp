// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { fileMutationPathKey } from "./file-mutation-coordinator.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";
export async function atomicWriteText(full, content, existing = null, options = {}) {
  const readText = requiredReadText(options.readText, options.expectedHash);
  if (options.expectedHash && existing && !options.createOnly) return commitPatchTransaction([{
    kind: "update", source: full, target: full, content, originalHash: options.expectedHash, mode: existing.mode & 0o777,
  }], { ...options, readText });
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
        if (error?.code === "ENOENT") throw new BridgeError("conflict", "file changed before atomic commit", { cause: error, details: { reason: "precondition_target_missing" } });
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
    await move(temp, full);
    return { warnings: [] };
  } catch (error) {
    if (!staged) throw error;
    const cleanupFailures = await removeArtifacts([temp], remove);
    if (cleanupFailures.length) throw incompleteMutationError("file mutation failed and staging cleanup was incomplete", error, cleanupFailures);
    throw error;
  }
}

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

export async function commitPatchTransaction(operations, options = {}) {
  const readText = requiredReadText(options.readText, operations.some((operation) => operation.source));
  const move = options.rename || rename;
  const createTarget = options.link || link;
  const remove = options.remove || rm;
  const exists = options.pathEntryIfExists || pathEntryIfExists;
  const staged = [];
  const committed = [];
  try {
    for (const operation of operations) {
      if (operation.content === undefined) continue;
      await mkdir(dirname(operation.target), { recursive: true });
      const temp = join(dirname(operation.target), `.${basename(operation.target)}.mbm-patch-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      await writeFlushedText(temp, operation.content, operation.mode, remove);
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
      const record = { operation, backup, targetCreated: false };
      committed.push(record);
      if (backup && sha256(await readText(backup)) !== operation.originalHash) {
        throw new BridgeError("conflict", "patch source changed during commit", { details: { reason: "hash_mismatch" } });
      }
      const stage = staged.find((item) => item.operation === operation);
      if (!stage) continue;
      try {
        await createTarget(stage.temp, operation.target);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new BridgeError("conflict", "patch target appeared during apply", { cause: error, details: { reason: "target_appeared" } });
        }
        throw error;
      }
      record.targetCreated = true;
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const item of [...committed].reverse()) {
      if (item.targetCreated) {
        try { await remove(item.operation.target, { force: true }); } catch (failure) { rollbackFailures.push(failure); }
      }
      if (item.backup) {
        try { await move(item.backup, item.operation.source); } catch (failure) { rollbackFailures.push(failure); }
      }
    }
    const stagingCleanupFailures = await removeArtifacts(staged.map((item) => item.temp), remove);
    if (rollbackFailures.length) throw patchRecoveryIncompleteError(error, [...rollbackFailures, ...stagingCleanupFailures]);
    if (stagingCleanupFailures.length) throw incompleteMutationError("patch transaction failed and staging cleanup was incomplete", error, stagingCleanupFailures);
    throw error;
  }

  const cleanupFailures = await removeArtifacts([
    ...staged.map((item) => item.temp),
    ...committed.map((item) => item.backup).filter(Boolean),
  ], remove);
  return {
    warnings: cleanupFailures.length
      ? [`Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed; inspect affected directories for .mbm-backup-* or .mbm-patch-* files.`]
      : [],
  };
}
export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function writeFlushedText(filePath, content, mode, remove) {
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
async function removeArtifacts(paths, remove) {
  const failures = [];
  for (const path of paths) {
    try { await remove(path, { force: true }); } catch (error) { failures.push(error); }
  }
  return failures;
}
function patchRecoveryIncompleteError(primary, recoveryFailures) {
  const message = "patch transaction may have partially modified files because recovery was incomplete; inspect affected paths before retrying";
  return new BridgeError("execution_failed", message, {
    cause: new AggregateError([primary, ...recoveryFailures], message),
    expose: true,
    retryable: false,
    details: { reason: "patch_recovery_incomplete" },
  });
}
function incompleteMutationError(message, primary, cleanupFailures) {
  return new BridgeError("internal_error", message, {
    cause: new AggregateError([primary, ...cleanupFailures], message),
    expose: false,
  });
}

function requiredReadText(value, required) {
  if (typeof value === "function") return value;
  if (required) throw new TypeError("workspace file transaction requires a bounded text reader");
  return async () => { throw new TypeError("workspace file transaction text reader was not configured"); };
}
