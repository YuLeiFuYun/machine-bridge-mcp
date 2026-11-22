import { join, isAbsolute, resolve, relative, sep } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { pathEntryIfExists } from "../core/filesystem-identity.mjs";
import { stat } from "node:fs/promises";
import { readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { isSensitivePath } from "../core/operation-risk.mjs";
import { assertStructuredGitCommitStateClear } from "./git-contracts.mjs";

const MAX_GIT_CONFIG_BYTES = 256 * 1024;

export async function assertStructuredGitConfigSafe({
  git,
  inspectWorkingTree = false,
  resolveExistingPath,
  runInternalProcess,
  gitExecutable,
  context = {},
  environment = {},
}) {
  const files = new Set([join(git.commonDir, "config"), join(git.gitDir, "config.worktree")]);
  for (const file of files) {
    const entry = await pathEntryIfExists(file);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || Number(entry.nlink) !== 1 || Number(entry.size) > MAX_GIT_CONFIG_BYTES) {
      throw unsafeConfigError();
    }
    const canonical = await resolveExistingPath(file, context);
    const result = await runInternalProcess(
      gitExecutable(),
      ["--no-pager", "config", "--file", canonical, "--no-includes", "--null", "--name-only", "--list"],
      10_000,
      true,
      MAX_GIT_CONFIG_BYTES,
      context,
      git.root,
      null,
      environment,
    );
    if (result.code !== 0) throw unsafeConfigError();
    const keys = String(result.stdout || "").split("\0").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (keys.some((key) => key.startsWith("include.") || key.startsWith("includeif.")
      || key === "core.attributesfile" || key === "diff.orderfile")) {
      throw unsafeConfigError();
    }
    if (inspectWorkingTree && keys.some((key) => key === "core.excludesfile" || executableFilterKey(key))) {
      throw unsafeConfigError();
    }
  }
}

function executableFilterKey(key) {
  return /^filter\..+\.(?:clean|smudge|process)$/.test(key);
}

function unsafeConfigError() {
  return new BridgeError("authorization_denied", "repository Git configuration is incompatible with the structured Git safety boundary", {
    details: { reason: "unsafe_repository_git_config" },
  });
}
const MAX_ALTERNATES_BYTES = 64 * 1024;

const MAX_ALTERNATE_STORES = 64;

export async function resolveGitMetadataBoundary({ gitDir, commonDir, resolveExistingPath, context = {} }) {
  const objectDir = await requireDirectory(join(commonDir, "objects"), resolveExistingPath, context, "Git object directory");
  const alternateObjectDirs = await resolveAlternateObjectStores(objectDir, resolveExistingPath, context);
  const metadataPaths = [];
  for (const candidate of [
    join(gitDir, "HEAD"),
    join(gitDir, "index"),
    join(gitDir, "refs"),
    join(gitDir, "logs"),
    join(gitDir, "reftable"),
    join(commonDir, "packed-refs"),
    join(commonDir, "shallow"),
    join(commonDir, "refs"),
    join(commonDir, "logs"),
    join(commonDir, "reftable"),
    join(commonDir, "info"),
    join(objectDir, "pack"),
    join(objectDir, "info"),
  ]) {
    const entry = await pathEntryIfExists(candidate);
    if (!entry) continue;
    if (entry.isSymbolicLink()) throw boundaryError("Git metadata path must not be a symbolic link");
    metadataPaths.push(await resolveExistingPath(candidate, context));
  }
  return Object.freeze({ objectDir, alternateObjectDirs: Object.freeze(alternateObjectDirs), metadataPaths: Object.freeze(metadataPaths) });
}

async function resolveAlternateObjectStores(primaryObjectDir, resolveExistingPath, context) {
  const queue = [primaryObjectDir];
  const seen = new Set([primaryObjectDir]);
  const alternates = [];
  while (queue.length) {
    const objectDir = queue.shift();
    const marker = join(objectDir, "info", "alternates");
    const entry = await pathEntryIfExists(marker);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || Number(entry.nlink) !== 1) throw boundaryError("Git alternates metadata must be a single-link regular file");
    const bytes = readBoundedRegularFileSync(marker, MAX_ALTERNATES_BYTES, "Git alternates metadata", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
    const text = bytes.toString("utf8");
    if (text.includes("\0") || text.includes("\r")) throw boundaryError("Git alternates metadata is invalid");
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) throw boundaryError("Git alternate object path is invalid");
      const candidate = isAbsolute(raw) ? raw : resolve(objectDir, raw);
      const canonical = await requireDirectory(candidate, resolveExistingPath, context, "Git alternate object directory");
      if (seen.has(canonical)) continue;
      if (seen.size >= MAX_ALTERNATE_STORES) throw new BridgeError("limit_exceeded", `Git alternate object store count exceeds ${MAX_ALTERNATE_STORES}`);
      seen.add(canonical);
      alternates.push(canonical);
      queue.push(canonical);
    }
  }
  return alternates;
}

async function requireDirectory(path, resolveExistingPath, context, label) {
  const canonical = await resolveExistingPath(path, context);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw boundaryError(`${label} is unavailable`);
  return canonical;
}

function boundaryError(message) {
  return new BridgeError("path_boundary", message, { details: { reason: "git_metadata_boundary" } });
}
/**
 * Enumerate Git paths before returning any content to a delegated principal.
 * If enumeration is incomplete, fail closed rather than returning an unfiltered diff.
 */
export async function filterSensitiveGitPaths({
  target,
  root,
  context,
  commandArgs,
  pathspec,
  gitExecutable,
  runInternalProcess,
  environment,
}) {
  const args = [...commandArgs];
  if (pathspec) args.push("--", pathspec);
  const result = await runInternalProcess(
    gitExecutable, args, 30_000, true, 4 * 1024 * 1024, context, root, null, environment,
  );
  if (result.code !== 0 || Number(result.stdout_truncated_bytes || 0) > 0) {
    return {
      ok: false,
      code: result.code || 1,
      stderr: result.stderr || "cannot safely enumerate Git paths",
    };
  }
  const records = parseGitNameStatus(result.stdout);
  if (!records) return { ok: false, code: 1, stderr: "Git returned an incomplete path-status list" };
  const candidates = [...new Set(records.flatMap((record) => record.paths))]
    .filter((name) => isWithinPath(target, resolve(root, name)));
  const hidden = new Set();
  for (const record of records) {
    if (record.paths.some((name) => isSensitivePath(resolve(root, name)))) {
      for (const name of record.paths) hidden.add(name);
    }
  }
  const paths = candidates.filter((name) => !hidden.has(name));
  return { ok: true, paths, omittedSensitiveFiles: candidates.length - paths.length };
}

function parseGitNameStatus(output) {
  const tokens = String(output || "").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const count = /^[RC]\d+$/.test(status) ? 2 : /^[A-Z]{1,8}$/.test(status) ? 1 : 0;
    if (!count || index + count > tokens.length) return null;
    const paths = tokens.slice(index, index + count);
    index += count;
    if (paths.some((name) => !name || name.includes("\0"))) return null;
    records.push({ status, paths });
  }
  return records;
}

function isWithinPath(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
const GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function createStructuredGitCommit({ git, message, disabledHooksPath, runInternalProcess, gitExecutable, context = {}, environment = {} }) {
  const base = [
    "--no-pager",
    `--git-dir=${git.gitDir}`,
    `--work-tree=${git.root}`,
    "-c", "core.fsmonitor=false",
    "-c", "color.ui=false",
    "-c", `core.hooksPath=${disabledHooksPath}`,
    "-c", "commit.gpgSign=false",
  ];
  const run = (args, stdin = null) => runInternalProcess(
    gitExecutable(), [...base, ...args], 60_000, true, 64 * 1024, context, git.root, stdin, environment,
  );

  await assertStructuredGitCommitStateClear(git.gitDir);
  const treeResult = await run(["write-tree"]);
  const tree = requireHash(treeResult, "Git staged index could not be written");

  const headResult = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
  let oldHead = "";
  if (headResult.code === 0) oldHead = requireHash(headResult, "Git HEAD is invalid");

  const symbolic = await run(["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.code !== 0 && symbolic.code !== 1) throw commitFailure("Git HEAD could not be resolved", symbolic.code);
  const symbolicRef = symbolic.code === 0 ? String(symbolic.stdout || "").trim() : "";
  if (symbolicRef) {
    const refValidation = await run(["check-ref-format", symbolicRef]);
    if (refValidation.code !== 0) throw commitFailure("Git HEAD reference is invalid", refValidation.code);
  }
  if (!oldHead && !symbolicRef) throw commitFailure("Git repository has no commit parent or branch reference", headResult.code);

  if (oldHead) {
    const headTreeResult = await run(["rev-parse", "--verify", "HEAD^{tree}"]);
    const headTree = requireHash(headTreeResult, "Git HEAD tree is invalid");
    if (headTree === tree) throw commitFailure("Git staged index has no changes to commit", 1, "git_commit_empty");
  }

  const commitArgs = ["commit-tree", tree];
  if (oldHead) commitArgs.push("-p", oldHead);
  commitArgs.push("-F", "-");
  const commitResult = await run(commitArgs, message);
  const commit = requireHash(commitResult, "Git commit object could not be created");

  if (symbolicRef) {
    const confirmSymbolic = await run(["symbolic-ref", "-q", "HEAD"]);
    if (confirmSymbolic.code !== 0 || String(confirmSymbolic.stdout || "").trim() !== symbolicRef) {
      throw commitFailure("Git HEAD branch changed concurrently before commit update", confirmSymbolic.code, "git_commit_conflict");
    }
  }
  const expected = oldHead || "0".repeat(tree.length);
  const updateResult = await run(["update-ref", "-m", "machine-bridge-mcp structured commit", "HEAD", commit, expected]);
  if (updateResult.code !== 0) {
    throw commitFailure("Git history changed concurrently or the reference update failed", updateResult.code, "git_commit_conflict");
  }
  return Object.freeze({ committed: true });
}

function requireHash(result, message) {
  if (result.code !== 0) throw commitFailure(message, result.code);
  const value = String(result.stdout || "").trim();
  if (!GIT_HASH.test(value)) throw commitFailure(message, result.code);
  return value;
}

function commitFailure(message, code, reason = "git_commit_failed") {
  return new BridgeError("execution_failed", message, {
    details: { reason, code: Number.isInteger(code) ? code : 1 },
  });
}
