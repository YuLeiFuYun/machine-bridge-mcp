import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";

const MULTIPLE_LINK_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));
export function openRegularFileSync(file, flags, options = {}) {
  const mode = Number.isInteger(options.mode) ? options.mode : undefined;
  const label = String(options.label || "path");
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = mode === undefined
      ? openSync(file, Number(flags) | noFollow)
      : openSync(file, Number(flags) | noFollow, mode);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label} must not be a symbolic link`, { cause: error });
    throw error;
  }
  try {
    const inspectDescriptor = options.fstatSync || fstatSync;
    const info = inspectDescriptor(fd);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    const descriptorIdentityInfo = options.fstatSync ? info : fstatSync(fd, { bigint: true });
    const identity = filesystemIdentity(descriptorIdentityInfo, label);
    if (options.rejectMultipleLinks === true && Number(info.nlink) > 1) {
      throw Object.assign(new Error(`${label} must not have multiple hard links`), { code: "MBM_MULTIPLE_HARD_LINKS" });
    }
    if (options.verifyPathIdentity === true) {
      const inspectPath = options.lstatSync || lstatSync;
      const pathInfo = inspectPath(file);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`${label} must be a regular file and not a symbolic link`);
      const pathIdentityInfo = options.lstatSync ? pathInfo : lstatSync(file, { bigint: true });
      if (!sameFilesystemIdentity(identity, filesystemIdentity(pathIdentityInfo, label))) {
        throw Object.assign(new Error(`${label} identity changed while opening`), { code: "MBM_IDENTITY_CHANGED" });
      }
    }
    if (Number.isInteger(options.chmod)) setDescriptorMode(fd, options.chmod);
    return { fd, info, identity, identityInfo: descriptorIdentityInfo };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function withRegularFileSync(file, flags, options, callback) {
  const opened = openRegularFileSync(file, flags, options);
  try {
    return callback(opened.fd, opened.info, opened.identity, opened.identityInfo);
  } finally {
    closeSync(opened.fd);
  }
}

export function retryTransientMultipleLinksSync(callback, options = {}) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return callback(); }
    catch (error) {
      if (error?.code !== "MBM_MULTIPLE_HARD_LINKS") throw error;
      if (attempt === 4 && typeof options.recover === "function" && options.recover() === true) return callback();
      if (attempt === 4) throw error;
      Atomics.wait(MULTIPLE_LINK_RETRY_BUFFER, 0, 0, 1);
    }
  }
  throw new Error("transient multiple-link retry did not settle");
}
export function chmodRegularFileSync(file, mode, label = "path") {
  return withRegularFileSync(file, fsConstants.O_RDONLY, { label, chmod: mode, rejectMultipleLinks: true }, () => undefined);
}

export function chmodRegularFileIfIdentitySync(file, expectedIdentity, mode, label = "path") {
  return withRegularFileSync(file, fsConstants.O_RDONLY, { label, rejectMultipleLinks: true }, (fd, _info, identity) => {
    if (!sameFilesystemIdentity(expectedIdentity, identity)) throw new Error(`${label} changed before permission update`);
    setDescriptorMode(fd, mode);
  });
}

export function ownerOnlyFile(filePath) {
  return chmodRegularFileSync(filePath, 0o600, "owner-only path");
}

export function unlinkRegularFileIfIdentitySync(file, expectedIdentity, label = "file") {
  let current;
  try { current = lstatSync(file, { bigint: true }); } catch (error) {
    if (String(/** @type {any} */ (error)?.code || "") === "ENOENT") return false;
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
      || !sameFilesystemIdentity(expectedIdentity, filesystemIdentity(current, label))) return false;
  try { unlinkSync(file); return true; } catch (error) {
    if (String(/** @type {any} */ (error)?.code || "") === "ENOENT") return false;
    throw error;
  }
}


export function inspectPathIfPresentSync(file, label = "path", options = {}) {
  const inspect = options.lstatSync || lstatSync;
  try { return inspect(file); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} could not be inspected`, { cause: error });
  }
}

export function readBoundedRegularFileSync(file, maxBytes, label = "path", options = {}) {
  return readBoundedRegularFileWithInfoSync(file, maxBytes, label, options).buffer;
}

export function readBoundedRegularFileWithInfoSync(file, maxBytes, label = "path", options = {}) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maximum file size must be a non-negative safe integer");
  return withRegularFileSync(file, fsConstants.O_RDONLY, {
    label,
    verifyPathIdentity: options.verifyPathIdentity === true,
    rejectMultipleLinks: options.rejectMultipleLinks === true,
  }, (fd, info, identity, identityInfo) => {
    if (info.size > limit) throw new Error(`file exceeds ${limit} bytes`);
    options.afterOpen?.({ fd, info });
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return { buffer: buffer.subarray(0, offset), info, identity, identityInfo };
  });
}

export function ensureOwnerOnlyDirectorySync(dir, options = {}) {
  const platform = String(options.platform || process.platform);
  const makeDirectory = options.mkdirSync || mkdirSync;
  const inspectPath = options.lstatSync || lstatSync;
  makeDirectory(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const info = inspectPath(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("owner-only path must be a real directory");
    return info;
  }

  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  const directoryOnly = Number(fsConstants.O_DIRECTORY || 0);
  if (!noFollow || !directoryOnly) throw new Error("secure owner-only directory descriptors are unavailable on this platform");
  const open = options.openSync || openSync;
  const inspectDescriptor = options.fstatSync || fstatSync;
  const restrictDescriptor = options.fchmodSync || fchmodSync;
  const close = options.closeSync || closeSync;
  let fd;
  try {
    fd = open(dir, Number(fsConstants.O_RDONLY) | noFollow | directoryOnly);
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw new Error("owner-only path must be a real directory and not a symbolic link", { cause: error });
    throw error;
  }
  try {
    let info = inspectDescriptor(fd);
    if (!info.isDirectory()) throw new Error("owner-only path must be a directory");
    try {
      restrictDescriptor(fd, 0o700);
    } catch (error) {
      throw new Error("could not restrict owner-only directory permissions", { cause: error });
    }
    info = inspectDescriptor(fd);
    if (!info.isDirectory()) throw new Error("owner-only directory identity changed during permission enforcement");
    if ((info.mode & 0o077) !== 0) throw new Error("owner-only directory remains accessible to group or other users");
    return info;
  } finally {
    if (fd !== undefined) close(fd);
  }
}

export function ensureOwnerOnlyDir(dir, options = {}) {
  return ensureOwnerOnlyDirectorySync(dir, options);
}

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
