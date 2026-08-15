import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "./errors.mjs";
import { STRUCTURED_GIT_FIXED_ENVIRONMENT } from "./fixed-process-environment.mjs";
import { createStructuredGitCommit } from "./git-commit.mjs";
import { assertStructuredGitConfigSafe } from "./git-config-safety.mjs";
import { resolveGitMetadataBoundary } from "./git-metadata-boundary.mjs";
import { assertGitMetadataTreesSafe } from "./git-metadata-tree-safety.mjs";
import { parseStructuredGitLog } from "./git-log-parser.mjs";
import { clampInteger } from "./numbers.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
export const MAX_GIT_COMMIT_MESSAGE_BYTES = 64 * 1024;
const STRUCTURED_GIT_ENVIRONMENT = STRUCTURED_GIT_FIXED_ENVIRONMENT;

export class GitService {
  constructor({ resolveExistingPath, resolveWritePath, displayPath, runInternalProcess, gitExecutable, maximumBytes, disabledHooksPath = "" }) {
    this.resolveExistingPath = resolveExistingPath;
    this.resolveWritePath = typeof resolveWritePath === "function" ? resolveWritePath : resolveExistingPath;
    this.displayPath = displayPath;
    this.runInternalProcess = runInternalProcess;
    this.gitExecutable = typeof gitExecutable === "function" ? gitExecutable : () => String(gitExecutable || "");
    this.maximumBytes = maximumBytes;
    this.disabledHooksPath = String(disabledHooksPath || "");
  }

  async status(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return git.result;
    await this.assertSafeConfig(git, context, true);
    const commandArgs = [...gitCommandPrefix(git), "-c", "status.submoduleSummary=false", "status", "--short", "--branch", "--ignore-submodules=all"];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runInternalProcess(
      this.gitExecutable(), commandArgs, 30_000, true, 512 * 1024, context, git.root, null, STRUCTURED_GIT_ENVIRONMENT,
    );
    return { ...result, path: this.displayPath(git.target, context), gitRoot: this.displayPath(git.root, context) };
  }

  async diff(args = {}, context = {}) {
    const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, this.maximumBytes);
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target, context) };
    await this.assertSafeConfig(git, context, args.staged !== true);
    const commandArgs = [...gitCommandPrefix(git), "-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];
    if (args.staged) commandArgs.push("--cached");
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runInternalProcess(
      this.gitExecutable(), commandArgs, 60_000, true, maxBytes, context, git.root, null, STRUCTURED_GIT_ENVIRONMENT,
    );
    return { ...result, path: this.displayPath(git.target, context), gitRoot: this.displayPath(git.root, context), staged: args.staged === true };
  }

  async log(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target, context) };
    await this.assertSafeConfig(git, context, false);
    const maxCount = clampInteger(args.max_count, 20, 1, 100);
    const format = "%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e";
    const commandArgs = [...gitCommandPrefix(git), "-c", "log.showSignature=false", "log", "--no-show-signature", `--max-count=${maxCount}`, `--format=${format}`];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runInternalProcess(
      this.gitExecutable(), commandArgs, 30_000, true, 1024 * 1024, context, git.root, null, STRUCTURED_GIT_ENVIRONMENT,
    );
    const commits = parseStructuredGitLog(result.stdout, args.include_author_email === true);
    return { code: result.code, stderr: result.stderr, commits, path: this.displayPath(git.target, context), gitRoot: this.displayPath(git.root, context) };
  }

  async show(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target, context) };
    await this.assertSafeConfig(git, context, false);
    const revision = validateRevision(args.revision || "HEAD");
    const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, this.maximumBytes);
    const commandArgs = [...gitCommandPrefix(git), "-c", "diff.external=", "-c", "log.showSignature=false", "show", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--ignore-submodules=all", "--decorate=no", revision];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runInternalProcess(
      this.gitExecutable(), commandArgs, 60_000, true, maxBytes, context, git.root, null, STRUCTURED_GIT_ENVIRONMENT,
    );
    return { ...result, revision, path: this.displayPath(git.target, context), gitRoot: this.displayPath(git.root, context) };
  }

  async commit(args = {}, context = {}) {
    const message = validateCommitMessage(args.message);
    const git = await this.context(args.path || ".", context);
    if (!git.ok) throw new BridgeError("execution_failed", "Git commit requires a repository path");
    await this.assertSafeConfig(git, context, true);
    for (const target of new Set([git.root, git.gitDir, git.commonDir, git.objectDir, ...git.metadataPaths])) {
      await this.resolveWritePath(target, context);
    }
    const disabledHooksPath = this.disabledHooksPath || join(tmpdir(), `machine-bridge-mcp-disabled-hooks-${randomBytes(16).toString("hex")}`);
    if (!isAbsolute(disabledHooksPath)) throw new BridgeError("integrity_error", "Git commit hook isolation path is unavailable");
    await createStructuredGitCommit({
      git,
      message,
      disabledHooksPath,
      runInternalProcess: this.runInternalProcess,
      gitExecutable: this.gitExecutable,
      context,
      environment: STRUCTURED_GIT_ENVIRONMENT,
    });
    return { code: 0, committed: true, path: this.displayPath(git.target, context), gitRoot: this.displayPath(git.root, context) };
  }

  assertSafeConfig(git, context, inspectWorkingTree) {
    return assertStructuredGitConfigSafe({
      git,
      inspectWorkingTree,
      resolveExistingPath: this.resolveExistingPath,
      runInternalProcess: this.runInternalProcess,
      gitExecutable: this.gitExecutable,
      context,
      environment: STRUCTURED_GIT_ENVIRONMENT,
    });
  }

  async context(inputPath, context = {}) {
    const target = await this.resolveExistingPath(inputPath, context);
    const info = await stat(target);
    const cwd = info.isDirectory() ? target : dirname(target);
    const repository = await this.discoverRepository(cwd, context);
    if (!repository) return { ok: false, target, result: { code: 128, stdout: "", stderr: "not a Git repository within the permitted path boundary" } };
    const repoRelative = relative(repository.root, target);
    if (repoRelative.startsWith(`..${sep}`) || repoRelative === ".." || isAbsolute(repoRelative)) {
      return { ok: false, target, result: { code: 128, stdout: "", stderr: "target is outside the detected git repository" } };
    }
    return { ok: true, target, ...repository, pathspec: repoRelative || "" };
  }

  async discoverRepository(start, context = {}) {
    let root = await this.resolveExistingPath(start, context);
    while (true) {
      const marker = join(root, ".git");
      const entry = await pathEntryIfExists(marker);
      if (entry) {
        if (entry.isSymbolicLink()) throw new BridgeError("path_boundary", "Git metadata marker must not be a symbolic link");
        let gitDir;
        if (entry.isDirectory()) gitDir = await this.resolveExistingPath(marker, context);
        else if (entry.isFile()) {
          const value = readGitPathFile(marker, "Git metadata pointer", true);
          gitDir = await this.resolveExistingPath(isAbsolute(value) ? value : resolve(root, value), context);
        } else throw new BridgeError("invalid_request", "Git metadata marker must be a directory or regular pointer file");
        const gitInfo = await stat(gitDir);
        if (!gitInfo.isDirectory()) throw new BridgeError("invalid_request", "Git metadata directory is unavailable");
        const commonDir = await this.resolveCommonDirectory(gitDir, context);
        const metadata = await resolveGitMetadataBoundary({
          gitDir,
          commonDir,
          resolveExistingPath: this.resolveExistingPath,
          context,
        });
        if (requiresMetadataTreeScan(context)) {
          await assertGitMetadataTreesSafe([metadata.objectDir, ...metadata.alternateObjectDirs, ...metadata.metadataPaths], { signal: context.signal });
        }
        return { root, gitDir, commonDir, ...metadata };
      }
      const parent = dirname(root);
      if (parent === root) return null;
      try { root = await this.resolveExistingPath(parent, context); }
      catch (error) { if (error?.code === "path_boundary") return null; throw error; }
    }
  }

  async resolveCommonDirectory(gitDir, context = {}) {
    const marker = join(gitDir, "commondir");
    const entry = await pathEntryIfExists(marker);
    if (!entry) return gitDir;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new BridgeError("path_boundary", "Git common-directory pointer must be a regular file");
    const value = readGitPathFile(marker, "Git common-directory pointer", false);
    const commonDir = await this.resolveExistingPath(isAbsolute(value) ? value : resolve(gitDir, value), context);
    const info = await stat(commonDir);
    if (!info.isDirectory()) throw new BridgeError("invalid_request", "Git common directory is unavailable");
    return commonDir;
  }
}

function gitCommandPrefix(git) {
  return [
    "--no-pager",
    "--literal-pathspecs",
    `--git-dir=${git.gitDir}`,
    `--work-tree=${git.root}`,
    "-c", "core.fsmonitor=false",
    "-c", "color.ui=false",
  ];
}
function requiresMetadataTreeScan(context) {
  return Boolean(context?.authority) && context.authority.effectivePolicy?.unrestrictedPaths !== true;
}
function readGitPathFile(file, label, gitdirPrefix) {
  const buffer = readBoundedRegularFileSync(file, 4096, label, {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  const text = buffer.toString("utf8");
  const pattern = gitdirPrefix ? /^gitdir: ([^\r\n\0]+)\r?\n?$/ : /^([^\r\n\0]+)\r?\n?$/;
  const match = pattern.exec(text);
  if (!match || !match[1]) throw new BridgeError("invalid_request", `${label} is invalid`);
  return match[1];
}

function validateRevision(value) {
  const revision = String(value || "HEAD");
  if (!revision || revision.length > 256 || revision.startsWith("-") || revision.includes("\0") || /[\r\n]/.test(revision)) {
    throw new BridgeError("invalid_request", "invalid Git revision");
  }
  return revision;
}

function validateCommitMessage(value) {
  if (typeof value !== "string" || !value.trim()) throw new BridgeError("invalid_request", "Git commit message is required");
  if (value.includes("\0")) throw new BridgeError("invalid_request", "Git commit message contains a NUL byte");
  if (Buffer.byteLength(value, "utf8") > MAX_GIT_COMMIT_MESSAGE_BYTES) {
    throw new BridgeError("limit_exceeded", `Git commit message exceeds ${MAX_GIT_COMMIT_MESSAGE_BYTES} bytes`);
  }
  return value;
}
