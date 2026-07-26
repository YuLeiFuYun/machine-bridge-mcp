import { lstat, opendir } from "node:fs/promises";

export function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

export async function pathEntryIfExists(path, inspect = lstat) {
  try {
    return await inspect(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export async function openDirectoryIfExists(path, openDirectory = opendir) {
  try {
    return await openDirectory(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}
