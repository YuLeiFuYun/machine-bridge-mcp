// @ts-check
import { lstat, opendir } from "node:fs/promises";

/**
 * @param {any} error
 * @returns {boolean}
 */
export function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

/**
 * @param {string} path
 * @param {(p: string) => Promise<any>} [inspect]
 * @returns {Promise<any>}
 */
export async function pathEntryIfExists(path, inspect = lstat) {
  try {
    return await inspect(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/**
 * @param {string} path
 * @param {(p: string) => Promise<any>} [openDirectory]
 * @returns {Promise<any>}
 */
export async function openDirectoryIfExists(path, openDirectory = opendir) {
  try {
    return await openDirectory(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}
