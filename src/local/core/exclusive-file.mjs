import { renameSync, rmSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync, linkSync, fstatSync } from "node:fs";
import { clampInteger } from "../../shared/numbers.mjs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { openRegularFileSync, readBoundedRegularFileWithInfoSync, ownerOnlyFile, readBoundedRegularFileSync, retryTransientMultipleLinksSync, unlinkRegularFileIfIdentitySync } from "./secure-file.mjs";

const TRANSIENT_FILESYSTEM_MUTATION_ERRORS = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function replaceFileSync(source, target, options = {}) {
  const rename = typeof options.rename === "function" ? options.rename : renameSync;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const attempts = clampInteger(options.attempts, 32, 1, 64);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  const maxDelayMs = Math.max(baseDelayMs, clampInteger(options.maxDelayMs, 250, 0, 2000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, target);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === attempts) throw error;
      sleep(retryDelayMs(attempt, baseDelayMs, maxDelayMs, random));
    }
  }
  throw lastError || new Error("atomic file replacement failed");
}

export function isTransientReplaceError(error) {
  return isTransientFilesystemMutationError(error);
}

export function removePathSync(target, options = {}) {
  const remove = typeof options.remove === "function" ? options.remove : rmSync;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const attempts = clampInteger(options.attempts, 32, 1, 64);
  const baseDelayMs = clampInteger(options.baseDelayMs, 15, 0, 1000);
  const maxDelayMs = Math.max(baseDelayMs, clampInteger(options.maxDelayMs, 250, 0, 2000));
  const force = options.force === true;
  const recursive = options.recursive === true;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(target, { force, recursive });
      return { attempts: attempt, removed: true };
    } catch (error) {
      if (force && error?.code === "ENOENT") return { attempts: attempt, removed: false };
      lastError = error;
      if (!isTransientFilesystemMutationError(error) || attempt === attempts) throw error;
      sleep(retryDelayMs(attempt, baseDelayMs, maxDelayMs, random));
    }
  }
  throw lastError || new Error("filesystem removal failed");
}

export function isTransientFilesystemMutationError(error) {
  return TRANSIENT_FILESYSTEM_MUTATION_ERRORS.has(String(error?.code || ""));
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs, random) {
  if (baseDelayMs <= 0 || maxDelayMs <= 0) return 0;
  const exponential = Math.min(baseDelayMs * (2 ** Math.min(attempt - 1, 5)), maxDelayMs);
  const randomValue = Number(random());
  const normalizedRandom = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  const jitter = Math.floor(exponential * 0.5 * normalizedRandom);
  return Math.min(exponential + jitter, maxDelayMs);
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}
const STAGING_ARTIFACT = /^\.(?<base>.+)\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/;

const TRANSIENT_STAGING_ERRORS = new Set(["EACCES", "EBUSY", "EPERM", "EMFILE", "ENFILE", "EAGAIN", "ENOTEMPTY"]);

const STAGING_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Remove one staging artifact, tolerating the transient unlink errors that a filesystem
 * broker or indexer produces while the descriptor is still settling. A caller-visible
 * `ENOENT` means the artifact is already gone, which is success.
 */
export function retryStagingCleanupSync(remove, artifact, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      remove(artifact);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (attempt >= attempts || !TRANSIENT_STAGING_ERRORS.has(String(error?.code || ""))) throw error;
      Atomics.wait(STAGING_RETRY_BUFFER, 0, 0, attempt);
    }
  }
}

export function isPublicationStagingArtifactName(name) {
  return STAGING_ARTIFACT.test(String(name));
}

/**
 * Run a strict read, repairing an attributable publication residue (the exact `.tmp` alias
 * created by `createExclusiveFileSync`) and retrying. An unattributable second link is
 * repaired only when the caller explicitly opts in; normal security-state reads stay fail-closed.
 */
export function readWithPublicationRepairSync(read, target, options = {}) {
  try {
    return read();
  } catch (error) {
    if (error?.code !== "MBM_MULTIPLE_HARD_LINKS") throw error;
    const repair = repairExclusivePublicationLinksSync(target, { allowUnattributable: options.allowUnattributable === true });
    if (!repair.repaired) throw error;
    return read();
  }
}

/**
 * Restore the single-link invariant for an exclusively published file.
 *
 * Three states exist, and they are not equally repairable:
 *  - an internal staging alias survived its post-commit cleanup (removable by exact name);
 *  - a phantom link is counted but no second name exists in the publication directory, which
 *    is what a filesystem broker leaves behind after it reports a successful unlink;
 *  - a real second name exists in the publication directory. That name is somebody's file,
 *    so the repair refuses instead of silently reclaiming evidence.
 *
 * The repair never trusts multiply-linked content for a security decision: callers must
 * re-read the file through their normal strict path afterwards.
 */
export function repairExclusivePublicationLinksSync(target, options = {}) {
  const inspect = options.lstatSync || lstatSync;
  const remove = options.unlink || unlinkSync;
  let info = inspectIfPresent(target, inspect);
  if (!info) return { repaired: false, reason: "missing", removedAliases: [] };
  if (info.isSymbolicLink() || !info.isFile()) return { repaired: false, reason: "unsupported-type", removedAliases: [] };
  if (info.nlink <= 1n) return { repaired: false, reason: "clean", removedAliases: [] };
  const identity = filesystemIdentity(info, "exclusive publication target");
  const removedAliases = removePublicationAliases(target, identity, { inspect, remove });
  info = inspectIfPresent(target, inspect);
  if (!info) return { repaired: false, reason: "missing", removedAliases };
  if (info.nlink <= 1n && sameInode(identity, info)) {
    return { repaired: true, kind: "staging-alias", removedAliases };
  }
  if (info.nlink > 1n && options.allowUnattributable === true
    && !hasVisibleSecondLink(target, identity, options)) {
    if (republishSingleLinkSync(target, info, options)) return { repaired: true, kind: "replaced", removedAliases };
  }
  return { repaired: false, reason: "unattributable-links", removedAliases };
}

/**
 * Remove staging artifacts that no longer back any published name. A leftover alias whose
 * target is gone keeps link count one and only wastes directory entries, but it also makes
 * strict directory scans (waiter and lease enumeration) fail on an unexpected entry.
 */
export function sweepPublicationStagingArtifactsSync(directory, options = {}) {
  const inspect = options.lstatSync || lstatSync;
  const remove = options.unlink || unlinkSync;
  const read = options.readdirSync || readdirSync;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const minAgeMs = Number.isFinite(options.minAgeMs) ? Number(options.minAgeMs) : 0;
  let names;
  try {
    names = read(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const name of names) {
    if (!STAGING_ARTIFACT.test(name)) continue;
    const artifact = join(directory, name);
    const info = inspectIfPresent(artifact, inspect);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (info.nlink !== 1n) continue;
    if (now - Number(info.mtimeMs) < minAgeMs) continue;
    try {
      remove(artifact);
      removed.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }
  return removed;
}

/**
 * A link count above one only proves a phantom link when no other directory entry shares the
 * inode. A visible second name means the extra link is a real file, so the published name is
 * not republished over it.
 */
function hasVisibleSecondLink(target, identity, io) {
  const directory = dirname(target);
  const self = basename(target);
  let names;
  try {
    names = (io.readdirSync || readdirSync)(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    if (name === self) continue;
    const info = inspectIfPresent(join(directory, name), io.inspect || lstatSync);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (sameInode(identity, info)) return true;
  }
  return false;
}

function removePublicationAliases(target, identity, io) {
  const directory = dirname(target);
  const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}\\.[1-9][0-9]*\\.[a-f0-9]{16}\\.tmp$`);
  let names;
  try {
    names = (io.readdirSync || readdirSync)(directory);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const alias = join(directory, name);
    const info = inspectIfPresent(alias, io.inspect);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.nlink !== 2n) continue;
    if (!sameInode(identity, info)) continue;
    try {
      (io.remove)(alias);
      removed.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") return removed;
    }
  }
  return removed;
}

function republishSingleLinkSync(target, info, options) {
  const mode = Number(info.mode & 0o777n) || 0o600;
  const identity = filesystemIdentity(info, "exclusive publication target");
  const opened = openRegularFileSync(target, fsConstants.O_RDONLY, {
    label: "exclusive publication target",
    verifyPathIdentity: true,
  });
  let bytes;
  try {
    const size = Number(opened.info.size);
    if (!Number.isSafeInteger(size) || size < 0) return false;
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    bytes = bytes.subarray(0, offset);
  } finally {
    closeSync(opened.fd);
  }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, bytes);
    setDescriptorMode(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const current = inspectIfPresent(target, options.lstatSync || lstatSync);
    if (!current || !sameInode(identity, current) || current.nlink <= 1n) {
      throw Object.assign(new Error("exclusive publication target changed during repair"), { code: "MBM_IDENTITY_CHANGED" });
    }
    (options.replace || replaceFileSync)(temporary, target);
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* descriptor already unusable */ }
    }
    try { (options.unlink || unlinkSync)(temporary); } catch { /* leave the staging name for the sweep */ }
    return false;
  }
  const settled = inspectIfPresent(target, options.lstatSync || lstatSync);
  return Boolean(settled && settled.isFile() && !settled.isSymbolicLink() && settled.nlink === 1n && Number(settled.size) === bytes.length);
}

function inspectIfPresent(target, inspect) {
  try {
    return inspect(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameInode(identity, info) {
  return identity.dev === BigInt(info.dev) && identity.ino === BigInt(info.ino);
}

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
export function createExclusiveFileSync(target, content, options = {}) {
  const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
  const createLink = options.link || linkSync;
  const remove = options.unlink || unlinkSync;
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let ownsTemporary = false;
  let linked = false;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    fd = openSync(temporary, "wx", mode);
    ownsTemporary = true;
    writeFileSync(fd, content);
    setDescriptorMode(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    createLink(temporary, target);
    linked = true;
  } catch (error) {
    primaryError = normalizeExclusiveConflict(error, target);
  }

  if (fd !== undefined) {
    try { closeSync(fd); } catch (error) { cleanupErrors.push(error); }
  }
  let stagingCleanupError = null;
  if (ownsTemporary) {
    try { retryStagingCleanupSync(remove, temporary); } catch (error) {
      if (error?.code !== "ENOENT") { stagingCleanupError = error; cleanupErrors.push(error); }
    }
  }

  if (primaryError) {
    throw cleanupErrors.length
      ? new AggregateError([primaryError, ...cleanupErrors], "exclusive file creation failed and cleanup was incomplete")
      : primaryError;
  }
  if (!linked) throw new Error("exclusive file creation did not settle");
  const result = { created: true, path: target, publicationComplete: true, warnings: [] };
  if (stagingCleanupError) {
    result.warnings.push("Exclusive file committed, but its internal staging file could not be removed; the published name keeps a second link until it is repaired.");
    Object.defineProperties(result, {
      cleanupError: { value: stagingCleanupError, enumerable: false },
      cleanupArtifact: { value: temporary, enumerable: false },
    });
  } else if (linkCountOf(target) > 1) {
    result.warnings.push("Published name kept a second hard link after commit; inspect the owning state directory and, for resource coordinator state, run doctor --repair-resource-coordinator to restore it.");
  }
  result.publicationComplete = result.warnings.length === 0;
  return result;
}

export function replaceFileAtomicallySync(target, content, options = {}) {
  const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
  const remove = options.unlink || unlinkSync;
  const replace = options.replace || replaceFileSync;
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let ownsTemporary = false;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    fd = openSync(temporary, "wx", mode);
    ownsTemporary = true;
    writeFileSync(fd, content);
    setDescriptorMode(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    replace(temporary, target);
    return { replaced: true, path: target };
  } catch (error) {
    primaryError = error;
  }
  if (fd !== undefined) {
    try { closeSync(fd); } catch (error) { cleanupErrors.push(error); }
  }
  if (ownsTemporary) {
    try { remove(temporary); } catch (error) { if (error?.code !== "ENOENT") cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError([primaryError, ...cleanupErrors], "atomic file replacement failed and cleanup was incomplete");
  }
  throw primaryError;
}

export function removeOwnedJsonFileSync(target, expected = {}, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 4096;
  const allowedMultipleLinkIdentity = options.allowedMultipleLinkIdentity || null;
  let snapshot;
  try {
    snapshot = ownedJsonSnapshot(target, maxBytes, allowedMultipleLinkIdentity);
  } catch (error) {
    if (error?.code !== "MBM_MULTIPLE_HARD_LINKS" || options.repairLinks === false) throw error;
    const repair = repairExclusivePublicationLinksSync(target, { allowUnattributable: options.allowUnattributableLinks === true, ...(options.repairOptions || {}) });
    if (!repair.repaired) throw error;
    snapshot = ownedJsonSnapshot(target, maxBytes, allowedMultipleLinkIdentity);
  }
  if (!snapshot || !matchesExpected(snapshot.value, expected)) return false;
  let current;
  try { current = lstatSync(target, { bigint: true }); } catch (error) { return error?.code === "ENOENT"; }
  const currentIdentity = filesystemIdentity(current, "owned JSON snapshot");
  const allowedLinkCount = current.nlink === 1n
    || (current.nlink === 2n && sameFilesystemIdentity(allowedMultipleLinkIdentity, currentIdentity));
  if (current.isSymbolicLink() || !current.isFile() || !allowedLinkCount || !sameIdentity(snapshot.info, current)) return false;
  const currentSnapshot = ownedJsonSnapshot(target, maxBytes, allowedMultipleLinkIdentity);
  if (!currentSnapshot || !sameIdentity(snapshot.info, currentSnapshot.info) || !matchesExpected(currentSnapshot.value, expected)) return false;
  try { unlinkSync(target); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function ownedJsonSnapshot(target, maxBytes, allowedMultipleLinkIdentity = null) {
  let opened;
  try {
    opened = readBoundedRegularFileWithInfoSync(target, maxBytes, "owned JSON snapshot", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity,
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(opened.buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { value, info: opened.identityInfo };
  } catch { return null; }
}

function linkCountOf(target) { try { return Number(lstatSync(target, { bigint: true }).nlink); } catch { return 0; } }

function matchesExpected(value, expected) {
  return Object.entries(expected).every(([key, expectedValue]) => value?.[key] === expectedValue);
}

/**
 * Report contention even when the failing link is surfaced through an interposed filesystem
 * layer that replaces the errno code. A hard link can only fail because the target name is
 * taken, so an existing target is proof of conflict regardless of the reported code.
 */
function normalizeExclusiveConflict(error, target) {
  if (error?.code === "EEXIST") return error;
  try {
    lstatSync(target);
  } catch {
    return error;
  }
  return Object.assign(new Error("exclusive target already exists", { cause: error }), { code: "EEXIST" });
}

function sameIdentity(left, right) {
  return sameFilesystemIdentity(filesystemIdentity(left, "owned JSON snapshot"), filesystemIdentity(right, "owned JSON snapshot"));
}
export function readExclusivePublicationFileSync(target, maxBytes, label, options = {}) {
  return retryTransientMultipleLinksSync((residueIdentity) => {
    if (!residueIdentity && options.ownerPrivate === true) ownerOnlyFile(target);
    return readBoundedRegularFileSync(target, maxBytes, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: residueIdentity,
      afterOpen: options.ownerPrivate === true ? assertOwnerPrivateMode : undefined,
    });
  }, { verifyResidue: () => verifyExclusiveFilePublicationResidueSync(target) });
}

export function verifyExclusiveFilePublicationResidueSync(target) {
  let openedTarget;
  try {
    openedTarget = openRegularFileSync(target, fsConstants.O_RDONLY, {
      label: "exclusive publication target",
      verifyPathIdentity: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  try {
    if (Number(openedTarget.info.nlink) !== 2) return null;
    const directory = dirname(target);
    const escapedBase = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stagingPattern = new RegExp(`^\\.${escapedBase}\\.[1-9][0-9]*\\.[a-f0-9]{16}\\.tmp$`);
    let matchingAliases = 0;
    for (const name of readdirSync(directory)) {
      if (!stagingPattern.test(name)) continue;
      let openedAlias;
      try {
        openedAlias = openRegularFileSync(join(directory, name), fsConstants.O_RDONLY, {
          label: "exclusive publication staging alias",
          verifyPathIdentity: true,
        });
      } catch (error) {
        if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") continue;
        return null;
      }
      try {
        if (Number(openedAlias.info.nlink) === 2
          && sameFilesystemIdentity(openedTarget.identity, openedAlias.identity)) matchingAliases += 1;
      } finally { closeSync(openedAlias.fd); }
      if (matchingAliases > 1) return null;
    }
    if (matchingAliases !== 1) return null;
    const settled = fstatSync(openedTarget.fd, { bigint: true });
    if (!settled.isFile() || settled.nlink !== 2n) return null;
    const settledIdentity = filesystemIdentity(settled, "exclusive publication settled target");
    return sameFilesystemIdentity(openedTarget.identity, settledIdentity) ? openedTarget.identity : null;
  } finally { closeSync(openedTarget.fd); }
}

function assertOwnerPrivateMode({ info }) {
  if (process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0) {
    throw new Error("exclusive publication file is not owner-private");
  }
}

export function snapshotFileIdentitySync(file) {
  const opened = openRegularFileSync(file, fsConstants.O_RDONLY, { verifyPathIdentity: true, rejectMultipleLinks: true });
  try { return opened.identity; } finally { closeSync(opened.fd); }
}

export async function publishFileLinkWithIdentity(source, target, publish, record, expectedSourceIdentity = null) {
  const opened = openRegularFileSync(source, fsConstants.O_RDONLY, { verifyPathIdentity: true, rejectMultipleLinks: true });
  try {
    if (expectedSourceIdentity && !sameFilesystemIdentity(expectedSourceIdentity, opened.identity)) {
      throw new Error("file snapshot changed before publication; preserved for inspection");
    }
    await publish(source, target);
    record.targetCreated = true;
    const info = fstatSync(opened.fd, { bigint: true });
    const identity = filesystemIdentity(info, "published file snapshot");
    const current = lstatSync(target, { bigint: true });
    if (!info.isFile() || info.nlink !== 2n || !current.isFile() || current.nlink !== 2n
        || !sameFilesystemIdentity(identity, filesystemIdentity(current))) {
      throw new Error("published target changed before confirmation; preserved for inspection");
    }
    record.targetIdentity = identity;
  } finally { closeSync(opened.fd); }
}

export async function removeLinkedFileSnapshot(file, expectedIdentity, remove) {
  let current;
  try { current = lstatSync(file, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!current.isFile() || current.nlink !== 2n || !sameFilesystemIdentity(expectedIdentity, filesystemIdentity(current))) {
    throw new Error("linked file snapshot changed before removal; preserved for inspection");
  }
  await remove(file, { force: true });
}

export async function restoreFileSnapshotNoReplace(backup, target, publish, remove, expectedIdentity) {
  if (!expectedIdentity) throw new Error("file snapshot identity is unavailable; preserved for inspection");
  const restored = {};
  await publishFileLinkWithIdentity(backup, target, publish, restored, expectedIdentity);
  await removeLinkedFileSnapshot(backup, restored.targetIdentity, remove);
}
export function preserveFileSnapshotSync(source, target, content, expectedIdentity, options = {}) {
  const label = String(options.label || "file snapshot source");
  const create = options.create || createExclusiveFileSync;
  const unlinkSource = options.unlinkSource || unlinkRegularFileIfIdentitySync;
  const unlinkBackup = options.unlinkBackup || unlinkSync;
  const created = create(target, content, { mode: Number.isInteger(options.mode) ? options.mode : 0o600 });
  let primaryError = null;
  try {
    if (!unlinkSource(source, expectedIdentity, label)) {
      primaryError = new Error(`${label} changed before snapshot preservation completed`);
    }
  } catch (error) { primaryError = error; }
  if (!primaryError) return created;
  try { unlinkBackup(target); } catch (cleanupError) {
    if (cleanupError?.code !== "ENOENT") {
      throw new AggregateError([primaryError, cleanupError], `${label} changed and snapshot cleanup was incomplete`);
    }
  }
  throw primaryError;
}
