// @ts-check
import { BridgeError } from "../core/errors.mjs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathEntryIfExists } from "../core/filesystem-identity.mjs";

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const SHORT_HASH = /^[0-9a-f]{4,64}$/;

/** @param {unknown} stdout @param {boolean} [includeAuthorEmail] @param {{ truncated?: boolean }} [options] */
export function parseStructuredGitLog(stdout, includeAuthorEmail = false, options = {}) {
  /** @type {Array<{hash: string, short: string, authored_at: string, author_name: string, subject: string, author_email?: string}>} */
  const commits = [];
  const records = String(stdout || "").split("\x1e");
  if (options?.truncated === true && records.length > 0) records.pop();
  for (let raw of records) {
    if (!raw) continue;
    if (raw === "\n" || raw === "\r\n") continue;
    if (raw.startsWith("\r\n")) raw = raw.slice(2);
    else if (raw.startsWith("\n")) raw = raw.slice(1);
    if (!raw) continue;
    const fields = raw.split("\x1f");
    if (fields.length !== 6) throw parseError();
    const [hash, short, authored_at, author_name, author_email, subject] = fields;
    if (!FULL_HASH.test(hash) || !SHORT_HASH.test(short) || !validIsoDate(authored_at)) throw parseError();
    /** @type {{hash: string, short: string, authored_at: string, author_name: string, subject: string, author_email?: string}} */
    const commit = { hash, short, authored_at, author_name, subject };
    if (includeAuthorEmail) commit.author_email = author_email;
    commits.push(commit);
  }
  return commits;
}

/** @param {string} value */
function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseError() {
  return new BridgeError("execution_failed", "Git log output failed structured framing validation", {
    details: { reason: "git_log_parse_failed" },
  });
}
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
const IN_PROGRESS_HISTORY_MARKERS = Object.freeze([
  "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer",
]);

/** @param {string} gitDir */
export async function assertStructuredGitCommitStateClear(gitDir) {
  for (const marker of IN_PROGRESS_HISTORY_MARKERS) {
    if (!await pathEntryIfExists(join(gitDir, marker))) continue;
    throw new BridgeError("execution_failed", "Git commit is unavailable while a merge, rebase, cherry-pick, revert, or bisect operation is in progress", {
      details: { reason: "git_commit_repository_state", code: 1 },
    });
  }
}
