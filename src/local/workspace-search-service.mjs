// @ts-check

import { stat } from "node:fs/promises";
import path from "node:path";
import { isSensitivePath } from "./operation-risk.mjs";
import { clampInteger } from "./numbers.mjs";
import { BridgeError } from "./errors.mjs";
import { searchWorkspaceFiles } from "./workspace-search.mjs";

const MAX_SEARCH_RESULT_BYTES = 1024 * 1024;

/**
 * @typedef {object} SearchWorkspaceTextOptions
 * @property {Record<string, unknown>} args
 * @property {unknown} context
 * @property {(path: string, context: unknown) => Promise<string>} resolveExistingPath
 * @property {(path: string, context: unknown) => string} displayPath
 * @property {(context: unknown) => void} throwIfCancelled
 * @property {(root: string, onFile: (full: string) => Promise<boolean>, context: unknown, options: {includeIgnored: boolean}) => Promise<{truncated: boolean}>} walk
 * @property {(path: string, context: unknown) => boolean | Promise<boolean>} [isProtectedPath]
 * @property {(path: string, maxBytes: number, label: string) => Promise<{buffer: Buffer, info: import('node:fs').Stats}>} readBoundedFile
 */

/** @param {SearchWorkspaceTextOptions} options */
export async function searchWorkspaceText(options) {
  const { args, context, resolveExistingPath, displayPath, throwIfCancelled, walk, readBoundedFile, isProtectedPath } = options;
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) throw new BridgeError("invalid_request", "query is required", { details: { reason: "missing_query" } });
  if (query.length > 4096) throw new BridgeError("invalid_request", "query exceeds the maximum length of 4096 characters", { details: { reason: "query_too_long" } });
  const glob = args.glob === undefined ? "" : typeof args.glob === "string" ? args.glob : "\0";
  if (glob.length > 512 || glob.includes("\0") || glob.includes("\\")
      || path.isAbsolute(glob) || path.win32.isAbsolute(glob) || glob.split("/").includes("..")) {
    throw new BridgeError("invalid_request", "glob must be a bounded relative path pattern", { details: { reason: "invalid_glob" } });
  }
  const caseSensitive = args.case_sensitive !== false;
  const contextLines = clampInteger(args.context_lines, 0, 0, 5);
  const root = await resolveExistingPath(typeof args.path === "string" ? args.path : ".", context);
  const maximumMatches = clampInteger(args.max_matches, 100, 1, 1000);
  const maximumFiles = clampInteger(args.max_files, 10000, 1, 100000);
  /** @type {Record<string, unknown>[]} */
  const matches = [];
  let skippedFiles = 0;
  const rootInfo = await stat(root);
  if (rootInfo.isFile()) {
    if (glob && !path.posix.matchesGlob(path.basename(root), glob)) {
      return finalizeSearchResult({ query, root: displayPath(root, context), matches, visited_files: 0, skipped_files: 0, truncated: false });
    }
    if (isRelayContext(context) && isProtectedPath && await isProtectedPath(root, context)) {
      return finalizeSearchResult({ query, root: displayPath(root, context), matches, visited_files: 0, skipped_files: 1, truncated: true });
    }
    const outcome = await searchOneFile(root, query, matches, maximumMatches, context, displayPath, throwIfCancelled, readBoundedFile, { caseSensitive, contextLines });
    if (outcome.reportableSkip) skippedFiles += 1;
    return finalizeSearchResult({
      query, root: displayPath(root, context), matches, visited_files: 1,
      skipped_files: skippedFiles, truncated: matches.length >= maximumMatches || skippedFiles > 0,
    });
  }
  if (!rootInfo.isDirectory()) throw new BridgeError("invalid_request", "path is not a file or directory", { details: { reason: "unsupported_path_type" } });
  const result = await searchWorkspaceFiles({
    maximumFiles, maximumMatches,
    walk: (onFile) => walk(root, async (full) => {
      const relativePath = path.relative(root, full).split(path.sep).join("/");
      if (glob && !path.posix.matchesGlob(relativePath, glob)) return true;
      if (isRelayContext(context) && isProtectedPath && await isProtectedPath(full, context)) {
        skippedFiles += 1;
        return true;
      }
      return onFile(full);
    }, context, { includeIgnored: args.include_ignored === true }),
    searchFile: async (full) => {
      /** @type {Record<string, unknown>[]} */
      const fileMatches = [];
      const outcome = await searchOneFile(full, query, fileMatches, maximumMatches, context, displayPath, throwIfCancelled, readBoundedFile, { caseSensitive, contextLines });
      if (outcome.reportableSkip) skippedFiles += 1;
      return fileMatches;
    },
    throwIfCancelled, context,
  });
  return finalizeSearchResult({
    query, root: displayPath(root, context), matches: result.matches,
    visited_files: result.visitedFiles, skipped_files: skippedFiles,
    truncated: result.truncated || skippedFiles > 0,
  });
}

/** @param {{query: string, root: string, matches: Record<string, unknown>[], visited_files: number, skipped_files: number, truncated: boolean}} result */
function finalizeSearchResult(result) {
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...result, matches: [] }));
  let resultBytes = baseBytes;
  /** @type {Record<string, unknown>[]} */
  const kept = [];
  for (const match of result.matches) {
    const matchBytes = Buffer.byteLength(JSON.stringify(match)) + (kept.length ? 1 : 0);
    if (resultBytes + matchBytes > MAX_SEARCH_RESULT_BYTES) {
      result.truncated = true;
      break;
    }
    kept.push(match);
    resultBytes += matchBytes;
  }
  result.matches = kept;
  return result;
}

/**
 * @param {string} full
 * @param {string} query
 * @param {Record<string, unknown>[]} matches
 * @param {number} maximumMatches
 * @param {unknown} context
 * @param {(path: string, context: unknown) => string} displayPath
 * @param {(context: unknown) => void} throwIfCancelled
 * @param {(path: string, maxBytes: number, label: string) => Promise<{buffer: Buffer, info: import('node:fs').Stats}>} readBoundedFile
 * @param {{caseSensitive: boolean, contextLines: number}} options
 */
async function searchOneFile(full, query, matches, maximumMatches, context, displayPath, throwIfCancelled, readBoundedFile, options) {
  throwIfCancelled(context);
  if (isDelegatedRelayContext(context) && isSensitivePath(full)) {
    return { skipped: true, reportableSkip: true, reason: "sensitive_path" };
  }
  let bounded;
  try { bounded = await readBoundedFile(full, 1024 * 1024, "search file"); } catch (error) {
    if (isSkippableSearchFileError(error)) {
      const reason = readErrorReason(error);
      return { skipped: true, reportableSkip: true, reason };
    }
    throw error;
  }
  if (bounded.buffer.includes(0)) return { skipped: true, reportableSkip: false, reason: "binary_file" };
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bounded.buffer); }
  catch { return { skipped: true, reportableSkip: false, reason: "invalid_utf8" }; }
  if (!text) return { skipped: false, reportableSkip: false, reason: "" };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const matchIndex = findLiteralMatch(lines[index], query, options.caseSensitive);
    if (matchIndex === -1) continue;
    const line = lines[index];
    const start = query.length >= 500
      ? matchIndex
      : Math.max(0, Math.min(matchIndex - Math.floor((500 - query.length) / 2), line.length - 500));
    matches.push({
      path: displayPath(full, context), line: index + 1,
      text: line.slice(start, start + 500), match_offset: matchIndex - start, line_offset: start, column: matchIndex,
      ...(options.contextLines ? {
        before: lines.slice(Math.max(0, index - options.contextLines), index).map((value) => value.slice(0, 500)),
        after: lines.slice(index + 1, Math.min(lines.length, index + options.contextLines + 1)).map((value) => value.slice(0, 500)),
      } : {}),
    });
    if (matches.length >= maximumMatches) break;
  }
  return { skipped: false, reportableSkip: false, reason: "" };
}

/** @param {string} line @param {string} query @param {boolean} caseSensitive */
function findLiteralMatch(line, query, caseSensitive) {
  if (caseSensitive) return line.indexOf(query);
  const comparable = line.toLowerCase();
  const foldedQuery = query.toLowerCase();
  const index = comparable.indexOf(foldedQuery);
  if (index < 0) return -1;
  let foldedOffset = 0;
  let originalOffset = 0;
  for (const character of line) {
    const foldedLength = character.toLowerCase().length;
    if (foldedOffset + foldedLength > index) return originalOffset;
    foldedOffset += foldedLength;
    originalOffset += character.length;
  }
  return -1;
}

/** @param {unknown} error */
function readErrorReason(error) {
  const record = error !== null && typeof error === "object"
    ? /** @type {{details?: unknown}} */ (error)
    : {};
  const details = record.details !== null && typeof record.details === "object"
    ? /** @type {{reason?: unknown}} */ (record.details)
    : {};
  return String(details.reason || "unreadable_file");
}

/** @param {unknown} error */
function isSkippableSearchFileError(error) {
  const record = error !== null && typeof error === "object"
    ? /** @type {{code?: unknown, details?: unknown}} */ (error)
    : {};
  const details = record.details !== null && typeof record.details === "object"
    ? /** @type {{reason?: unknown}} */ (record.details)
    : {};
  const reason = String(details.reason || "");
  return record.code === "ELOOP"
    || reason === "read_limit"
    || reason === "unsupported_path_type"
    || reason === "multiple_hard_links";
}

/** @param {unknown} context */
function isDelegatedRelayContext(context) {
  const record = /** @type {Record<string, unknown>} */ (context !== null && typeof context === "object" ? context : {});
  const authority = /** @type {Record<string, unknown>} */ (record.authority !== null && typeof record.authority === "object" ? record.authority : {});
  const principal = /** @type {Record<string, unknown>} */ (authority.principal !== null && typeof authority.principal === "object" ? authority.principal : {});
  return record.origin === "relay" && principal.kind === "account"
    && principal.role !== "owner" && authority.owner !== true;
}

/** @param {unknown} context */
function isRelayContext(context) {
  const record = /** @type {Record<string, unknown>} */ (context !== null && typeof context === "object" ? context : {});
  return record.origin === "relay";
}
