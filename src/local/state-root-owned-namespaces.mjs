import { readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectPathIfPresentSync } from "./secure-file.mjs";

const TOOLCHAIN_DIRECTORY = /^(?:npm-[0-9A-Za-z.+_-]+-hardened-[a-f0-9]{16}|wrangler-[0-9A-Za-z.+_-]+-[a-f0-9]{16})$/;
const TOOLCHAIN_LOCK_TEMP = /^\.wrangler-toolchain\.lock\.\d+\.[a-f0-9]{16}\.tmp$/;
const ACTIVATION_RECORD = /^v[0-9A-Za-z.-]+\.json$/;
const ACTIVATION_TEMP = /^\.v[0-9A-Za-z.-]+\.json\.\d+\.[a-f0-9]{16}\.tmp$/;
const RUNTIME_DIRECTORY = /^v[0-9A-Za-z.-]+-[0-9a-f]{12}-[0-9a-f]{12}$/;
const LEGACY_RELEASE_TASK = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

export function isCandidateRuntimeDirectoryName(name) { return RUNTIME_DIRECTORY.test(String(name || "")); }

export function validateOwnedStateNamespaces(root) {
  validateToolchains(join(root, "toolchains"));
  validateReleaseChannels(join(root, "release-channels"));
  validateLegacyReleaseTasks(join(root, "release-tasks"));
}

function validateToolchains(directory) {
  if (!realDirectoryIfPresent(directory, "toolchain state namespace")) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "wrangler-toolchain.lock" || TOOLCHAIN_LOCK_TEMP.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Wrangler toolchain lock state has an invalid type before state removal");
      continue;
    }
    if (!TOOLCHAIN_DIRECTORY.test(entry.name) || !entry.isDirectory()) {
      throw new Error("toolchain state namespace contains an unexpected entry; state was kept for inspection");
    }
  }
}

function validateReleaseChannels(directory) {
  if (!realDirectoryIfPresent(directory, "release-channel state namespace")) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !["activations", "runtimes", "browser-extension"].includes(entry.name)) {
      throw new Error("release-channel state namespace contains an unexpected entry; state was kept for inspection");
    }
  }
  validateNamedChildren(join(directory, "activations"), "activation record", [ACTIVATION_RECORD, ACTIVATION_TEMP], "file");
  validateNamedChildren(join(directory, "runtimes"), "candidate runtime", [RUNTIME_DIRECTORY], "directory");
  validateBrowserExtension(join(directory, "browser-extension"));
}

function validateBrowserExtension(directory) {
  if (!realDirectoryIfPresent(directory, "release browser-extension namespace")) return;
  let visited = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > 512) throw new Error("release browser-extension namespace contains too many entries; state was kept for inspection");
      if (entry.isDirectory()) { walk(join(current, entry.name)); continue; }
      if (!entry.isFile()) throw new Error("release browser-extension namespace contains an unexpected entry; state was kept for inspection");
    }
  };
  walk(directory);
}

function validateLegacyReleaseTasks(directory) {
  if (!realDirectoryIfPresent(directory, "legacy release-task namespace")) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LEGACY_RELEASE_TASK.test(entry.name)) {
      throw new Error("legacy release-task namespace contains an unexpected entry; state was kept for inspection");
    }
  }
}

function validateNamedChildren(directory, label, patterns, kind) {
  if (!realDirectoryIfPresent(directory, `${label} namespace`)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const rightType = kind === "file" ? entry.isFile() : entry.isDirectory();
    if (!rightType || !patterns.some((pattern) => pattern.test(entry.name))) {
      throw new Error(`${label} namespace contains an unexpected entry; state was kept for inspection`);
    }
  }
}

function realDirectoryIfPresent(directory, label) {
  const info = inspectPathIfPresentSync(directory, label);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory before state removal`);
  return true;
}
