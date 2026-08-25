import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubPublicationGitTimeoutMs,
  githubPublicationStateRootFromGitResult,
  resolveGithubPublicationStateRoot,
  withGithubPublicationLock,
} from "../scripts/release-publication-guard.mjs";

assert.equal(githubPublicationGitTimeoutMs, 30_000);

const root = await mkdtemp(join(tmpdir(), "mbm-publication-lock-"));
const linkedRoot = `${root}-linked`;
try {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Synthetic Maintainer"]);
  git(root, ["config", "user.email", "maintainer@example.com"]);
  await writeFile(join(root, "README.md"), "publication lock fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "--quiet", "-m", "test: initialize publication fixture"]);

  const canonicalRoot = await realpath(root);
  const stateRoot = join(canonicalRoot, ".git", "machine-bridge-release-state");
  assert.equal(resolveGithubPublicationStateRoot(root), stateRoot);
  assert.throws(() => githubPublicationStateRootFromGitResult(canonicalRoot, { error: new Error("missing git") }), /could not resolve/);
  assert.throws(() => githubPublicationStateRootFromGitResult(canonicalRoot, { status: 1, stdout: "" }), /could not resolve/);
  assert.throws(() => githubPublicationStateRootFromGitResult(canonicalRoot, { status: 0, stdout: "" }), /invalid common/);
  assert.throws(() => githubPublicationStateRootFromGitResult(canonicalRoot, { status: 0, stdout: "bad\0path" }), /invalid common/);
  assert.throws(() => githubPublicationStateRootFromGitResult(canonicalRoot, { status: 0, stdout: "missing-common-dir" }), /unavailable/);
  assert.equal(githubPublicationStateRootFromGitResult(canonicalRoot, { status: 0, stdout: ".git\n" }), stateRoot);
  git(root, ["worktree", "add", "--quiet", "--detach", linkedRoot, "HEAD"]);
  assert.equal(resolveGithubPublicationStateRoot(linkedRoot), stateRoot);
  assert.notEqual(resolveGithubPublicationStateRoot(linkedRoot), join(linkedRoot, ".git", "machine-bridge-release-state"));
  const previousCwd = process.cwd();
  process.chdir(root);
  try { assert.equal(resolveGithubPublicationStateRoot(), stateRoot); }
  finally { process.chdir(previousCwd); }
  const explicitStateRoot = join(root, "explicit-publication-state");
  assert.equal(await withGithubPublicationLock(root, async () => "explicit", { stateRoot: explicitStateRoot }), "explicit");
  assert.equal(await withGithubPublicationLock(root, async () => "defaults"), "defaults");

  const notRepository = await mkdtemp(join(tmpdir(), "mbm-publication-not-git-"));
  try { assert.throws(() => resolveGithubPublicationStateRoot(notRepository), /could not resolve/); }
  finally { await rm(notRepository, { recursive: true, force: true }); }

  let releaseFirst;
  const first = withGithubPublicationLock(root, async () => {
    await new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
    return "first";
  }, { timeoutMs: 200 });
  while (typeof releaseFirst !== "function") await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  await assert.rejects(() => withGithubPublicationLock(root, async () => "second", { timeoutMs: 30, pollMs: 5 }), /state is busy/);
  releaseFirst();
  assert.equal(await first, "first");

  await assert.rejects(() => withGithubPublicationLock(root, async () => {
    throw new Error("synthetic publication failure");
  }, { timeoutMs: 100 }), /synthetic publication failure/);
  assert.equal(await withGithubPublicationLock(root, async () => "after-failure", { timeoutMs: 100 }), "after-failure");

  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot, "github-publication.lock");
  await writeFile(lockPath, `${JSON.stringify({
    pid: 2_147_483_647,
    token: "a".repeat(32),
    purpose: "github-publication",
    startedAt: new Date().toISOString(),
    processStartedAt: new Date().toISOString(),
    entryScript: "synthetic-stale-owner",
  }, null, 2)}\n`, { mode: 0o600 });
  assert.equal(await withGithubPublicationLock(root, async () => "stale-reclaimed", { timeoutMs: 100 }), "stale-reclaimed");
  await assert.rejects(access(lockPath), { code: "ENOENT" });
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try { assert.equal(resolveGithubPublicationStateRoot(root), stateRoot); }
  finally { process.env.PATH = previousPath; }
} finally {
  await rm(linkedRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
console.log("release publication guard test ok");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: githubPublicationGitTimeoutMs, killSignal: "SIGKILL", windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout || ""}${result.stderr || ""}`);
  return result;
}
