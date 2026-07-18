// @ts-check
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** @param {string} filePath @param {number} maxBytes @param {string} label */
export async function readOptionalRegularUtf8(filePath, maxBytes, label) {
  const info = await lstat(filePath).catch((error) => isMissing(error) ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  return readRegularUtf8(filePath, maxBytes, label);
}

/** @param {string} filePath @param {number} maxBytes @param {string} label */
export async function readRegularUtf8(filePath, maxBytes, label) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`${label} exceeds maximum size (${info.size} > ${maxBytes})`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)), bytes: offset };
    } catch {
      throw new Error(`${label} is not valid UTF-8 text: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

/** @param {unknown} error */
function isMissing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
