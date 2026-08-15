import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { BridgeError } from "../src/local/errors.mjs";
import { GitService, MAX_GIT_COMMIT_MESSAGE_BYTES } from "../src/local/git-service.mjs";

await import("./git-structured-boundary-test.mjs");
await import("./git-commit-plumbing-test.mjs");
await import("./git-log-format-test.mjs");
await import("./git-metadata-tree-safety-test.mjs");
await import("./git-operation-state-test.mjs");

const root = await mkdtemp(join(tmpdir(), "mbm-git-commit-test-"));
const repo = join(root, "repo");
const home = join(root, "home");
const disabledHooksPath = join(root, "disabled-hooks-does-not-exist");
const git = process.platform === "win32" ? "git.exe" : "git";
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
};

try {
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  checkedGit(["init", "--quiet"], repo);
  checkedGit(["config", "--local", "user.name", "Synthetic Maintainer"], repo);
  checkedGit(["config", "--local", "user.email", "maintainer@example.invalid"], repo);
  checkedGit(["config", "--local", "commit.gpgSign", "true"], repo);

  const hookSentinel = join(repo, "hook-ran.txt");
  const filterSentinel = join(repo, "filter-ran.txt");
  if (process.platform !== "win32") {
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\nprintf 'hook ran\\n' > '${escapeSingleQuotes(hookSentinel)}'\nexit 97\n`, { mode: 0o700 });
    await chmod(hook, 0o700);
  }

  await writeFile(join(repo, "staged.txt"), "staged\n");
  await writeFile(join(repo, "unstaged.txt"), "untracked\n");
  checkedGit(["add", "--", "staged.txt"], repo);

  const processCalls = [];
  const writableRoots = [];
  const service = new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => {
      const canonical = await realpath(value);
      writableRoots.push(canonical);
      return canonical;
    },
    displayPath: (value) => value,
    runInternalProcess: async (command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides) => {
      processCalls.push({ command, args: [...args], timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides });
      return runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides);
    },
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
    disabledHooksPath,
  });

  const message = "fix: create staged-only commit\n\nRegression coverage for narrow Git commit execution.";
  const result = await service.commit({ path: repo, message });
  assert(result.code === 0 && result.committed === true, "GitService did not report the committed staged index");
  const canonicalRepo = await realpath(repo);
  const canonicalGitDir = await realpath(join(repo, ".git"));
  const canonicalObjectDir = await realpath(join(repo, ".git", "objects"));
  assert([canonicalRepo, canonicalGitDir, canonicalObjectDir].every((target) => writableRoots.includes(target)),
    "GitService did not authorize the required repository write roots");

  const commitCall = processCalls.find((call) => call.args.includes("commit-tree"));
  assert(commitCall, "GitService did not create the commit through the fixed plumbing command");
  assert(commitCall.stdin === message, "Git commit message was not delivered over stdin");
  assert(!commitCall.args.includes(message), "Git commit message leaked into process argv");
  assert(processCalls.some((call) => call.args.includes("write-tree")) && processCalls.some((call) => call.args.includes("update-ref")),
    "Git commit plumbing did not bind staged tree creation to an atomic reference update");
  assert(!processCalls.some((call) => call.args.includes("commit")), "GitService fell back to porcelain git commit");
  assert(commitCall.args.includes(`core.hooksPath=${disabledHooksPath}`) && commitCall.args.includes("commit.gpgSign=false"),
    "Git commit plumbing lost hook or signing suppression");
  assert(processCalls.every((call) => call.environmentOverrides?.GIT_OPTIONAL_LOCKS === "0"
    && call.environmentOverrides?.GIT_CONFIG_NOSYSTEM === "1"
    && call.environmentOverrides?.GIT_ATTR_NOSYSTEM === "1"
    && call.environmentOverrides?.GIT_NO_LAZY_FETCH === "1"
    && call.environmentOverrides?.GIT_TERMINAL_PROMPT === "0"),
  "structured Git process lost its isolated optional-lock, config, attributes, or prompt environment");

  if (process.platform !== "win32") assert(!(await exists(hookSentinel)), "Git commit executed the repository pre-commit hook");
  const committedMessage = checkedGit(["log", "-1", "--format=%B"], repo).stdout.trimEnd();
  assert(committedMessage === message, "Git commit message changed while crossing the stdin boundary");
  const tree = checkedGit(["ls-tree", "--name-only", "HEAD"], repo).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(tree.length === 1 && tree[0] === "staged.txt", "Git commit included content outside the existing staged index");

  const filterCommand = process.platform === "win32"
    ? "ignored-filter-command"
    : `sh -c 'touch "$1"; cat' sh '${escapeSingleQuotes(filterSentinel)}'`;
  checkedGit(["config", "--local", "filter.probe.clean", filterCommand], repo);
  await writeFile(join(repo, ".gitattributes"), "*.txt filter=probe\n");
  await writeFile(join(repo, "staged.txt"), "working change\n");
  await rm(filterSentinel, { force: true });
  const statusFailure = await rejected(() => service.status({ path: repo }));
  assert(statusFailure.code === "authorization_denied" && statusFailure.details?.reason === "unsafe_repository_git_config",
    "structured Git status did not fail closed on an executable repository filter");
  const diffFailure = await rejected(() => service.diff({ path: repo }));
  assert(diffFailure.code === "authorization_denied" && diffFailure.details?.reason === "unsafe_repository_git_config",
    "working-tree Git diff did not fail closed on an executable repository filter");
  const commitFilterFailure = await rejected(() => service.commit({ path: repo, message: "fix: must reject executable filter" }));
  assert(commitFilterFailure.code === "authorization_denied" && commitFilterFailure.details?.reason === "unsafe_repository_git_config",
    "structured Git commit did not fail closed before staged-tree conversion could execute a repository filter");
  const stagedDiff = await service.diff({ path: repo, staged: true });
  assert(stagedDiff.code === 0, "staged Git diff should remain readable without working-tree conversion");
  if (process.platform !== "win32") assert(!(await exists(filterSentinel)), "a rejected structured Git operation executed the repository clean filter");
  checkedGit(["config", "--local", "--unset-all", "filter.probe.clean"], repo);
  await rm(join(repo, ".gitattributes"), { force: true });
  await writeFile(join(repo, "staged.txt"), "staged\n");
  assert(checkedGit(["status", "--short"], repo).stdout.trim() === "?? unstaged.txt",
    "Git commit mutated or staged the untracked working-tree file");

  const before = checkedGit(["rev-parse", "HEAD"], repo).stdout.trim();
  const emptyFailure = await rejected(() => service.commit({ path: repo, message: "fix: should not create an empty commit" }));
  assert(emptyFailure.code === "execution_failed" && emptyFailure.details?.reason === "git_commit_empty",
    "empty staged index did not fail with the bounded Git commit error");
  assert(checkedGit(["rev-parse", "HEAD"], repo).stdout.trim() === before, "failed Git commit changed repository history");

  const callsBeforeOversize = processCalls.length;
  const oversized = "😀".repeat(Math.ceil(MAX_GIT_COMMIT_MESSAGE_BYTES / 4) + 1);
  const oversizeFailure = await rejected(() => service.commit({ path: repo, message: oversized }));
  assert(oversizeFailure.code === "limit_exceeded", "UTF-8 commit message byte limit was not enforced");
  assert(processCalls.length === callsBeforeOversize, "oversized Git commit message reached the process boundary");

  const includedConfig = join(root, "included.gitconfig");
  await writeFile(includedConfig, "[core]\n\tignoreCase = false\n");
  checkedGit(["config", "--local", "include.path", includedConfig], repo);
  const includeFailure = await rejected(() => service.log({ path: repo }));
  assert(includeFailure.code === "authorization_denied" && includeFailure.details?.reason === "unsafe_repository_git_config",
    "structured Git log followed a repository-local config include outside the checked boundary");
  checkedGit(["config", "--local", "--unset-all", "include.path"], repo);

  checkedGit(["config", "--local", "diff.orderFile", includedConfig], repo);
  const orderFileFailure = await rejected(() => service.diff({ path: repo }));
  assert(orderFileFailure.code === "authorization_denied" && orderFileFailure.details?.reason === "unsafe_repository_git_config",
    "structured Git diff followed a repository-local external order-file path");
  checkedGit(["config", "--local", "--unset-all", "diff.orderFile"], repo);

  checkedGit(["config", "--local", "extensions.partialClone", "origin"], repo);
  const partialCloneFailure = await rejected(() => service.log({ path: repo }));
  assert(partialCloneFailure.code === "authorization_denied" && partialCloneFailure.details?.reason === "unsafe_repository_git_config",
    "structured Git accepted repository configuration that can lazily fetch missing objects");
  checkedGit(["config", "--local", "--unset-all", "extensions.partialClone"], repo);

  await writeFile(join(repo, "race.txt"), "race\n");
  checkedGit(["add", "--", "race.txt"], repo);
  let raceInjected = false;
  const racingService = new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => realpath(value),
    displayPath: (value) => value,
    runInternalProcess: async (command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides) => {
      if (!raceInjected && args.includes("update-ref")) {
        raceInjected = true;
        checkedGit(["-c", `core.hooksPath=${disabledHooksPath}`, "-c", "commit.gpgSign=false", "commit", "--allow-empty", "--quiet", "-m", "racer"], repo);
      }
      return runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides);
    },
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
    disabledHooksPath,
  });
  const conflict = await rejected(() => racingService.commit({ path: repo, message: "fix: should lose the ref race" }));
  assert(raceInjected && conflict.code === "execution_failed" && conflict.details?.reason === "git_commit_conflict",
    "Git commit did not fail closed when HEAD changed between commit-object creation and reference update");
  assert(checkedGit(["log", "-1", "--format=%s"], repo).stdout.trim() === "racer",
    "Git commit conflict overwrote the concurrently published HEAD");

  const mergeRepo = join(root, "merge-state");
  await mkdir(mergeRepo, { recursive: true });
  checkedGit(["init", "--quiet"], mergeRepo);
  checkedGit(["config", "--local", "user.name", "Synthetic Maintainer"], mergeRepo);
  checkedGit(["config", "--local", "user.email", "maintainer@example.invalid"], mergeRepo);
  const mainBranch = checkedGit(["symbolic-ref", "--short", "HEAD"], mergeRepo).stdout.trim();
  await writeFile(join(mergeRepo, "base.txt"), "base\n");
  checkedGit(["add", "--", "base.txt"], mergeRepo);
  checkedGit(["commit", "--quiet", "-m", "base"], mergeRepo);
  checkedGit(["checkout", "--quiet", "-b", "topic"], mergeRepo);
  await writeFile(join(mergeRepo, "topic.txt"), "topic\n");
  checkedGit(["add", "--", "topic.txt"], mergeRepo);
  checkedGit(["commit", "--quiet", "-m", "topic"], mergeRepo);
  checkedGit(["checkout", "--quiet", mainBranch], mergeRepo);
  await writeFile(join(mergeRepo, "main.txt"), "main\n");
  checkedGit(["add", "--", "main.txt"], mergeRepo);
  checkedGit(["commit", "--quiet", "-m", "main"], mergeRepo);
  checkedGit(["merge", "--no-commit", "--no-ff", "topic"], mergeRepo);
  const mergeHeadBefore = checkedGit(["rev-parse", "MERGE_HEAD"], mergeRepo).stdout.trim();
  const mergeCurrentBefore = checkedGit(["rev-parse", "HEAD"], mergeRepo).stdout.trim();
  const mergeProcessCalls = [];
  const mergeService = new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => realpath(value),
    displayPath: (value) => value,
    runInternalProcess: async (command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides) => {
      mergeProcessCalls.push([...args]);
      return runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides);
    },
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
    disabledHooksPath,
  });
  const mergeFailure = await rejected(() => mergeService.commit({ path: mergeRepo, message: "merge: must preserve repository state" }));
  assert(mergeFailure.code === "execution_failed" && mergeFailure.details?.reason === "git_commit_repository_state",
    "structured Git commit did not reject an in-progress merge before creating incorrect single-parent history");
  assert(!mergeProcessCalls.some((args) => args.includes("write-tree") || args.includes("commit-tree") || args.includes("update-ref")),
    "in-progress merge rejection occurred only after Git history mutation plumbing started");
  assert(checkedGit(["rev-parse", "HEAD"], mergeRepo).stdout.trim() === mergeCurrentBefore
    && checkedGit(["rev-parse", "MERGE_HEAD"], mergeRepo).stdout.trim() === mergeHeadBefore,
  "rejected structured commit changed HEAD or merge state");

  const alternateRepo = join(root, "alternate-reader");
  await mkdir(alternateRepo, { recursive: true });
  checkedGit(["init", "--quiet"], alternateRepo);
  const sourceHead = checkedGit(["rev-parse", "HEAD"], repo).stdout.trim();
  const sourceObjects = await realpath(join(repo, ".git", "objects"));
  await writeFile(join(alternateRepo, ".git", "objects", "info", "alternates"), `${sourceObjects}\n`);
  checkedGit(["update-ref", "refs/heads/main", sourceHead], alternateRepo);
  checkedGit(["symbolic-ref", "HEAD", "refs/heads/main"], alternateRepo);
  const canonicalAlternateRepo = await realpath(alternateRepo);
  let alternateRestrictedProcessCalls = 0;
  const alternateRestricted = new GitService({
    resolveExistingPath: async (value) => confinedRealpath(canonicalAlternateRepo, value),
    resolveWritePath: async (value) => confinedRealpath(canonicalAlternateRepo, value),
    displayPath: (value) => value,
    runInternalProcess: async () => {
      alternateRestrictedProcessCalls += 1;
      throw new Error("Git subprocess must not start before alternate object-store authorization");
    },
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
  });
  const alternateFailure = await rejected(() => alternateRestricted.log({ path: canonicalAlternateRepo }));
  assert(alternateFailure.code === "path_boundary" && alternateRestrictedProcessCalls === 0,
    "structured Git followed an external alternate object store before enforcing the workspace boundary");
  const alternateOwner = new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => realpath(value),
    displayPath: (value) => value,
    runInternalProcess: async (command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides) =>
      runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides),
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
  });
  const alternateLog = await alternateOwner.log({ path: canonicalAlternateRepo, max_count: 1 });
  assert(alternateLog.code === 0 && alternateLog.commits[0]?.hash === sourceHead,
    "owner/unrestricted structured Git could not read an explicitly authorized alternate object store");

  const maliciousLogRepo = join(root, "malicious-log");
  await mkdir(maliciousLogRepo, { recursive: true });
  checkedGit(["init", "--quiet"], maliciousLogRepo);
  const emptyTree = checkedGit(["mktree"], maliciousLogRepo).stdout.trim();
  const rawCommit = `tree ${emptyTree}\nauthor Evil\x1fInjected <private-author@example.invalid> 1700000000 +0000\ncommitter Synthetic <committer@example.invalid> 1700000000 +0000\n\nnormal subject\n`;
  const rawCommitResult = runGitProcess(git, ["hash-object", "-t", "commit", "-w", "--stdin"], 30_000, 1024 * 1024, maliciousLogRepo, rawCommit);
  assert(rawCommitResult.code === 0, "Git fixture rejected the control-character commit object");
  const maliciousHash = rawCommitResult.stdout.trim();
  checkedGit(["update-ref", "refs/heads/main", maliciousHash], maliciousLogRepo);
  checkedGit(["symbolic-ref", "HEAD", "refs/heads/main"], maliciousLogRepo);
  const maliciousLogService = new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => realpath(value),
    displayPath: (value) => value,
    runInternalProcess: async (command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides) =>
      runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides),
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
  });
  const maliciousLogFailure = await rejected(() => maliciousLogService.log({ path: maliciousLogRepo, max_count: 1 }));
  assert(maliciousLogFailure.code === "execution_failed" && maliciousLogFailure.details?.reason === "git_log_parse_failed",
    "Git log control-character framing did not fail closed before author-email projection");

  const linked = join(root, "linked-worktree");
  checkedGit(["worktree", "add", "--quiet", "--detach", linked, "HEAD"], repo);
  const canonicalLinked = await realpath(linked);
  let restrictedProcessCalls = 0;
  const restricted = new GitService({
    resolveExistingPath: async (value) => confinedRealpath(canonicalLinked, value),
    resolveWritePath: async (value) => confinedRealpath(canonicalLinked, value),
    displayPath: (value) => value,
    runInternalProcess: async () => {
      restrictedProcessCalls += 1;
      throw new Error("Git subprocess must not start before metadata path authorization");
    },
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
  });
  const linkedFailure = await rejected(() => restricted.status({ path: canonicalLinked }));
  assert(linkedFailure.code === "path_boundary", "linked worktree external Git metadata was not denied by the path boundary");
  assert(restrictedProcessCalls === 0, "linked worktree boundary denial occurred only after a Git subprocess had already read external metadata");

  console.log("bounded Git commit test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function runGitProcess(command, args, timeoutMs, maxOutputBytes, cwd, stdin, environmentOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...environmentOverrides },
    encoding: "utf8",
    input: stdin === null || stdin === undefined ? undefined : String(stdin),
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return { code: Number.isInteger(result.status) ? result.status : 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checkedGit(args, cwd) {
  const result = runGitProcess(git, args, 30_000, 1024 * 1024, cwd, null);
  if (result.code !== 0) throw new Error(`Git test command failed (${args[0]}): ${result.stderr || result.stdout}`);
  return result;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function rejected(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected operation to be rejected");
}

async function confinedRealpath(rootPath, value) {
  const canonical = await realpath(value);
  const rel = relative(rootPath, canonical);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new BridgeError("path_boundary", "path is outside the configured workspace");
  }
  return canonical;
}

function escapeSingleQuotes(value) {
  return String(value).replaceAll("'", "'\\''");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
