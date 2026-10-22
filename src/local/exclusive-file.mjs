import { randomBytes } from "node:crypto";
import {
  fchmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { replaceFileSync } from "./atomic-fs.mjs";
import { readBoundedRegularFileWithInfoSync } from "./secure-file.mjs";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { repairExclusivePublicationLinksSync, retryStagingCleanupSync } from "./exclusive-publication-repair.mjs";

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

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
