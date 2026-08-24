import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { withOwnerStateLock } from "../src/local/owner-state-lock.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";

const LOCK_DIRECTORY = "machine-bridge-release-state";
const LOCK_FILE = "github-publication.lock";
const GIT_METADATA_TIMEOUT_MS = 30_000;

export function withGithubPublicationLock(root, callback, options = {}) {
  const stateRoot = options.stateRoot
    ? resolve(String(options.stateRoot))
    : resolveGithubPublicationStateRoot(root);
  return withOwnerStateLock(stateRoot, callback, {
    purpose: "github-publication",
    fileName: LOCK_FILE,
    label: "GitHub publication",
    timeoutMs: options.timeoutMs ?? 1_000,
    pollMs: options.pollMs ?? 25,
    maxAgeMs: options.maxAgeMs ?? 6 * 60 * 60 * 1_000,
  });
}

export function resolveGithubPublicationStateRoot(root) {
  const repositoryRoot = resolve(String(root || ""));
  const git = resolveTrustedGitExecutable({ workspace: repositoryRoot });
  const result = spawnSync(git, ["rev-parse", "--git-common-dir"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: GIT_METADATA_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  return githubPublicationStateRootFromGitResult(repositoryRoot, result);
}

export function githubPublicationStateRootFromGitResult(repositoryRoot, result) {
  if (result?.error || result?.status !== 0) throw new Error("could not resolve the common Git publication state directory");
  const path = String(result?.stdout ?? "").trim();
  if (!path || path.includes("\0")) throw new Error("Git returned an invalid common publication state directory");
  const commonDirectory = resolve(repositoryRoot, path);
  try {
    return join(realpathSync.native(commonDirectory), LOCK_DIRECTORY);
  } catch {
    throw new Error("common Git publication state directory is unavailable");
  }
}

export const githubPublicationGitTimeoutMs = GIT_METADATA_TIMEOUT_MS;
