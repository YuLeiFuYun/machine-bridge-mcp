import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, readSync } from "node:fs";

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
    if (Number.isInteger(options.chmod)) setDescriptorMode(fd, options.chmod);
    return { fd, info };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function withRegularFileSync(file, flags, options, callback) {
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

export function readBoundedRegularFileSync(file, maxBytes, label = "path") {
  return readBoundedRegularFileWithInfoSync(file, maxBytes, label).buffer;
}

export function readBoundedRegularFileWithInfoSync(file, maxBytes, label = "path") {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maximum file size must be a non-negative safe integer");
  return withRegularFileSync(file, fsConstants.O_RDONLY, { label }, (fd, info) => {
    if (info.size > limit) throw new Error(`file exceeds ${limit} bytes`);
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

function setDescriptorMode(fd, mode) {
  try { fchmodSync(fd, mode); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
