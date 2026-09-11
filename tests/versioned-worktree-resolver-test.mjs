import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktrees, referenceMatches, resolveVersionedWorktree, versionMatches } from "../scripts/resolve-versioned-worktree.mjs";

assert(parseWorktrees("worktree /tmp/a\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/b\nHEAD def\nprunable stale\n").length === 2,
  "worktree porcelain parser lost records");
assert(versionMatches("3.0.0-beta.182", "beta.182") && referenceMatches("fix/beta182-continuity", "beta.182"),
  "versioned worktree matcher lost prerelease identity normalization");
assert(!referenceMatches("fix/beta1820-continuity", "beta.182")
    && !referenceMatches("fix/alphabeta182-continuity", "beta.182")
    && referenceMatches("fix/rc7-beta182-continuity", "beta.182"),
  "versioned worktree matcher lost exact prerelease token boundaries");

const root = await mkdtemp(join(tmpdir(), "mbm-worktree-resolver-"));
try {
  const main = join(root, "main");
  const beta = join(root, "beta182");
  const dirty = join(root, "dirty");
  await mkdir(main);
  git(main, "init");
  git(main, "config", "user.email", "fixture@example.com");
  git(main, "config", "user.name", "Synthetic Fixture");
  await writeFile(join(main, "package.json"), JSON.stringify({ name: "fixture", version: "3.0.0-beta.181" }));
  git(main, "add", "package.json");
  git(main, "commit", "-m", "fixture: beta181");
  git(main, "branch", "fix/beta182-continuity");
  git(main, "worktree", "add", beta, "fix/beta182-continuity");
  await writeFile(join(beta, "package.json"), JSON.stringify({ name: "fixture", version: "3.0.0-beta.182" }));
  git(beta, "add", "package.json");
  git(beta, "commit", "-m", "fixture: beta182");
  git(main, "branch", "scratch");
  git(main, "worktree", "add", dirty, "scratch");
  await writeFile(join(dirty, "package.json"), JSON.stringify({ name: "fixture", version: "3.0.0-beta.183" }));

  const resolved = resolveVersionedWorktree(main, "beta.182");
  assert(resolved.status === "resolved" && resolved.branch === "fix/beta182-continuity"
    && resolved.head_version === "3.0.0-beta.182" && resolved.fallback_used === false,
  "resolver did not select the unique branch/version identity");
  const dirtyOnly = resolveVersionedWorktree(main, "beta.183");
  assert(dirtyOnly.status === "not_found" && dirtyOnly.rejected_dirty_version_matches.length === 1 && dirtyOnly.fallback_used === false,
  "resolver trusted a dirty package.json as standalone version identity");
  console.log("versioned worktree resolver test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git fixture failed"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
