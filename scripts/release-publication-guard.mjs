import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { withOwnerStateLock } from "../src/local/owner-state-lock.mjs";

const CONFIRMATION_FLAG = "--owner-terminal-confirm";
const LOCK_DIRECTORY = "machine-bridge-release-state";
const LOCK_FILE = "github-publication.lock";
const GIT_METADATA_TIMEOUT_MS = 30_000;

export function assertOwnerTerminalPublication(options = {}) {
  let argv = process.argv.slice(2);
  if (Array.isArray(options.argv)) argv = options.argv.map(String);
  const stdin = options.stdin === undefined ? process.stdin : options.stdin;
  const stdout = options.stdout === undefined ? process.stdout : options.stdout;
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  if (!argv.includes(CONFIRMATION_FLAG)) {
    throw new Error(`GitHub publication requires an explicit owner terminal invocation with ${CONFIRMATION_FLAG}`);
  }
  if (stdin.isTTY !== true || stdout.isTTY !== true || stderr.isTTY !== true) {
    throw new Error("GitHub publication requires an interactive owner terminal; background jobs, MCP calls, CI, and redirected sessions are not accepted");
  }
  return Object.freeze({ confirmation_flag: CONFIRMATION_FLAG, interactive_terminal: true });
}

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
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
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

export const githubPublicationConfirmationFlag = CONFIRMATION_FLAG;
export const githubPublicationGitTimeoutMs = GIT_METADATA_TIMEOUT_MS;
