// @ts-check
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
export const MAX_GIT_METADATA_ENTRIES = 1_000_000;
export const MAX_GIT_METADATA_DEPTH = 64;

/**
 * @param {string[]} roots
 * @param {{opendir?: typeof opendir, lstat?: typeof lstat, maximumEntries?: number, signal?: AbortSignal}} [options]
 */
export async function assertGitMetadataTreesSafe(roots, options = {}) {
  const openDirectory = options.opendir || opendir;
  const inspect = options.lstat || lstat;
  const maximumEntries = Number(options.maximumEntries ?? MAX_GIT_METADATA_ENTRIES);
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError("Git metadata entry limit must be a positive safe integer");
  /** @type {Array<{path: string, depth: number}>} */
  const queue = [];
  for (const path of new Set(roots.map(String))) {
    abortIfNeeded(options.signal);
    const info = await inspect(path);
    if (info.isSymbolicLink()) throw boundaryError();
    if (info.isFile()) continue;
    if (!info.isDirectory()) throw boundaryError();
    queue.push({ path, depth: 0 });
  }
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    abortIfNeeded(options.signal);
    const current = queue[index];
    const directory = await openDirectory(current.path);
    try {
      for await (const entry of directory) {
        abortIfNeeded(options.signal);
        visited += 1;
        if (visited > maximumEntries) throw new BridgeError("limit_exceeded", `Git metadata entry count exceeds ${maximumEntries}`);
        const target = join(current.path, entry.name);
        if (entry.isSymbolicLink()) throw boundaryError();
        if (entry.isDirectory()) {
          if (current.depth >= MAX_GIT_METADATA_DEPTH) throw new BridgeError("limit_exceeded", `Git metadata depth exceeds ${MAX_GIT_METADATA_DEPTH}`);
          queue.push({ path: target, depth: current.depth + 1 });
          continue;
        }
        if (entry.isFile()) continue;
        const info = await inspect(target);
        if (info.isSymbolicLink() || !info.isFile()) throw boundaryError();
      }
    } finally { await directory.close().catch(() => {}); }
  }
  return visited;
}

/** @param {AbortSignal | undefined} signal */
function abortIfNeeded(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new BridgeError("cancelled", "Git metadata inspection cancelled"); }
function boundaryError() {
  return new BridgeError("path_boundary", "Git metadata tree contains a symbolic link or special file", {
    details: { reason: "git_metadata_boundary" },
  });
}
