// @ts-check
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

/** @param {string} filePath @param {number} maxBytes @param {string} label @param {(canonical: string) => void | Promise<void>} [assertCanonicalPath] */
export async function readOptionalRegularUtf8(filePath, maxBytes, label, assertCanonicalPath = () => {}) {
  const info = await lstat(filePath, { bigint: true }).catch((error) => isMissing(error) ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  const canonical = await realpath(filePath);
  await assertCanonicalPath(canonical);
  return readRegularUtf8(canonical, maxBytes, label, { expectedInfo: info, canonicalPath: canonical });
}

/** @param {string} filePath @param {number} maxBytes @param {string} label @param {{expectedInfo?: import("node:fs").BigIntStats, canonicalPath?: string}} [options] */
export async function readRegularUtf8(filePath, maxBytes, label, options = {}) {
  const expected = options.expectedInfo || await lstat(filePath, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${filePath}`);
  const canonical = await realpath(filePath);
  if (options.canonicalPath !== undefined && canonical !== options.canonicalPath) throw new Error(`${label} changed during read`);
  const assertCurrent = async () => {
    const current = await lstat(filePath, { bigint: true });
    if (!sameRegularFile(current, expected) || await realpath(filePath) !== canonical) {
      throw new Error(`${label} changed during read`);
    }
  };
  await assertCurrent();
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!sameRegularFile(info, expected)) throw new Error(`${label} changed during read`);
    await assertCurrent();
    if (info.size > BigInt(maxBytes)) throw new Error(`${label} exceeds maximum size (${info.size} > ${maxBytes})`);
    const buffer = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length || !sameRegularFile(await handle.stat({ bigint: true }), expected)) {
      throw new Error(`${label} changed during read`);
    }
    await assertCurrent();
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), bytes: offset };
    } catch {
      throw new Error(`${label} is not valid UTF-8 text: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

/** @param {import("node:fs").BigIntStats} current @param {import("node:fs").BigIntStats} expected */
function sameRegularFile(current, expected) {
  return current.isFile() && !current.isSymbolicLink() && expected.isFile() && !expected.isSymbolicLink()
    && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size
    && current.mtimeNs === expected.mtimeNs && current.ctimeNs === expected.ctimeNs;
}

/** @param {unknown} error */
function isMissing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
