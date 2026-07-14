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
import { readBoundedRegularFileSync } from "./secure-file.mjs";

export function createExclusiveFileSync(target, content, options = {}) {
  const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let linked = false;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, content);
    setDescriptorMode(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, target);
    linked = true;
    return { created: true, path: target };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    if (!linked && options.cleanupTargetOnFailure === true) {
      try { unlinkSync(target); } catch {}
    }
  }
}

export function replaceFileAtomicallySync(target, content, options = {}) {
  const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, content);
    setDescriptorMode(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    replaceFileSync(temporary, target);
    return { replaced: true, path: target };
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function removeOwnedJsonFileSync(target, expected = {}, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 4096;
  const snapshot = ownedJsonSnapshot(target, maxBytes);
  if (!snapshot || !matchesExpected(snapshot.value, expected)) return false;
  let current;
  try { current = lstatSync(target); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(snapshot.info, current)) return false;
  const currentSnapshot = ownedJsonSnapshot(target, maxBytes);
  if (!currentSnapshot || !sameIdentity(snapshot.info, currentSnapshot.info) || !matchesExpected(currentSnapshot.value, expected)) return false;
  try { unlinkSync(target); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function ownedJsonSnapshot(target, maxBytes) {
  let info;
  try { info = lstatSync(target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  try {
    const value = JSON.parse(readBoundedRegularFileSync(target, maxBytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { value, info };
  } catch {
    return null;
  }
}

function matchesExpected(value, expected) {
  return Object.entries(expected).every(([key, expectedValue]) => value?.[key] === expectedValue);
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs);
}

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
