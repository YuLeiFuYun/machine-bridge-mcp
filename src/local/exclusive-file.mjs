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
    primaryError = error;
  }

  if (fd !== undefined) {
    try { closeSync(fd); } catch (error) { cleanupErrors.push(error); }
  }
  let stagingCleanupError = null;
  if (ownsTemporary) {
    try { remove(temporary); } catch (error) {
      if (error?.code !== "ENOENT") {
        stagingCleanupError = error;
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError) {
    if (cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], "exclusive file creation failed and cleanup was incomplete");
    }
    throw primaryError;
  }
  if (!linked) throw new Error("exclusive file creation did not settle");
  const result = { created: true, path: target, warnings: [] };
  if (stagingCleanupError) {
    result.warnings.push("Exclusive file committed, but its internal staging file could not be removed.");
    Object.defineProperties(result, {
      cleanupError: { value: stagingCleanupError, enumerable: false },
      cleanupArtifact: { value: temporary, enumerable: false },
    });
  }
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
  const snapshot = ownedJsonSnapshot(target, maxBytes, allowedMultipleLinkIdentity);
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

function matchesExpected(value, expected) {
  return Object.entries(expected).every(([key, expectedValue]) => value?.[key] === expectedValue);
}

function sameIdentity(left, right) {
  return sameFilesystemIdentity(filesystemIdentity(left, "owned JSON snapshot"), filesystemIdentity(right, "owned JSON snapshot"));
}

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
