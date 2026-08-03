import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import path, { basename, dirname, join, resolve } from "node:path";
import { BridgeError } from "./errors.mjs";
import { applyUpdateHunks, parsePatchEnvelope } from "./patch.mjs";
import { openDirectoryIfExists, pathEntryIfExists } from "./path-inspection.mjs";
import { clampInteger } from "./numbers.mjs";

export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_PATH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class WorkspaceFileService {
  constructor({ workspace, policy, policyGate, policyForContext = null, resolveExistingPath, resolveWritePath, displayPath, throwIfCancelled, withMutationLock }) {
    this.workspace = workspace;
    this.policy = policy;
    this.policyGate = policyGate;
    this.policyForContext = typeof policyForContext === "function" ? policyForContext : () => this.policy;
    this.resolveExistingPath = resolveExistingPath;
    this.resolveWritePath = resolveWritePath;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
    this.withMutationLock = withMutationLock;
  }

  listRoots(context = {}) {
    const policy = this.policyForContext(context);
    const roots = [{ name: policy.exposeAbsolutePaths ? basename(this.workspace) : "workspace", path: this.displayPath(this.workspace, context), default: true }];
    if (policy.unrestrictedPaths) {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home && home !== this.workspace) roots.push({ name: "home", path: this.displayPath(resolve(home), context), default: false });
      roots.push({ name: "filesystem-root", path: this.displayPath(path.parse(this.workspace).root, context), default: false });
    }
    return { roots };
  }

  async listDir(inputPath, context = {}) {
    const full = await this.resolveExistingPath(inputPath, context);
    const entries = [];
    let resultBytes = 0;
    let truncated = false;
    for await (const entry of await opendir(full)) {
      this.throwIfCancelled(context);
      const entryPath = resolve(full, entry.name);
      const info = await pathEntryIfExists(entryPath);
      if (!info) continue;
      const item = {
        name: entry.name,
        path: this.displayPath(entryPath, context),
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: info.size,
      };
      const itemBytes = Buffer.byteLength(item.name) + Buffer.byteLength(item.path) + 64;
      if (entries.length >= MAX_DIRECTORY_ENTRIES || resultBytes + itemBytes > MAX_PATH_RESULT_BYTES) {
        truncated = true;
        break;
      }
      entries.push(item);
      resultBytes += itemBytes;
    }
    entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return { path: this.displayPath(full, context), entries, truncated };
  }

  async listFiles(inputPath, maxFiles, context = {}) {
    const root = await this.resolveExistingPath(inputPath, context);
    const info = await stat(root);
    if (info.isFile()) return { path: this.displayPath(root, context), files: [this.displayPath(root, context)], truncated: false };
    if (!info.isDirectory()) throw new BridgeError("invalid_request", "path is not a file or directory", { details: { reason: "unsupported_path_type" } });
    const files = [];
    let resultBytes = 0;
    const walkResult = await this.walk(root, async full => {
      this.throwIfCancelled(context);
      const shown = this.displayPath(full, context);
      const pathBytes = Buffer.byteLength(shown) + 8;
      if (files.length >= maxFiles || resultBytes + pathBytes > MAX_PATH_RESULT_BYTES) return false;
      files.push(shown);
      resultBytes += pathBytes;
      return true;
    }, context);
    return { path: this.displayPath(root, context), files, truncated: files.length >= maxFiles || resultBytes >= MAX_PATH_RESULT_BYTES || walkResult.truncated };
  }

  async readFile(args, context = {}) {
    if (typeof args === "string") {
      args = { path: args, max_bytes: typeof context === "number" ? context : undefined };
      context = {};
    }
    if (!args.path) throw new BridgeError("invalid_request", "path is required", { details: { reason: "missing_path" } });
    const full = await this.resolveExistingPath(args.path, context);
    this.throwIfCancelled(context);
    const { buffer, info } = await readBoundedFile(full, MAX_WRITE_BYTES, "readable text file");
    const content = decodeUtf8(buffer);
    this.throwIfCancelled(context);
    const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, MAX_WRITE_BYTES);
    const startLine = args.start_line === undefined ? 1 : clampInteger(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
    const lineStarts = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "\n" && index + 1 < content.length) lineStarts.push(index + 1);
    }
    const totalLines = lineStarts.length;
    const endLine = args.end_line === undefined ? totalLines : clampInteger(args.end_line, totalLines, 1, Number.MAX_SAFE_INTEGER);
    if (endLine < startLine) throw new BridgeError("invalid_request", "end_line must be greater than or equal to start_line", { details: { reason: "invalid_line_range" } });
    if (startLine > totalLines) throw new BridgeError("invalid_request", `start_line exceeds total lines (${startLine} > ${totalLines})`, { details: { reason: "line_out_of_range", total_lines: totalLines } });
    const selectedEnd = Math.min(endLine, totalLines);
    const selectedStartOffset = lineStarts[startLine - 1];
    const selectedEndOffset = selectedEnd < totalLines ? lineStarts[selectedEnd] : content.length;
    const selected = content.slice(selectedStartOffset, selectedEndOffset);
    const selectedBytes = Buffer.byteLength(selected);
    if (selectedBytes > maxBytes) throw new BridgeError("limit_exceeded", `selected content exceeds max_bytes (${selectedBytes} > ${maxBytes})`, { details: { reason: "read_limit", selected_bytes: selectedBytes, maximum_bytes: maxBytes } });
    return {
      path: this.displayPath(full, context),
      size: info.size,
      sha256: sha256(content),
      content: selected,
      start_line: startLine,
      end_line: selectedEnd,
      total_lines: totalLines,
      complete: startLine === 1 && selectedEnd === totalLines,
    };
  }

  async viewImage(args, context = {}) {
    if (!args.path) throw new BridgeError("invalid_request", "path is required", { details: { reason: "missing_path" } });
    const full = await this.resolveExistingPath(args.path, context);
    this.throwIfCancelled(context);
    const { buffer, info } = await readBoundedFile(full, MAX_IMAGE_BYTES, "image");
    this.throwIfCancelled(context);
    const mimeType = detectImageMime(buffer);
    if (!mimeType) throw new BridgeError("invalid_request", "unsupported image format; expected PNG, JPEG, GIF, or WebP", { details: { reason: "unsupported_image_format" } });
    return {
      $mcp: {
        content: [{ type: "image", data: buffer.toString("base64"), mimeType }],
        structuredContent: {
          path: this.displayPath(full, context),
          size: info.size,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          mime_type: mimeType,
        },
      },
    };
  }

  async writeFile(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
      this.policyGate.assert("write_file");
      if (!args.path) throw new BridgeError("invalid_request", "path is required", { details: { reason: "missing_path" } });
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_WRITE_BYTES) throw new BridgeError("limit_exceeded", `content exceeds maximum write size (${bytes} > ${MAX_WRITE_BYTES})`, { details: { reason: "write_limit", bytes, maximum_bytes: MAX_WRITE_BYTES } });
      const full = await this.resolveWritePath(args.path, context);
      const existing = await pathEntryIfExists(full);
      if (existing?.isSymbolicLink()) throw new BridgeError("conflict", "refusing to overwrite a symbolic link", { details: { reason: "symbolic_link" } });
      if (args.create_only && existing) throw new BridgeError("conflict", "file exists and create_only=true", { details: { reason: "already_exists" } });
      if (existing && !existing.isFile()) throw new BridgeError("conflict", "path is not a regular file", { details: { reason: "unsupported_target_type" } });
      if (args.expected_sha256) {
        if (!existing) throw new BridgeError("conflict", "expected_sha256 requires an existing file", { details: { reason: "precondition_target_missing" } });
        const current = await readUtf8File(full);
        if (sha256(current) !== String(args.expected_sha256).toLowerCase()) throw new BridgeError("conflict", "expected_sha256 mismatch", { details: { reason: "hash_mismatch" } });
      }
      this.throwIfCancelled(context);
      await atomicWriteText(full, content, existing, {
        createOnly: args.create_only === true,
        expectedHash: args.expected_sha256 ? String(args.expected_sha256).toLowerCase() : undefined,
      });
      return { ok: true, path: this.displayPath(full, context), sha256: sha256(content), bytes };
    });
  }

  async editFile(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
      this.policyGate.assert("edit_file");
      if (!args.path) throw new BridgeError("invalid_request", "path is required", { details: { reason: "missing_path" } });
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!oldText) throw new BridgeError("invalid_request", "old_text must not be empty", { details: { reason: "empty_old_text" } });
      const full = await this.resolveExistingPath(args.path, context);
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError("conflict", "path is not a regular non-symbolic-link file", { details: { reason: "unsupported_target_type" } });
      const current = await readUtf8File(full);
      if (args.expected_sha256 && sha256(current) !== String(args.expected_sha256).toLowerCase()) throw new BridgeError("conflict", "expected_sha256 mismatch", { details: { reason: "hash_mismatch" } });
      const occurrences = countOccurrences(current, oldText);
      if (occurrences === 0) throw new BridgeError("not_found", "old_text was not found", { details: { reason: "text_not_found" } });
      if (!args.replace_all && occurrences !== 1) throw new BridgeError("conflict", `old_text occurs ${occurrences} times; provide a unique fragment or set replace_all=true`, { details: { reason: "text_ambiguous", occurrences } });
      const updated = args.replace_all ? current.split(oldText).join(newText) : current.replace(oldText, newText);
      const bytes = Buffer.byteLength(updated);
      if (bytes > MAX_WRITE_BYTES) throw new BridgeError("limit_exceeded", `edited content exceeds maximum write size (${bytes} > ${MAX_WRITE_BYTES})`, { details: { reason: "write_limit", bytes, maximum_bytes: MAX_WRITE_BYTES } });
      this.throwIfCancelled(context);
      await atomicWriteText(full, updated, info, { expectedHash: sha256(current) });
      return { ok: true, path: this.displayPath(full, context), replacements: args.replace_all ? occurrences : 1, sha256: sha256(updated), bytes };
    });
  }

  async applyPatch(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
      this.policyGate.assert("apply_patch");
      const patchText = String(args.patch ?? "");
      if (!patchText) throw new BridgeError("invalid_request", "patch is required", { details: { reason: "missing_patch" } });
      if (Buffer.byteLength(patchText) > MAX_WRITE_BYTES) throw new BridgeError("limit_exceeded", "patch exceeds maximum size", { details: { reason: "patch_limit", maximum_bytes: MAX_WRITE_BYTES } });
      const parsed = parsePatchEnvelope(patchText);
      const prepared = [];
      for (const operation of parsed) {
        this.throwIfCancelled(context);
        if (operation.kind === "add") {
          const target = await this.resolveWritePath(operation.path, context);
          if (await pathEntryIfExists(target)) throw new BridgeError("conflict", "add target already exists", { details: { reason: "already_exists", operation: "add" } });
          assertTextSize(operation.content);
          prepared.push({ kind: "add", source: null, target, content: operation.content, mode: 0o600 });
          continue;
        }
        const source = await this.resolveExistingPath(operation.path, context);
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new BridgeError("conflict", "patch source is not a regular file", { details: { reason: "unsupported_source_type" } });
        const original = await readUtf8File(source);
        if (operation.kind === "delete") {
          prepared.push({ kind: "delete", source, target: null, originalHash: sha256(original), mode: sourceInfo.mode & 0o777 });
          continue;
        }
        const content = applyUpdateHunks(original, operation.hunks);
        assertTextSize(content);
        const target = operation.moveTo ? await this.resolveWritePath(operation.moveTo, context) : source;
        if (target !== source && await pathEntryIfExists(target)) throw new BridgeError("conflict", "move target already exists", { details: { reason: "already_exists", operation: "move" } });
        prepared.push({ kind: operation.moveTo ? "move" : "update", source, target, content, originalHash: sha256(original), mode: sourceInfo.mode & 0o777 });
      }
      assertNoResolvedPatchCollisions(prepared);
      this.throwIfCancelled(context);
      const transaction = await commitPatchTransaction(prepared);
      return {
        ok: true,
        ...(transaction.warnings.length ? { warnings: transaction.warnings } : {}),
        files: prepared.map((item) => ({
          operation: item.kind,
          path: this.displayPath(item.target || item.source, context),
          ...(item.kind === "move" ? { from: this.displayPath(item.source, context) } : {}),
          ...(item.content === undefined ? {} : { sha256: sha256(item.content) }),
        })),
      };
    });
  }

  async searchText(args, context = {}) {
    const query = String(args.query || "");
    if (!query) throw new BridgeError("invalid_request", "query is required", { details: { reason: "missing_query" } });
    const root = await this.resolveExistingPath(args.path || ".", context);
    const max = clampInteger(args.max_matches, 100, 1, 1000);
    const maxFiles = clampInteger(args.max_files, 10000, 1, 100000);
    let visitedFiles = 0;
    const matches = [];
    const rootInfo = await stat(root);
    if (rootInfo.isFile()) {
      await this.searchOneFile(root, query, matches, max, context);
      return { query, root: this.displayPath(root, context), matches, visited_files: 1, truncated: matches.length >= max };
    }
    if (!rootInfo.isDirectory()) throw new BridgeError("invalid_request", "path is not a file or directory", { details: { reason: "unsupported_path_type" } });
    const walkResult = await this.walk(root, async full => {
      this.throwIfCancelled(context);
      if (matches.length >= max || visitedFiles >= maxFiles) return false;
      visitedFiles += 1;
      await this.searchOneFile(full, query, matches, max, context);
      return matches.length < max && visitedFiles < maxFiles;
    }, context);
    return { query, root: this.displayPath(root, context), matches, visited_files: visitedFiles, truncated: matches.length >= max || visitedFiles >= maxFiles || walkResult.truncated };
  }

  async searchOneFile(full, query, matches, max, context = {}) {
    this.throwIfCancelled(context);
    let bounded;
    try { bounded = await readBoundedFile(full, 1024 * 1024, "search file"); } catch (error) {
      if (isSkippableSearchFileError(error)) return;
      throw error;
    }
    if (bounded.buffer.includes(0)) return;
    const buffer = bounded.buffer;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return; }
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({ path: this.displayPath(full, context), line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= max) break;
      }
    }
  }

  async walk(root, onFile, context = {}) {
    const stack = [root];
    let visitedEntries = 0;
    while (stack.length) {
      this.throwIfCancelled(context);
      const current = stack.pop();
      const entries = await openDirectoryIfExists(current);
      if (!entries) continue;
      for await (const entry of entries) {
        this.throwIfCancelled(context);
        visitedEntries += 1;
        if (visitedEntries > MAX_WALK_ENTRIES) return { truncated: true, visitedEntries };
        const full = resolve(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          const keepGoing = await onFile(full);
          if (keepGoing === false) return { truncated: true, visitedEntries };
        }
      }
    }
    return { truncated: false, visitedEntries };
  }

}

export async function readBoundedFile(filePath, maxBytes, label) {
  const flags = Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW || 0);
  const handle = await open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new BridgeError("invalid_request", `${label} is not a regular file`, { details: { reason: "unsupported_path_type" } });
    if (Number(info.nlink) > 1) throw new BridgeError("permission_denied", `refusing to read ${label} with multiple hard links`, { details: { reason: "multiple_hard_links" } });
    if (info.size > maxBytes) throw new BridgeError("limit_exceeded", `${label} exceeds maximum size (${info.size} > ${maxBytes})`, { details: { reason: "read_limit", size: info.size, maximum_bytes: maxBytes } });
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { buffer: buffer.subarray(0, offset), info };
  } finally {
    await handle.close();
  }
}

function isSkippableSearchFileError(error) {
  const message = String(error?.message || "");
  return error?.code === "ELOOP"
    || message.startsWith("search file exceeds maximum size")
    || message === "search file is not a regular file"
    || message === "refusing to read search file with multiple hard links";
}

function decodeUtf8(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    throw new BridgeError("invalid_request", "file is not valid UTF-8 text", { details: { reason: "invalid_utf8" } });
  }
}

async function readUtf8File(filePath) {
  const { buffer } = await readBoundedFile(filePath, MAX_WRITE_BYTES, "text file");
  return decodeUtf8(buffer);
}

async function writeFlushedText(filePath, content, mode) {
  const handle = await open(filePath, "wx", mode);
  let failure = null;
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    try { await handle.chmod(mode); } catch (error) { if (process.platform !== "win32") throw error; }
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try { await handle.close(); } catch (error) { failure ||= error; }
  if (failure) {
    try { await rm(filePath, { force: true }); } catch {
      throw new BridgeError("internal_error", "staged file write failed and cleanup was incomplete", { cause: failure, expose: false });
    }
    throw failure;
  }
}

async function atomicWriteText(full, content, existing = null, options = {}) {
  await mkdir(dirname(full), { recursive: true });
  const temp = join(dirname(full), `.${basename(full)}.mbm-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFlushedText(temp, content, existing ? existing.mode & 0o777 : 0o600);
    if (options.expectedHash) {
      let current;
      try { current = await readUtf8File(full); } catch (error) {
        if (error?.code === "ENOENT") throw new BridgeError("conflict", "file changed before atomic commit", { cause: error, details: { reason: "precondition_target_missing" } });
        throw error;
      }
      if (sha256(current) !== options.expectedHash) throw new BridgeError("conflict", "file changed before atomic commit", { details: { reason: "hash_mismatch" } });
    }
    if (options.createOnly) {
      await link(temp, full);
      await rm(temp, { force: true });
    } else {
      await rename(temp, full);
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function assertNoResolvedPatchCollisions(operations) {
  const owners = new Map();
  for (const operation of operations) {
    const paths = operation.source === operation.target
      ? [operation.source]
      : [operation.source, operation.target].filter(Boolean);
    for (const full of paths) {
      const key = process.platform === "win32" ? String(full).toLowerCase() : String(full);
      const previous = owners.get(key);
      if (previous && previous !== operation) throw new BridgeError("conflict", "patch operations resolve to the same path", { details: { reason: "resolved_path_collision" } });
      owners.set(key, operation);
    }
  }
}

export async function commitPatchTransaction(operations, options = {}) {
  const move = options.rename || rename;
  const remove = options.remove || rm;
  const staged = [];
  const committed = [];
  try {
    for (const operation of operations) {
      if (operation.content === undefined) continue;
      await mkdir(dirname(operation.target), { recursive: true });
      const temp = join(dirname(operation.target), `.${basename(operation.target)}.mbm-patch-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      await writeFlushedText(temp, operation.content, operation.mode);
      staged.push({ operation, temp });
    }

    for (const operation of operations) {
      if (operation.source) {
        const current = await readUtf8File(operation.source);
        if (sha256(current) !== operation.originalHash) throw new BridgeError("conflict", "patch source changed during apply", { details: { reason: "hash_mismatch" } });
      }
      if (operation.kind === "add" || operation.kind === "move") {
        if (await pathEntryIfExists(operation.target)) throw new BridgeError("conflict", "patch target appeared during apply", { details: { reason: "target_appeared" } });
      }
    }

    for (const operation of operations) {
      let backup = null;
      if (operation.source) {
        backup = join(dirname(operation.source), `.${basename(operation.source)}.mbm-backup-${process.pid}-${randomBytes(6).toString("hex")}`);
        await move(operation.source, backup);
      }
      const record = { operation, backup, targetCreated: false };
      committed.push(record);
      const stage = staged.find((item) => item.operation === operation);
      if (stage) {
        await move(stage.temp, operation.target);
        record.targetCreated = true;
      }
    }
  } catch (error) {
    const recoveryFailures = [];
    for (const item of [...committed].reverse()) {
      if (item.targetCreated) {
        try { await remove(item.operation.target, { force: true }); } catch (failure) { recoveryFailures.push(failure); }
      }
      if (item.backup) {
        try { await move(item.backup, item.operation.source); } catch (failure) { recoveryFailures.push(failure); }
      }
    }
    recoveryFailures.push(...await removePatchArtifacts(staged.map((item) => item.temp), remove));
    if (recoveryFailures.length) {
      throw new BridgeError("internal_error", "patch transaction failed and recovery was incomplete", { cause: error, expose: false });
    }
    throw error;
  }

  const cleanupFailures = await removePatchArtifacts([
    ...staged.map((item) => item.temp),
    ...committed.map((item) => item.backup).filter(Boolean),
  ], remove);
  return {
    warnings: cleanupFailures.length
      ? [`Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed; inspect affected directories for .mbm-backup-* or .mbm-patch-* files.`]
      : [],
  };
}

async function removePatchArtifacts(paths, remove) {
  const failures = [];
  for (const path of paths) {
    try { await remove(path, { force: true }); } catch (error) { failures.push(error); }
  }
  return failures;
}

function assertTextSize(content) {
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_WRITE_BYTES) throw new BridgeError("limit_exceeded", `patched file exceeds maximum size (${bytes} > ${MAX_WRITE_BYTES})`, { details: { reason: "write_limit", bytes, maximum_bytes: MAX_WRITE_BYTES } });
}

function countOccurrences(content, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}
