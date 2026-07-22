import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseReleaseVersion } from "./release-channel.mjs";

const RUNTIME_DIRECTORY_PATTERN = /^v[0-9A-Za-z.-]+-[0-9a-f]{12}-[0-9a-f]{12}$/;

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
  const container = candidateRuntimeContainer(stateRoot);
  const active = resolve(String(activePrefix || ""));
  const activeRelative = relative(container, active);
  if (!activeRelative || activeRelative === ".." || activeRelative.startsWith(`..${sep}`) || isAbsolute(activeRelative)) {
    throw new Error("active candidate runtime is outside the runtime container");
  }
  if (!existsSync(container)) return [];
  const removed = [];
  for (const entry of readdirSync(container, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUNTIME_DIRECTORY_PATTERN.test(entry.name)) continue;
    const candidate = resolve(container, entry.name);
    if (candidate === active) continue;
    remove(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}
