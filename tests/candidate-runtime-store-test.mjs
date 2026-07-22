import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateRuntimeContainer, createCandidateRuntimePrefix, pruneInactiveCandidateRuntimes } from "../scripts/candidate-runtime-store.mjs";

const stateRoot = mkdtempSync(join(tmpdir(), "mbm-candidate-runtime-"));
const container = candidateRuntimeContainer(stateRoot);
mkdirSync(container, { recursive: true });

const active = createCandidateRuntimePrefix({
  stateRoot,
  version: "3.0.0-beta.2",
  shasum: "a".repeat(40),
  random: () => "1".repeat(12),
});
const inactive = createCandidateRuntimePrefix({
  stateRoot,
  version: "3.0.0-beta.1",
  shasum: "b".repeat(40),
  random: () => "2".repeat(12),
});
mkdirSync(active, { recursive: true });
mkdirSync(inactive, { recursive: true });
writeFileSync(join(active, "active.txt"), "active\n");
writeFileSync(join(inactive, "inactive.txt"), "inactive\n");
mkdirSync(join(container, "foreign-directory"));
const outside = mkdtempSync(join(tmpdir(), "mbm-candidate-outside-"));
const candidateSymlink = join(container, "v3.0.0-beta.0-cccccccccccc-333333333333");
symlinkSync(outside, candidateSymlink);

const removed = pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: active });
assert(removed.length === 1 && removed[0] === inactive, "inactive candidate runtime pruning removed the wrong entries");
assert(existsSync(active), "active candidate runtime was removed");
assert(existsSync(join(container, "foreign-directory")), "foreign runtime-container data was removed");
assert(existsSync(candidateSymlink), "candidate-looking symbolic link was followed or removed");
expectThrow(() => pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: outside }), "outside the runtime container");
expectThrow(() => createCandidateRuntimePrefix({ stateRoot, version: "invalid", shasum: "a".repeat(40) }), "release version");
expectThrow(() => createCandidateRuntimePrefix({ stateRoot, version: "3.0.0-beta.2", shasum: "short" }), "SHA-1");

console.log("candidate runtime store test ok");

function expectThrow(callback, expected) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
