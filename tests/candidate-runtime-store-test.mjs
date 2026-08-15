import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateRuntimeContainer, createCandidateRuntimePrefix, isNonBlockingCandidateRuntimeCleanupError, pruneInactiveCandidateRuntimes } from "../scripts/candidate-runtime-store.mjs";
import { publishReleaseBrowserExtension } from "../scripts/release-browser-extension-store.mjs";
import { browserExtensionPathForRuntime, releaseBrowserExtensionPath } from "../src/local/browser-extension-path.mjs";
import { withReleaseRuntimeLock } from "../src/local/release-runtime-lock.mjs";
import { validateOwnedStateNamespaces } from "../src/local/state-root-owned-namespaces.mjs";

const stateRoot = mkdtempSync(join(tmpdir(), "mbm-candidate-runtime-"));
const container = candidateRuntimeContainer(stateRoot);
mkdirSync(container, { recursive: true });
let outside = "";
try {
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
  outside = mkdtempSync(join(tmpdir(), "mbm-candidate-outside-"));
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

  testStableBrowserExtensionPublication(stateRoot, active);

  const controlRoot = mkdtempSync(join(tmpdir(), "mbm-release-runtime-control-"));
  let releaseFirst;
  let firstEntered;
  const firstReady = new Promise((resolvePromise) => { firstEntered = resolvePromise; });
  const first = withReleaseRuntimeLock(stateRoot, async () => {
    firstEntered();
    await new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
  }, { controlRoot, timeoutMs: 1_000 });
  await firstReady;
  await assertRejects(
    withReleaseRuntimeLock(stateRoot, async () => {}, { controlRoot, timeoutMs: 40 }),
    "release runtime state is busy",
  );
  releaseFirst();
  await first;
  let reentered = false;
  await withReleaseRuntimeLock(stateRoot, async () => { reentered = true; }, { controlRoot, timeoutMs: 1_000 });
  assert(reentered, "release-runtime lock remained unavailable after the previous owner released it");
  rmSync(controlRoot, { recursive: true, force: true });
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
  if (outside) rmSync(outside, { recursive: true, force: true });
}

console.log("candidate runtime store test ok");

function testStableBrowserExtensionPublication(stateRoot, activeRuntime) {
  const packageDirectory = join(activeRuntime, "lib", "node_modules", "machine-bridge-mcp");
  mkdirSync(packageDirectory, { recursive: true });
  const stablePath = releaseBrowserExtensionPath(stateRoot);
  assert(browserExtensionPathForRuntime({ stateRoot, packageDirectory }) === stablePath,
    "versioned candidate runtime did not resolve the stable browser extension path");
  const checkout = mkdtempSync(join(tmpdir(), "mbm-browser-extension-checkout-"));
  try {
    assert(browserExtensionPathForRuntime({ stateRoot, packageDirectory: checkout }) === join(checkout, "browser-extension"),
      "ordinary package runtime was incorrectly redirected to release browser-extension state");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }

  const sourceOne = mkdtempSync(join(tmpdir(), "mbm-browser-extension-v1-"));
  const sourceTwo = mkdtempSync(join(tmpdir(), "mbm-browser-extension-v2-"));
  try {
    writeFileSync(join(sourceOne, "manifest.json"), JSON.stringify({ version: "3.0.0", version_name: "3.0.0-beta.1" }));
    writeFileSync(join(sourceOne, "service-worker.js"), "old-worker\n");
    writeFileSync(join(sourceOne, "obsolete.js"), "obsolete\n");
    const first = publishReleaseBrowserExtension({
      stateRoot,
      sourceDirectory: sourceOne,
      expectedVersion: "3.0.0-beta.1",
    });
    assert(first.path === stablePath && first.version === "3.0.0-beta.1", "initial stable browser extension publication returned the wrong identity");
    assert(readFileSync(join(stablePath, "service-worker.js"), "utf8") === "old-worker\n", "initial stable browser extension bytes were not published");

    writeFileSync(join(sourceTwo, "manifest.json"), JSON.stringify({ version: "3.0.0", version_name: "3.0.0-beta.2" }));
    writeFileSync(join(sourceTwo, "service-worker.js"), "new-worker\n");
    writeFileSync(join(sourceTwo, "added.js"), "added\n");
    let manifestCommittedLast = false;
    const second = publishReleaseBrowserExtension({
      stateRoot,
      sourceDirectory: sourceTwo,
      expectedVersion: "3.0.0-beta.2",
      beforeManifestCommit: ({ destination }) => {
        const previousManifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
        manifestCommittedLast = previousManifest.version_name === "3.0.0-beta.1"
          && readFileSync(join(destination, "service-worker.js"), "utf8") === "new-worker\n"
          && !existsSync(join(destination, "obsolete.js"));
      },
    });
    assert(second.path === first.path && manifestCommittedLast, "stable browser extension did not preserve one path with manifest-last commit ordering");
    assert(JSON.parse(readFileSync(join(stablePath, "manifest.json"), "utf8")).version_name === "3.0.0-beta.2",
      "stable browser extension manifest did not converge on the new candidate");
    assert(readFileSync(join(stablePath, "added.js"), "utf8") === "added\n", "stable browser extension omitted a new candidate file");
    expectThrow(() => publishReleaseBrowserExtension({ stateRoot, sourceDirectory: sourceTwo, expectedVersion: "3.0.0-beta.3" }), "does not match");

    const linkedSource = mkdtempSync(join(tmpdir(), "mbm-browser-extension-linked-"));
    try {
      writeFileSync(join(linkedSource, "manifest.json"), JSON.stringify({ version_name: "3.0.0-beta.2" }));
      symlinkSync(join(sourceTwo, "service-worker.js"), join(linkedSource, "service-worker.js"));
      expectThrow(() => publishReleaseBrowserExtension({ stateRoot, sourceDirectory: linkedSource }), "must not contain symbolic links");
    } finally {
      rmSync(linkedSource, { recursive: true, force: true });
    }

    const retirementState = mkdtempSync(join(tmpdir(), "mbm-browser-extension-retirement-"));
    const retirementRuntime = createCandidateRuntimePrefix({
      stateRoot: retirementState,
      version: "3.0.0-beta.2",
      shasum: "c".repeat(40),
      random: () => "8".repeat(12),
    });
    try {
      mkdirSync(retirementRuntime, { recursive: true });
      publishReleaseBrowserExtension({ stateRoot: retirementState, sourceDirectory: sourceTwo, expectedVersion: "3.0.0-beta.2" });
      validateOwnedStateNamespaces(retirementState);
      const foreignTarget = join(retirementState, "foreign-target.js");
      writeFileSync(foreignTarget, "foreign\n");
      symlinkSync(foreignTarget, join(releaseBrowserExtensionPath(retirementState), "linked.js"));
      expectThrow(() => validateOwnedStateNamespaces(retirementState), "unexpected entry");
    } finally {
      rmSync(retirementState, { recursive: true, force: true });
    }
  } finally {
    rmSync(sourceOne, { recursive: true, force: true });
    rmSync(sourceTwo, { recursive: true, force: true });
  }
}

function expectThrow(callback, expected) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}

async function assertRejects(promise, expected) {
  try { await promise; }
  catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
