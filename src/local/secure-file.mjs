import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";

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
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (options.verifyPathIdentity === true) {
      const pathInfo = lstatSync(file);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`${label} must be a regular file and not a symbolic link`);
      if (!sameFileIdentity(info, pathInfo)) throw new Error(`${label} identity changed while opening`);
    }
    if (Number.isInteger(options.chmod)) setDescriptorMode(fd, options.chmod);
    return { fd, info };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function withRegularFileSync(file, flags, options, callback) {
  const opened = openRegularFileSync(file, flags, options);
  try {
    return callback(opened.fd, opened.info);
  } finally {
    closeSync(opened.fd);
  }
}

export function chmodRegularFileSync(file, mode, label = "path") {
  return withRegularFileSync(file, fsConstants.O_RDONLY, { label, chmod: mode }, () => undefined);
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
  }, (fd, info) => {
    if (info.size > limit) throw new Error(`file exceeds ${limit} bytes`);
    options.afterOpen?.({ fd, info });
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return { buffer: buffer.subarray(0, offset), info };
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

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function sameFileIdentity(left, right) {
  const leftDevice = Number(left.dev);
  const rightDevice = Number(right.dev);
  const leftInode = Number(left.ino);
  const rightInode = Number(right.ino);
  if ([leftDevice, rightDevice, leftInode, rightInode].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return leftDevice === rightDevice && leftInode === rightInode;
  }
  return true;
}
