import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateRuntimeContainer, createCandidateRuntimePrefix, isNonBlockingCandidateRuntimeCleanupError, pruneInactiveCandidateRuntimes } from "../scripts/candidate-runtime-store.mjs";

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
const inactiveCanonical = realpathSync(inactive);

const removed = pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: active });
assert(removed.length === 1 && removed[0] === inactiveCanonical, "inactive candidate runtime pruning removed the wrong entries");
assert(existsSync(active), "active candidate runtime was removed");
assert(existsSync(join(container, "foreign-directory")), "foreign runtime-container data was removed");
assert(existsSync(candidateSymlink), "candidate-looking symbolic link was followed or removed");
expectThrow(() => pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: outside }), "outside the runtime container");

const linkedState = mkdtempSync(join(tmpdir(), "mbm-candidate-linked-state-"));
const linkedOutside = mkdtempSync(join(tmpdir(), "mbm-candidate-linked-outside-"));
try {
  mkdirSync(join(linkedState, "release-channels"), { recursive: true });
  mkdirSync(join(linkedOutside, "v3.0.0-beta.1-aaaaaaaaaaaa-444444444444"));
  symlinkSync(linkedOutside, join(linkedState, "release-channels", "runtimes"), "dir");
  expectThrow(
    () => pruneInactiveCandidateRuntimes({
      stateRoot: linkedState,
      activePrefix: join(linkedState, "release-channels", "runtimes", "v3.0.0-beta.2-bbbbbbbbbbbb-555555555555"),
    }),
    "runtime container must be a real directory",
  );
  assert(existsSync(join(linkedOutside, "v3.0.0-beta.1-aaaaaaaaaaaa-444444444444")),
    "symlinked runtime container allowed deletion outside the state root");
} finally {
  rmSync(linkedState, { recursive: true, force: true });
  rmSync(linkedOutside, { recursive: true, force: true });
}

const linkedReleaseState = mkdtempSync(join(tmpdir(), "mbm-candidate-linked-release-state-"));
const linkedReleaseOutside = mkdtempSync(join(tmpdir(), "mbm-candidate-linked-release-outside-"));
try {
  mkdirSync(join(linkedReleaseOutside, "runtimes", "v3.0.0-beta.1-cccccccccccc-666666666666"), { recursive: true });
  symlinkSync(linkedReleaseOutside, join(linkedReleaseState, "release-channels"), "dir");
  expectThrow(
    () => pruneInactiveCandidateRuntimes({
      stateRoot: linkedReleaseState,
      activePrefix: join(linkedReleaseState, "release-channels", "runtimes", "v3.0.0-beta.2-dddddddddddd-777777777777"),
    }),
    "release-channel directory must be a real directory",
  );
  assert(existsSync(join(linkedReleaseOutside, "runtimes", "v3.0.0-beta.1-cccccccccccc-666666666666")),
    "symlinked release-channel directory allowed deletion outside the state root");
} finally {
  rmSync(linkedReleaseState, { recursive: true, force: true });
  rmSync(linkedReleaseOutside, { recursive: true, force: true });
}
assert(isNonBlockingCandidateRuntimeCleanupError(Object.assign(new Error("permission denied"), { code: "EACCES" })), "candidate runtime permission cleanup failure was blocking");
assert(isNonBlockingCandidateRuntimeCleanupError(Object.assign(new Error("quota exceeded"), { code: "EDQUOT" })), "candidate runtime quota cleanup failure was blocking");
assert(!isNonBlockingCandidateRuntimeCleanupError(new TypeError("programming defect")), "candidate runtime programming defect was incorrectly downgraded");
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
