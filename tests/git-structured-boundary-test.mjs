import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/local/git-service.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-structured-git-boundary-"));
const home = join(root, "home");
const git = process.platform === "win32" ? "git.exe" : "git";
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
};
const restrictedContext = { authority: { effectivePolicy: { unrestrictedPaths: false } } };

try {
  await mkdir(home, { recursive: true });
  const service = gitService();
  await testGitOwnsRefGrammar(service);
  await testFileAndNonRepositoryInputs(service);
  await testMetadataTraversalCancellation();
  if (process.platform !== "win32") {
    await testLiteralPathspec(service);
    await testMetadataDescendantLink();
  }
  console.log("structured Git boundary test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testGitOwnsRefGrammar(service) {
  const repo = join(root, "odd-ref");
  await mkdir(repo, { recursive: true });
  initRepository(repo);
  checkedGit(["symbolic-ref", "HEAD", "refs/heads/-topic"], repo);
  await writeFile(join(repo, "tracked.txt"), "tracked\n");
  checkedGit(["add", "--", "tracked.txt"], repo);
  const result = await service.commit({ path: repo, message: "fix: accept Git-valid ref" });
  assert(result.committed === true && checkedGit(["symbolic-ref", "HEAD"], repo).stdout.trim() === "refs/heads/-topic",
    "structured Git commit rejected a reference accepted by Git's own grammar");
}

async function testFileAndNonRepositoryInputs(service) {
  const repo = join(root, "file-input");
  await mkdir(repo, { recursive: true });
  initRepository(repo);
  const file = join(repo, "tracked.txt");
  await writeFile(file, "tracked\n");
  checkedGit(["add", "."], repo);
  checkedGit(["commit", "--quiet", "-m", "baseline"], repo);
  const status = await service.status({ path: file });
  assert(status.code === 0, "structured Git did not accept a regular-file target inside a repository");
  const plain = join(root, "plain-directory");
  await mkdir(plain);
  const context = await service.context(plain);
  assert(context.ok === false && context.result.code === 128, "structured Git did not safely report a non-repository path");
}

async function testMetadataTraversalCancellation() {
  const repo = join(root, "metadata-cancellation");
  await mkdir(repo, { recursive: true });
  initRepository(repo);
  await writeFile(join(repo, "tracked.txt"), "tracked\n");
  checkedGit(["add", "."], repo);
  checkedGit(["commit", "--quiet", "-m", "baseline"], repo);
  const controller = new AbortController();
  const reason = new Error("synthetic Git metadata cancellation");
  controller.abort(reason);
  let processCalls = 0;
  const restricted = gitService(async () => {
    processCalls += 1;
    throw new Error("Git subprocess started after metadata traversal cancellation");
  });
  const failure = await rejected(() => restricted.status({ path: repo }, {
    ...restrictedContext,
    signal: controller.signal,
  }));
  assert(failure === reason && processCalls === 0,
    "structured Git did not propagate runtime cancellation into pre-process metadata traversal");
}

async function testLiteralPathspec(service) {
  const repo = join(root, "literal-pathspec");
  const magicDirectory = join(repo, ":(top,glob)**");
  await mkdir(magicDirectory, { recursive: true });
  initRepository(repo);
  await writeFile(join(repo, "secret.txt"), "before\n");
  await writeFile(join(magicDirectory, "inside.txt"), "inside\n");
  checkedGit(["add", "."], repo);
  checkedGit(["commit", "--quiet", "-m", "baseline"], repo);
  await writeFile(join(repo, "secret.txt"), "after\n");
  const result = await service.diff({ path: magicDirectory });
  assert(result.code === 0 && !result.stdout.includes("secret.txt"),
    "structured Git interpreted a literal existing path as pathspec magic and returned out-of-scope content");
}

async function testMetadataDescendantLink() {
  const repo = join(root, "metadata-link");
  await mkdir(repo, { recursive: true });
  initRepository(repo);
  await writeFile(join(repo, "tracked.txt"), "outside-object\n");
  checkedGit(["add", "."], repo);
  checkedGit(["commit", "--quiet", "-m", "baseline"], repo);
  const blob = checkedGit(["hash-object", "tracked.txt"], repo).stdout.trim();
  const looseObject = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  const outsideObject = join(root, "outside-loose-object");
  await rename(looseObject, outsideObject);
  await symlink(outsideObject, looseObject);
  let processCalls = 0;
  const restricted = gitService(async () => {
    processCalls += 1;
    throw new Error("Git subprocess started before metadata-tree validation");
  });
  const failure = await rejected(() => restricted.show({ path: repo }, restrictedContext));
  assert(failure.code === "path_boundary" && processCalls === 0,
    "restricted structured Git followed a descendant metadata link before enforcing the path boundary");
}

function gitService(runInternalProcess = runGitProcess) {
  return new GitService({
    resolveExistingPath: async (value) => realpath(value),
    resolveWritePath: async (value) => realpath(value),
    displayPath: (value) => value,
    runInternalProcess,
    gitExecutable: () => git,
    maximumBytes: 1024 * 1024,
    disabledHooksPath: join(root, "disabled-hooks-does-not-exist"),
  });
}

function initRepository(repo) {
  checkedGit(["init", "--quiet"], repo);
  checkedGit(["config", "--local", "user.name", "Synthetic Maintainer"], repo);
  checkedGit(["config", "--local", "user.email", "maintainer@example.invalid"], repo);
}

async function runGitProcess(command, args, timeoutMs, _allowFailure, maxOutputBytes, _context, cwd, stdin, environmentOverrides = {}) {
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
  const result = spawnSync(git, args, { cwd, env, encoding: "utf8", timeout: 30_000, windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git fixture command failed (${args[0]}): ${result.stderr || result.stdout}`);
  return result;
}

async function rejected(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected operation to be rejected");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
