import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isCandidateRuntimeDirectoryName } from "../src/local/state-root-owned-namespaces.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";

const NON_BLOCKING_CLEANUP_CODES = new Set(["EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "ENOMEM", "EROFS", "EMFILE", "ENFILE", "EAGAIN", "ENOBUFS", "EINTR", "ESTALE", "EBUSY", "ENOTEMPTY", "ETIMEDOUT"]);

export function candidateRuntimeContainer(stateRoot) {
  return resolve(stateRoot, "release-channels", "runtimes");
}

export function createCandidateRuntimePrefix({ stateRoot, version, shasum, random = () => randomBytes(6).toString("hex") }) {
  const parsed = parseReleaseVersion(version);
  const digest = String(shasum || "");
  if (!/^[0-9a-f]{40}$/.test(digest)) throw new Error("candidate runtime package SHA-1 is invalid");
  const suffix = String(random());
  if (!/^[0-9a-f]{12}$/.test(suffix)) throw new Error("candidate runtime random suffix is invalid");
  return join(candidateRuntimeContainer(stateRoot), `v${parsed.raw}-${digest.slice(0, 12)}-${suffix}`);
}

export function pruneInactiveCandidateRuntimes({ stateRoot, activePrefix, remove = rmSync } = {}) {
  const state = resolve(String(stateRoot || ""));
  const releaseChannels = join(state, "release-channels");
  const container = join(releaseChannels, "runtimes");
  const active = resolve(String(activePrefix || ""));
  const activeRelative = relative(container, active);
  if (!activeRelative || activeRelative === ".." || activeRelative.startsWith(`..${sep}`) || isAbsolute(activeRelative)) {
    throw new Error("active candidate runtime is outside the runtime container");
  }

  const stateInfo = realDirectoryIfPresent(state, "candidate state root");
  if (!stateInfo) return [];
  const releaseInfo = realDirectoryIfPresent(releaseChannels, "candidate release-channel directory");
  if (!releaseInfo) return [];
  const containerInfo = realDirectoryIfPresent(container, "candidate runtime container");
  if (!containerInfo) return [];
  const canonicalState = realpathSync(state);
  const canonicalReleaseChannels = realpathSync(releaseChannels);
  const canonicalContainer = realpathSync(container);
  requireContainedDirectory(canonicalState, canonicalReleaseChannels, "candidate release-channel directory");
  requireContainedDirectory(canonicalReleaseChannels, canonicalContainer, "candidate runtime container");

  const activeInfo = realDirectoryIfPresent(active, "active candidate runtime");
  if (!activeInfo) throw new Error("active candidate runtime is missing");
  const canonicalActive = realpathSync(active);
  requireContainedDirectory(canonicalContainer, canonicalActive, "active candidate runtime");

  const removed = [];
  for (const entry of readdirSync(container, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isCandidateRuntimeDirectoryName(entry.name)) continue;
    const candidatePath = join(container, entry.name);
    const candidateInfo = realDirectoryIfPresent(candidatePath, "inactive candidate runtime");
    if (!candidateInfo) continue;
    const canonicalCandidate = realpathSync(candidatePath);
    requireContainedDirectory(canonicalContainer, canonicalCandidate, "inactive candidate runtime");
    if (canonicalCandidate === canonicalActive) continue;
    requireSameDirectory(container, containerInfo, "candidate runtime container");
    remove(canonicalCandidate, { recursive: true, force: true });
    removed.push(canonicalCandidate);
  }
  return removed;
}

function realDirectoryIfPresent(directory, label) {
  let info;
  try { info = lstatSync(directory); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return info;
}

function requireContainedDirectory(parent, child, label) {
  const childRelative = relative(parent, child);
  if (!childRelative || childRelative === ".." || childRelative.startsWith(`..${sep}`) || isAbsolute(childRelative)) {
    throw new Error(`${label} escapes its parent directory`);
  }
}

function requireSameDirectory(directory, expected, label) {
  const actual = lstatSync(directory);
  if (actual.isSymbolicLink() || !actual.isDirectory()
      || Number(actual.dev) !== Number(expected.dev) || Number(actual.ino) !== Number(expected.ino)) {
    throw new Error(`${label} identity changed during cleanup`);
  }
}

export function isNonBlockingCandidateRuntimeCleanupError(error) {
  return NON_BLOCKING_CLEANUP_CODES.has(String(error?.code || ""));
}
