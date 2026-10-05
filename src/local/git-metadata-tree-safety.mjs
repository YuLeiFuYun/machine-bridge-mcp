// @ts-check
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
export const MAX_GIT_METADATA_ENTRIES = 1_000_000;
export const MAX_GIT_METADATA_DEPTH = 64;
/**
 * @param {string[]} roots
 * @param {{opendir?: typeof opendir, lstat?: typeof lstat, maximumEntries?: number, signal?: AbortSignal}} [options]
 */
export async function assertGitMetadataTreesSafe(roots, options = {}) {
  const openDirectory = options.opendir || opendir, inspect = options.lstat || lstat;
  const maximumEntries = Number(options.maximumEntries ?? MAX_GIT_METADATA_ENTRIES);
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError("Git metadata entry limit must be a positive safe integer");
  const queue = /** @type {Array<{path: string, depth: number}>} */ ([]);
  for (const path of new Set(roots.map(String))) {
    abortIfNeeded(options.signal);
    const info = await inspect(path);
    if (info.isFile() && !info.isSymbolicLink()) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw boundaryError();
    queue.push({ path: await realpath(path), depth: 0 });
  }
  let visited = 0;
  for (const current of queue) {
    abortIfNeeded(options.signal);
    const info = await inspect(current.path, { bigint: true });
    const assertCurrent = async () => {
      const observed = await inspect(current.path, { bigint: true });
      if (observed.isSymbolicLink() || !observed.isDirectory() || observed.dev !== info.dev || observed.ino !== info.ino
          || await realpath(current.path) !== current.path) throw boundaryError();
      abortIfNeeded(options.signal);
    };
    await assertCurrent();
    const directory = await openDirectory(current.path);
    try {
      await assertCurrent();
      for await (const entry of directory) {
        abortIfNeeded(options.signal);
        if (++visited > maximumEntries) throw new BridgeError("limit_exceeded", `Git metadata entry count exceeds ${maximumEntries}`);
        const target = join(current.path, entry.name);
        if (entry.isSymbolicLink()) throw boundaryError();
        if (entry.isDirectory()) {
          if (current.depth >= MAX_GIT_METADATA_DEPTH) throw new BridgeError("limit_exceeded", `Git metadata depth exceeds ${MAX_GIT_METADATA_DEPTH}`);
          queue.push({ path: target, depth: current.depth + 1 }); continue;
        }
        if (entry.isFile()) continue;
        const info = await inspect(target);
        if (info.isSymbolicLink() || !info.isFile()) throw boundaryError();
      }
      await assertCurrent();
    } finally { await directory.close().catch(() => { /* Directory-handle close is best-effort after bounded traversal ends. */ }); }
  }
  return visited;
}
/** @param {AbortSignal | undefined} signal */
function abortIfNeeded(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new BridgeError("cancelled", "Git metadata inspection cancelled"); }
function boundaryError() {
  return new BridgeError("path_boundary", "Git metadata tree contains a symbolic link, special file or changed directory", { details: { reason: "git_metadata_boundary" } });
}
