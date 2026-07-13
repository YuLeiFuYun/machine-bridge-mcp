import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { BridgeError } from "./errors.mjs";
import { clampInteger } from "./numbers.mjs";

export class GitService {
  constructor({ resolveExistingPath, displayPath, runProcess, maximumBytes }) {
    this.resolveExistingPath = resolveExistingPath;
    this.displayPath = displayPath;
    this.runProcess = runProcess;
    this.maximumBytes = maximumBytes;
  }

  async status(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return git.result;
    const commandArgs = ["-c", "core.fsmonitor=false", "-C", git.root, "status", "--short", "--branch"];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 30_000, true, 512 * 1024, context);
    return { ...result, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async diff(args = {}, context = {}) {
    const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, this.maximumBytes);
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const commandArgs = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", git.root, "diff", "--no-ext-diff", "--no-textconv"];
    if (args.staged) commandArgs.push("--cached");
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 60_000, true, maxBytes, context);
    return { ...result, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root), staged: args.staged === true };
  }

  async log(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const maxCount = clampInteger(args.max_count, 20, 1, 100);
    const format = "%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e";
    const commandArgs = ["-c", "core.fsmonitor=false", "-C", git.root, "log", `--max-count=${maxCount}`, `--format=${format}`];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 30_000, true, 1024 * 1024, context);
    const commits = result.stdout.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [hash, short, authored_at, author_name, author_email, subject] = record.split("\x1f");
      const commit = { hash, short, authored_at, author_name, subject };
      if (args.include_author_email === true) commit.author_email = author_email;
      return commit;
    });
    return { code: result.code, stderr: result.stderr, commits, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async show(args = {}, context = {}) {
    const git = await this.context(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const revision = validateRevision(args.revision || "HEAD");
    const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, this.maximumBytes);
    const commandArgs = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", git.root, "show", "--no-ext-diff", "--no-textconv", "--decorate=no", revision];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 60_000, true, maxBytes, context);
    return { ...result, revision, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async context(inputPath, context = {}) {
    const target = await this.resolveExistingPath(inputPath);
    const info = await stat(target);
    const cwd = info.isDirectory() ? target : dirname(target);
    const result = await this.runProcess("git", ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--show-toplevel"], 10_000, true, 512 * 1024, context);
    if (result.code !== 0) return { ok: false, result, target };
    const root = result.stdout.trim();
    const repoRelative = relative(root, target);
    if (repoRelative.startsWith(`..${sep}`) || repoRelative === ".." || isAbsolute(repoRelative)) {
      return { ok: false, target, result: { code: 128, stdout: "", stderr: "target is outside the detected git repository" } };
    }
    return { ok: true, target, root, pathspec: repoRelative || "" };
  }
}

function validateRevision(value) {
  const revision = String(value || "HEAD");
  if (!revision || revision.length > 256 || revision.startsWith("-") || revision.includes("\0") || /[\r\n]/.test(revision)) {
    throw new BridgeError("invalid_request", "invalid Git revision");
  }
  return revision;
}
