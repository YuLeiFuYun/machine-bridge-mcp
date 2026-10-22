import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { replaceFileSync } from "./atomic-fs.mjs";
import { filesystemIdentity } from "./filesystem-identity.mjs";
import { openRegularFileSync } from "./secure-file.mjs";

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
