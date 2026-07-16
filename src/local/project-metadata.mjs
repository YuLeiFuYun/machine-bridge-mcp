// @ts-check

import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const SKIPPABLE_METADATA_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EBUSY"]);

/** @param {unknown} value @param {number} maxLength */
export function safeSingleLine(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** @param {unknown} error */
export function skippableMetadataError(error) {
  return SKIPPABLE_METADATA_CODES.has(/** @type {NodeJS.ErrnoException} */ (error)?.code || "");
}

/** @param {string} filePath */
export async function isRegularNonSymlink(filePath) {
  const info = await lstat(filePath).catch((error) => skippableMetadataError(error) ? null : Promise.reject(error));
  return Boolean(info && !info.isSymbolicLink() && info.isFile());
}

/** @param {string} filePath @param {number} maxBytes */
export async function readOptionalRegularUtf8(filePath, maxBytes) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    .catch((error) => skippableMetadataError(error) ? null : Promise.reject(error));
  if (!handle) return null;
  try {
    let pathInfo;
    let current;
    try {
      [pathInfo, current] = await Promise.all([lstat(filePath), handle.stat()]);
    } catch (error) {
      if (skippableMetadataError(error)) return null;
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || !current.isFile()
        || pathInfo.dev !== current.dev || pathInfo.ino !== current.ino || current.size > maxBytes) return null;
    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}
