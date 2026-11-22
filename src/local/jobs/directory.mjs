import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, ftruncateSync, readSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname, sep } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { resolveTrustedGitExecutable } from "../core/trusted-executable.mjs";
import { filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity, exactFilesystemInteger } from "../core/filesystem-identity.mjs";
import { requireContainedPath } from "../../shared/path-containment.mjs";
import { randomBytes } from "node:crypto";
import { replaceFileAtomicallySync, createExclusiveFileSync, verifyExclusiveFilePublicationResidueSync } from "../core/exclusive-file.mjs";
import { openRegularFileSync, readBoundedRegularFileSync, ensureOwnerOnlyDir, ownerOnlyFile, readBoundedRegularFileWithInfoSync, retryTransientMultipleLinksSync, inspectPathIfPresentSync } from "../core/secure-file.mjs";
import { createPidLockOwner, isValidLockToken, isValidPidLockOwner, currentProcessStartTimeMs, inspectProcessInstance, processStartTimeMs } from "../process/identity.mjs";

export const MANAGED_JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;

export function resolveManagedJobDirectory(jobRoot, value, options = {}) {
  const id = String(value || "");
  if (!MANAGED_JOB_ID.test(id)) throw new BridgeError("invalid_request", "managed job id is invalid", { retryable: false });
  const root = resolveManagedJobRootIfPresent(jobRoot, options);
  if (!root) throw new BridgeError("not_found", "managed job was not found or is no longer retained", { retryable: false });
  const candidate = join(root, id);
  try {
    return withPinnedManagedJobDirectory(candidate, "managed job directory", options, false, (pinned, verify) => {
      const canonical = (options.realpathSync || realpathSync)(candidate);
      requireContained(root, canonical);
      if (!sameDirectory(pinned, verify(candidate)) || !sameDirectory(pinned, verify(canonical))) throw new Error("managed job directory identity changed during inspection");
      return canonical;
    });
  } catch (error) {
    if (String(error?.message || "") === "job not found or expired" || error?.code === "ENOENT") {
      throw new BridgeError("not_found", "managed job was not found or is no longer retained", { retryable: false });
    }
    throw error;
  }
}

export function resolveManagedJobRootIfPresent(jobRoot, options = {}) {
  const target = resolve(String(jobRoot || ""));
  return withPinnedManagedJobDirectory(target, "managed job root", options, true, (pinned, verify) => {
    const canonical = (options.realpathSync || realpathSync)(target);
    if (!sameDirectory(pinned, verify(target))) throw new Error("managed job root identity changed during inspection");
    if (!sameDirectory(pinned, verify(canonical))) throw new Error("managed job root canonical target does not match the inspected directory");
    return canonical;
  });
}

export function withPinnedManagedJobDirectory(target, label, options, missingAllowed, callback) {
  const verify = options.lstatSync || ((value) => lstatSync(value, { bigint: true }));
  const platform = String(options.platform || process.platform);
  if (platform === "win32") {
    let info;
    try { info = verify(target); } catch (error) {
      if (missingAllowed && error?.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink?.() || !info.isDirectory?.()) throw new Error(`${label} must be a real directory and not a symbolic link`);
    return callback(info, verify);
  }
  const open = options.openSync || openSync;
  let fd;
  try { fd = open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY, 0o700); }
  catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw new Error(`${label} must be a real directory and not a symbolic link`, { cause: error });
    if (error?.code === "ENOENT") throw new Error("job not found or expired", { cause: error });
    throw error;
  }
  try {
    const info = (options.fstatSync || ((value) => fstatSync(value, { bigint: true })))(fd);
    if (!info.isDirectory?.()) throw new Error(`${label} must be a real directory and not a symbolic link`);
    return callback(info, verify);
  } finally { (options.closeSync || closeSync)(fd); }
}

function sameDirectory(left, right) {
  try {
    if (right.isSymbolicLink?.() || !right.isDirectory?.()) return false;
    const a = filesystemIdentity(left, "managed job directory");
    const b = filesystemIdentity(right, "managed job directory");
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function requireContained(root, candidate) {
  requireContainedPath(root, candidate, "managed job directory escapes the managed job root");
}
const RETIRED_JOB_DIRECTORY = /^retired_job_([A-Za-z0-9_-]{24})_d([0-9]+)_i([0-9]+)$/;

export function inspectManagedJobDirectoryGeneration(dir, label = "managed job directory") {
  const info = inspectDirectory(dir, label);
  return { identity: filesystemIdentity(info, label), mtimeMs: filesystemTimeMs(info.mtimeMs, `${label} modification time`) };
}

export function retiredManagedJobDirectories(jobRoot) {
  let entries; try { entries = readdirSync(jobRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const retired = [];
  for (const entry of entries) {
    if (!entry.name.startsWith("retired_job_")) continue;
    const match = RETIRED_JOB_DIRECTORY.exec(entry.name); const dir = join(jobRoot, entry.name);
    if (!match || !entry.isDirectory()) { retired.push({ name: entry.name, dir, identity: null, reclaimable: false, error_class: "integrity_error" }); continue; }
    try {
      const identity = filesystemIdentity(inspectDirectory(dir, "retired managed job directory"), "retired managed job directory");
      const reclaimable = identity.dev === BigInt(match[2]) && identity.ino === BigInt(match[3]);
      retired.push({ name: entry.name, dir, identity, reclaimable, error_class: reclaimable ? null : "integrity_error" });
    } catch (error) {
      if (error?.code !== "ENOENT") retired.push({ name: entry.name, dir, identity: null, reclaimable: false, error_class: "resource_unavailable" });
    }
  }
  return retired;
}

export function removeManagedJobDirectoryIfCurrent(dir, expectedIdentity, label = "managed job directory", options = {}) {
  const rename = typeof options.renameSync === "function" ? options.renameSync : renameSync;
  const result = withPinnedManagedJobDirectory(dir, label, options, true, (pinned) => {
    const pinnedIdentity = filesystemIdentity(pinned, label);
    if (!sameFilesystemIdentity(expectedIdentity, pinnedIdentity)) return false;
    const quarantine = join(dirname(dir), `retired_job_${randomBytes(18).toString("base64url")}_d${pinnedIdentity.dev}_i${pinnedIdentity.ino}`);
    try { rename(dir, quarantine); }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const moved = filesystemIdentity(inspectDirectory(quarantine, label), label);
    if (moved.dev !== pinnedIdentity.dev || moved.ino !== pinnedIdentity.ino) return false;
    rmSync(quarantine, { recursive: true, force: false });
    return true;
  });
  return result === true;
}

export function pruneRetiredManagedJobDirectories(jobRoot, logger = console) {
  for (const retired of retiredManagedJobDirectories(jobRoot)) {
    if (!retired.reclaimable) { logger.warn?.("retired managed-job directory generation is inconsistent; retaining it for inspection", { error_class: retired.error_class }); continue; }
    try {
      if (!removeManagedJobDirectoryIfCurrent(retired.dir, retired.identity, "retired managed job directory")) {
        logger.warn?.("retired managed-job directory changed during reclamation; retaining it for inspection", { error_class: "integrity_error" });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn?.("retired managed-job directory could not be reclaimed", { error_class: "resource_unavailable" });
    }
  }
}

function inspectDirectory(path, label) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return info;
}
const MANAGED_STATE_READ_ATTEMPTS = 4;

export function atomicWriteJson(file, value, maxBytes) {
  ensureOwnerOnlyDir(dirname(file));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes`);
  replaceFileAtomicallySync(file, text, { mode: 0o600 });
  ownerOnlyFile(file);
}

export function readJson(file, maxBytes, label = "JSON", options = {}) {
  const readFile = typeof options.readFile === "function" ? options.readFile : readBoundedRegularFileSync;
  let buffer;
  for (let attempt = 1; attempt <= MANAGED_STATE_READ_ATTEMPTS; attempt += 1) {
    try {
      buffer = readFile(file, maxBytes, "managed job state", {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
      });
      break;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "MBM_IDENTITY_CHANGED" && attempt < MANAGED_STATE_READ_ATTEMPTS) continue;
      throw new Error(`${label} is unavailable (${resourceErrorClass(error)})`, { cause: error });
    }
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function readRequiredJson(file, maxBytes, label) {
  const value = readJson(file, maxBytes, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable or invalid`);
  return value;
}

export function readBoundedFile(file, maxBytes) {
  return readBoundedRegularFileSync(file, maxBytes);
}

export function openPrivateAppendFile(file) {
  return openRegularFileSync(
    file,
    Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_APPEND),
    { label: "runner diagnostic path", mode: 0o600, chmod: 0o600, rejectMultipleLinks: true },
  ).fd;
}

export function trimDiagnosticFile(file, maxBytes = 64 * 1024, keepBytes = 32 * 1024) {
  let fd;
  try {
    const opened = openRegularFileSync(file, fsConstants.O_RDWR, {
      label: "runner diagnostic path",
      chmod: 0o600,
      rejectMultipleLinks: true,
    });
    fd = opened.fd;
    if (opened.info.size <= maxBytes) return;
    const length = Math.min(keepBytes, opened.info.size);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, opened.info.size - length + offset);
      if (!count) break;
      offset += count;
    }
    let tail = buffer.subarray(0, offset);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline < tail.length - 1) tail = tail.subarray(newline + 1);
    ftruncateSync(fd, 0);
    if (tail.length) writeSync(fd, tail, 0, tail.length, 0);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {
        // Descriptor close is best effort after the trim result is already determined.
      }
    }
  }
}

export function resourceErrorClass(error) {
  if (error?.code === "integrity_error") return "integrity_error";
  if (error?.code === "MBM_IDENTITY_CHANGED" || error?.cause?.code === "MBM_IDENTITY_CHANGED") return "identity_changed";
  const message = String(error?.message || error || "");
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/symbolic link/i.test(message)) return "symbolic_link_denied";
  if (/multiple hard links/i.test(message)) return "insecure_links";
  if (/readable by group|permissions/i.test(message)) return "insecure_permissions";
  if (/exceeds/i.test(message)) return "size_limit";
  return "resource_unavailable";
}

export function safeReadDir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}
export function acquireRecoveryLock(dir) {
  return acquirePidLock(join(dir, "recovery.lock"), { allowHandoff: true });
}

export function acquireJobCapacityLock(jobRoot) { return acquirePidLock(join(jobRoot, "capacity.lock")); }

export function acquireJobTransitionLock(dir) { return acquirePidLock(join(dir, "transition.lock")); }

export function activeManagedJobLock(file) {
  let snapshot;
  try { snapshot = readPidLockSnapshot(file); } catch {
    return { active: true, pid: null, reason: "invalid_or_unreadable_lock" };
  }
  if (!snapshot) return null;
  if (!isValidPidLockOwner(snapshot.owner, { allowNullProcessStart: true })) {
    return { active: true, pid: null, reason: "invalid_or_unreadable_lock" };
  }
  const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: 5 * 60_000 });
  if (identity.current || (identity.alive && !identity.reclaimable)) {
    return { active: true, pid: snapshot.owner.pid, reason: identity.reason };
  }
  return null;
}

function acquirePidLock(file, { allowHandoff = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = createPidLockOwner({ startedAtMs: currentProcessStartTimeMs() });
    try {
      createExclusiveFileSync(file, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return {
        ...(allowHandoff ? {
          handoff(pid) {
            if (!Number.isInteger(pid) || pid <= 0) return;
            const startedAtMs = processStartTimeMs(pid);
            const nextOwner = {
              ...createPidLockOwner({ startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null }),
              pid,
              token: owner.token,
            };
            replacePrivateTextFile(file, `${JSON.stringify(nextOwner)}\n`);
          },
        } : {}),
        token: owner.token,
        release() { removePidLockOwnedBy(file, owner.token); },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const snapshot = readPidLockSnapshot(file);
      if (!snapshot) continue;
      const validOwner = isValidPidLockOwner(snapshot.owner, { allowNullProcessStart: true });
      if (!validOwner) throw new Error("managed-job lock is malformed; inspect the owner-only state directory");
      const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: 5 * 60_000 });
      if (identity.reclaimable !== true) return null;
      removePidLockSnapshot(file, snapshot);
    }
  }
  return null;
}

function readPidLockSnapshot(file) {
  let opened;
  try {
    opened = retryTransientMultipleLinksSync((residueIdentity) => readBoundedRegularFileWithInfoSync(file, 1024, "job lock", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: residueIdentity,
    }), { verifyResidue: () => verifyExclusiveFilePublicationResidueSync(file) });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(opened.buffer.toString("utf8").trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch { /* Successfully read malformed JSON may be reclaimed only after the stale grace. */ }
  return { owner, info: pidLockIdentity(opened.identityInfo, opened.identity) };
}

function removePidLockOwnedBy(file, token) {
  const snapshot = readPidLockSnapshot(file);
  if (!snapshot || snapshot.owner?.token !== token) return false;
  return removePidLockSnapshot(file, snapshot);
}

function removePidLockSnapshot(file, snapshot) {
  let current;
  try { current = lstatSync(file, { bigint: true }); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!samePidLockIdentity(snapshot.info, pidLockIdentity(current))) return false;
  if (isValidLockToken(snapshot.owner?.token)) {
    const currentOwner = readPidLockSnapshot(file)?.owner;
    if (currentOwner?.token !== snapshot.owner.token) return false;
  }
  try { rmSync(file); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function pidLockIdentity(info, identity = filesystemIdentity(info, "managed-job lock")) {
  return {
    ...identity,
    size: exactFilesystemInteger(info.size, "managed-job lock size"),
    nlink: exactFilesystemInteger(info.nlink, "managed-job lock link count"),
    mtimeMs: filesystemTimeMs(info.mtimeMs, "managed-job lock modification time"),
  };
}

function samePidLockIdentity(left, right) {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs;
}

function replacePrivateTextFile(file, content) {
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  ownerOnlyFile(file);
}
const MAX_CANCELLATION_BYTES = 128;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function writeManagedJobCancellation(file, now = new Date(), options = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now || "");
  if (!validTimestamp(timestamp)) throw new Error("managed job cancellation timestamp is invalid");
  const replace = options.replaceFile || replaceFileAtomicallySync;
  replace(file, `${timestamp}\n`, { mode: 0o600 });
}

export function managedJobCancellationRequested(file, options = {}) {
  const inspect = options.inspectPath || ((target) => inspectPathIfPresentSync(
    target,
    "managed job cancellation marker",
    options.inspectOptions || {},
  ));
  const info = inspect(file);
  if (!info) return false;
  if (info.isSymbolicLink?.() || !info.isFile?.()) {
    throw new Error("managed job cancellation marker must be a regular file and not a symbolic link");
  }
  if (Number(info.nlink) > 1) throw new Error("managed job cancellation marker must not have multiple hard links");
  const read = options.readFile || ((target) => readBoundedRegularFileSync(
    target,
    MAX_CANCELLATION_BYTES,
    "managed job cancellation marker",
    { verifyPathIdentity: true, rejectMultipleLinks: true },
  ));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read(file));
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1 || !validTimestamp(text.slice(0, -1))) {
    throw new Error("managed job cancellation marker is invalid");
  }
  return true;
}

function validTimestamp(value) {
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(Date.parse(value)).toISOString() === value;
}

export function sanitizedGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return env;
}

export function worktreeGitBaseArgs() {
  const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  return ["-c", `core.hooksPath=${nullHooks}`, "-c", "core.fsmonitor=false"];
}

export function inspectGitWorktreeRoot(workspace, { runtimeDir = "", verifyHead = false } = {}) {
  const gitCommand = resolveTrustedGitExecutable({ workspace, ...(runtimeDir ? { runtimeDir } : {}) });
  const env = sanitizedGitEnv();
  const base = worktreeGitBaseArgs();
  const output = execFileSync(gitCommand, [...base, "rev-parse", "--is-inside-work-tree", "--show-toplevel"], {
    cwd: workspace, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = String(output || "").trim().split(/\r?\n/);
  const inside = lines[0]?.trim() === "true";
  const rawTop = lines[1]?.trim() || "";
  if (!inside || !rawTop) throw new Error("isolated_worktree requires a Git repository working tree");
  if (verifyHead) {
    execFileSync(gitCommand, [...base, "rev-parse", "--verify", "HEAD"], {
      cwd: rawTop, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const repoRoot = realpathSync.native ? realpathSync.native(rawTop) : realpathSync(rawTop);
  const canonicalWorkspace = realpathSync.native ? realpathSync.native(workspace) : realpathSync(workspace);
  const relToRepoRoot = relative(repoRoot, canonicalWorkspace);
  if (relToRepoRoot === ".." || relToRepoRoot.startsWith(`..${sep}`) || isAbsolute(relToRepoRoot)) {
    throw new Error("workspace resolves outside its Git repository root");
  }
  return { gitCommand, repoRoot, canonicalWorkspace, relToRepoRoot };
}

function discoverWorkspaceFromWorktreeGit(worktreeDir) {
  try {
    const raw = readFileSync(join(worktreeDir, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/im.exec(raw);
    if (!match) return "";
    const gitdir = resolve(worktreeDir, match[1].trim());
    const marker = `${sep}.git${sep}`;
    const idx = gitdir.indexOf(marker);
    return idx > 0 ? gitdir.slice(0, idx) : dirname(dirname(dirname(gitdir)));
  } catch {
    return "";
  }
}

export function cleanupIsolatedWorktreeDir(worktreeDir, workspace = "", runtimeDir = "") {
  try { lstatSync(worktreeDir); } catch { return; }
  const repoWorkspace = workspace || discoverWorkspaceFromWorktreeGit(worktreeDir);
  if (repoWorkspace) {
    try {
      const gitCommand = resolveTrustedGitExecutable({ workspace: repoWorkspace, ...(runtimeDir ? { runtimeDir } : {}) });
      execFileSync(gitCommand, [...worktreeGitBaseArgs(), "worktree", "remove", "--force", worktreeDir], {
        cwd: repoWorkspace, env: sanitizedGitEnv(), encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
      });
      return;
    } catch {
      // Fall back to direct removal and prune below.
    }
  }
  try { rmSync(worktreeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best-effort cleanup */ }
  if (repoWorkspace) {
    try {
      const gitCommand = resolveTrustedGitExecutable({ workspace: repoWorkspace, ...(runtimeDir ? { runtimeDir } : {}) });
      execFileSync(gitCommand, [...worktreeGitBaseArgs(), "worktree", "prune"], {
        cwd: repoWorkspace, env: sanitizedGitEnv(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* best-effort cleanup */ }
  }
}
