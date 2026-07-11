import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedRegularFileSync(file, maxBytes) {
  return readBoundedRegularFileWithInfoSync(file, maxBytes).buffer;
}

export function readBoundedRegularFileWithInfoSync(file, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maximum file size must be a non-negative safe integer");
  const flags = Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(file, flags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("path is not a regular file");
    if (info.size > limit) throw new Error(`file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return { buffer: buffer.subarray(0, offset), info };
  } finally {
    closeSync(fd);
  }
}
