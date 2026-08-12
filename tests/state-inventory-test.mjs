import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeStateJobs, activeStateLocks, knownProfileStates, knownWorkerNames } from "../src/local/state-inventory.mjs";
import { pruneRetiredManagedJobDirectories } from "../src/local/managed-job-directory-generation.mjs";
import { acquireDaemonLock, acquireStartupLock, loadState, saveState } from "../src/local/state.mjs";
import { withOwnerStateLock } from "../src/local/owner-state-lock.mjs";
import { acquireJobCapacityLock, acquireJobTransitionLock, acquireRecoveryLock } from "../src/local/managed-job-lock.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-inventory-root-"));
const workspace = await mkdtemp(join(tmpdir(), "mbm-state-inventory-workspace-"));
try {
  assert.deepEqual(knownWorkerNames(stateRoot), []);
  assert.deepEqual(knownProfileStates(stateRoot), []);
  assert.deepEqual(activeStateJobs(stateRoot), []);
  assert.deepEqual(activeStateLocks(stateRoot), []);
  if (process.platform !== "win32") {
    const profilesLink = join(stateRoot, "profiles");
    await symlink(workspace, profilesLink);
    assert.throws(() => knownWorkerNames(stateRoot), /state profile directory must be a real directory/,
      "destructive state inventory followed a symbolic-link profiles directory");
    await rm(profilesLink, { force: true });
  }

  const state = loadState(workspace, { stateDir: stateRoot });
  const profilesRoot = join(stateRoot, "profiles");
  const unexpectedProfile = join(profilesRoot, "not-a-profile");
  await mkdir(unexpectedProfile, { recursive: true });
  assert.throws(() => knownWorkerNames(stateRoot), /state profile directory contains an unexpected entry/,
    "destructive state inventory ignored an unknown profile namespace entry");
  await rm(unexpectedProfile, { recursive: true, force: true });
  const wrongTypeProfile = join(profilesRoot, "f".repeat(24));
  await writeFile(wrongTypeProfile, "not-a-profile-directory\n", { mode: 0o600 });
  assert.throws(() => knownWorkerNames(stateRoot), /state profile directory contains an unexpected entry/,
    "destructive state inventory ignored a wrong-type reserved profile entry");
  await rm(wrongTypeProfile, { force: true });
  state.worker.name = "machine-bridge-test";
  state.worker.previousNames = ["machine-bridge-previous"];
  saveState(state);
  assert.deepEqual(knownWorkerNames(stateRoot), ["machine-bridge-test", "machine-bridge-previous"]);
  if (process.platform !== "win32") {
    const stateAlias = join(state.paths.profileDir, "state.json.alias");
    try {
      await link(state.paths.statePath, stateAlias);
      assert.throws(() => knownWorkerNames(stateRoot), /cannot determine deployed Worker/,
        "Worker deletion inventory accepted a multiply-linked state file");
      assert((await readFile(state.paths.statePath, "utf8")).includes("machine-bridge-test")
        && (await readFile(stateAlias, "utf8")).includes("machine-bridge-test"),
      "state inventory hard-link rejection modified destructive-control evidence");
    } finally {
      await rm(stateAlias, { force: true });
    }
  }
  const profiles = knownProfileStates(stateRoot);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].workspace.path, state.workspace.path);
  const canonicalStateRoot = await realpath(stateRoot);
  assert.equal(profiles[0].paths.stateRoot, canonicalStateRoot);
  assert.equal(profiles[0].paths.profileDir, join(canonicalStateRoot, "profiles", state.workspace.hash));

  const retiredJobRoot = join(state.paths.profileDir, "jobs");
  await mkdir(retiredJobRoot, { recursive: true, mode: 0o700 });
  const retiredSource = join(retiredJobRoot, `job_${"R".repeat(24)}`);
  await mkdir(retiredSource, { mode: 0o700 });
  const retiredInfo = await lstat(retiredSource, { bigint: true });
  const retiredName = `retired_job_${"Q".repeat(24)}_d${retiredInfo.dev}_i${retiredInfo.ino}`;
  const retiredPath = join(retiredJobRoot, retiredName);
  await rename(retiredSource, retiredPath);
  const retiredState = activeStateJobs(stateRoot);
  assert(retiredState.length === 1 && retiredState[0].state_kind === "retired_managed_job"
    && retiredState[0].status === "retired_cleanup_pending" && !("job_id" in retiredState[0]),
  "state inventory did not expose exactly one privacy-bounded crash-left retired managed-job generation");
  pruneRetiredManagedJobDirectories(retiredJobRoot, { warn() {} });
  assert.equal(await lstat(retiredPath).then(() => true, () => false), false,
    "state maintenance did not reclaim a generation-verified retired managed-job directory");

  const corruptRetiredName = `retired_job_${"Z".repeat(24)}_d0_i0`;
  const corruptRetiredPath = join(retiredJobRoot, corruptRetiredName);
  await mkdir(corruptRetiredPath, { mode: 0o700 });
  const corruptRetiredState = activeStateJobs(stateRoot);
  assert(corruptRetiredState.length === 1 && corruptRetiredState[0].state_kind === "retired_managed_job"
    && corruptRetiredState[0].status === "unreadable" && corruptRetiredState[0].error_class === "integrity_error"
    && !("job_id" in corruptRetiredState[0]),
  "state inventory did not fail closed with a privacy-bounded projection for inconsistent retired state");
  pruneRetiredManagedJobDirectories(retiredJobRoot, { warn() {} });
  assert.equal(await lstat(corruptRetiredPath).then(() => true, () => false), true,
    "state maintenance removed an inconsistent retired managed-job generation");
  await rm(corruptRetiredPath, { recursive: true, force: true });

  state.worker.name = "-invalid";
  saveState(state);
  assert.throws(() => knownWorkerNames(stateRoot), /invalid Worker name/);
  state.worker.name = "machine-bridge-test";
  state.worker.previousNames = ["machine-bridge-previous"];
  saveState(state);

  state.worker.previousNames = ["-invalid"];
  saveState(state);
  assert.throws(() => knownWorkerNames(stateRoot), /invalid Worker name/);
  state.worker.previousNames = ["machine-bridge-previous"];
  saveState(state);

  const daemonLock = acquireDaemonLock(state, { mode: "foreground", version: "0.17.0" });
  assert.equal(daemonLock.acquired, true);
  try {
    const locks = activeStateLocks(stateRoot);
    assert.equal(locks.length, 1);
    assert.equal(locks[0].kind, "daemon");
    assert.equal(locks[0].pid, process.pid);

    await writeFile(state.paths.statePath, "{invalid", "utf8");
    const recovered = knownProfileStates(stateRoot);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].workspace.path, state.workspace.path);
    assert.throws(() => knownWorkerNames(stateRoot), /cannot determine deployed Worker/);
  } finally {
    daemonLock.release();
  }
  saveState(state);
  assert.deepEqual(activeStateLocks(stateRoot), []);

  const startupLock = acquireStartupLock(state, { operation: "inventory-test" });
  assert.equal(startupLock.acquired, true);
  try {
    const locks = activeStateLocks(stateRoot);
    assert.equal(locks.length, 1);
    assert.equal(locks[0].kind, "startup");
  } finally {
    startupLock.release();
  }

  await writeFile(join(state.paths.profileDir, "daemon.lock"), "{invalid", "utf8");
  assert.throws(() => knownProfileStates(stateRoot), /cannot inspect daemon lock/);
  await rm(join(state.paths.profileDir, "daemon.lock"), { force: true });

  let releaseOwnerLock;
  let ownerLockEntered;
  const ownerLockReady = new Promise((resolve) => { ownerLockEntered = resolve; });
  const heldOwnerLock = withOwnerStateLock(state.paths.profileDir, async () => {
    ownerLockEntered();
    await new Promise((resolve) => { releaseOwnerLock = resolve; });
  }, { purpose: "security-audit", fileName: "security-audit.lock", label: "security audit" });
  await ownerLockReady;
  const ownerLocks = activeStateLocks(stateRoot);
  assert.equal(ownerLocks.length, 1);
  assert.equal(ownerLocks[0].kind, "security-audit");
  assert.equal(ownerLocks[0].pid, process.pid);
  releaseOwnerLock();
  await heldOwnerLock;
  assert.deepEqual(activeStateLocks(stateRoot), []);

  const toolchains = join(stateRoot, "toolchains");
  await mkdir(toolchains, { recursive: true });
  let releaseToolchainLock;
  let toolchainLockEntered;
  const toolchainLockReady = new Promise((resolve) => { toolchainLockEntered = resolve; });
  const heldToolchainLock = withOwnerStateLock(toolchains, async () => {
    toolchainLockEntered();
    await new Promise((resolve) => { releaseToolchainLock = resolve; });
  }, { purpose: "wrangler-toolchain", fileName: "wrangler-toolchain.lock", label: "Wrangler toolchain" });
  await toolchainLockReady;
  const toolchainLocks = activeStateLocks(stateRoot);
  assert.equal(toolchainLocks.length, 1);
  assert.equal(toolchainLocks[0].kind, "toolchain");
  assert.equal(toolchainLocks[0].pid, process.pid);
  releaseToolchainLock();
  await heldToolchainLock;
  assert.deepEqual(activeStateLocks(stateRoot), []);

  const toolchainLockPath = join(toolchains, "wrangler-toolchain.lock");
  await writeFile(toolchainLockPath, "{invalid\n", { mode: 0o600 });
  const malformedToolchainLocks = activeStateLocks(stateRoot);
  assert.equal(malformedToolchainLocks.length, 1);
  assert.equal(malformedToolchainLocks[0].kind, "toolchain");
  assert.equal(malformedToolchainLocks[0].pid, null);
  assert.equal(malformedToolchainLocks[0].reason, "invalid_or_unreadable_lock");
  await rm(toolchainLockPath, { force: true });

  const primaryLockFailure = new Error("synthetic owner-state operation failure");
  let aggregateLockFailure;
  try {
    await withOwnerStateLock(state.paths.profileDir, async () => {
      await writeFile(join(state.paths.profileDir, "fault-injection.lock"), JSON.stringify({
        pid: process.pid,
        token: "0".repeat(32),
        purpose: "fault-injection",
        startedAt: new Date().toISOString(),
        processStartedAt: new Date().toISOString(),
      }) + "\n", "utf8");
      throw primaryLockFailure;
    }, { purpose: "fault-injection", fileName: "fault-injection.lock", label: "fault injection" });
  } catch (error) {
    aggregateLockFailure = error;
  }
  assert(aggregateLockFailure instanceof AggregateError
    && aggregateLockFailure.errors?.length === 2
    && aggregateLockFailure.errors[0] === primaryLockFailure
    && /lock changed before release/.test(String(aggregateLockFailure.errors[1]?.message || "")),
  "owner-state lock cleanup failure replaced the primary operation failure");
  await rm(join(state.paths.profileDir, "fault-injection.lock"), { force: true });

  const callbackOnlyFailure = new Error("synthetic callback-only owner-state failure");
  let observedCallbackOnlyFailure;
  try {
    await withOwnerStateLock(state.paths.profileDir, async () => { throw callbackOnlyFailure; }, {
      purpose: "callback-only", fileName: "callback-only.lock", label: "callback only",
    });
  } catch (error) { observedCallbackOnlyFailure = error; }
  assert.equal(observedCallbackOnlyFailure, callbackOnlyFailure, "successful lock cleanup replaced the primary callback failure");

  let releaseOnlyFailure;
  try {
    await withOwnerStateLock(state.paths.profileDir, async () => {
      await writeFile(join(state.paths.profileDir, "release-only.lock"), JSON.stringify({
        pid: process.pid, token: "f".repeat(32), purpose: "release-only",
        startedAt: new Date().toISOString(), processStartedAt: new Date().toISOString(),
      }) + "\n", "utf8");
      return "committed";
    }, { purpose: "release-only", fileName: "release-only.lock", label: "release only" });
  } catch (error) { releaseOnlyFailure = error; }
  assert(/lock changed before release/.test(String(releaseOnlyFailure?.message || "")),
    "owner-state lock ignored release failure after a successful callback");
  await rm(join(state.paths.profileDir, "release-only.lock"), { force: true });

  await writeFile(join(state.paths.profileDir, "malformed-owner.lock"), "{invalid\n", "utf8");
  let malformedOwnerFailure;
  try {
    await withOwnerStateLock(state.paths.profileDir, async () => {}, {
      purpose: "malformed-owner", fileName: "malformed-owner.lock", label: "malformed owner",
      timeoutMs: 50, pollMs: 5,
    });
  } catch (error) { malformedOwnerFailure = error; }
  assert(/lock is malformed/.test(String(malformedOwnerFailure?.message || "")),
    "owner-state lock treated malformed ownership metadata as recoverable absence");
  await rm(join(state.paths.profileDir, "malformed-owner.lock"), { force: true });

  for (const [name, owner] of [
    ["array", []],
    ["pid", { pid: 0, token: "a".repeat(32), purpose: "metadata-pid", startedAt: new Date().toISOString(), processStartedAt: new Date().toISOString() }],
    ["token", { pid: process.pid, token: "not-a-token", purpose: "metadata-token", startedAt: new Date().toISOString(), processStartedAt: new Date().toISOString() }],
    ["purpose", { pid: process.pid, token: "a".repeat(32), purpose: "wrong-purpose", startedAt: new Date().toISOString(), processStartedAt: new Date().toISOString() }],
    ["started", { pid: process.pid, token: "a".repeat(32), purpose: "metadata-started", startedAt: "invalid", processStartedAt: new Date().toISOString() }],
    ["process-started", { pid: process.pid, token: "a".repeat(32), purpose: "metadata-process-started", startedAt: new Date().toISOString(), processStartedAt: "invalid" }],
  ]) {
    const purpose = `metadata-${name}`;
    const fileName = `${purpose}.lock`;
    await writeFile(join(state.paths.profileDir, fileName), `${JSON.stringify(owner)}\n`, "utf8");
    let metadataFailure;
    try {
      await withOwnerStateLock(state.paths.profileDir, async () => {}, { purpose, fileName, label: purpose, timeoutMs: 25, pollMs: 2 });
    } catch (error) { metadataFailure = error; }
    assert(/lock is malformed/.test(String(metadataFailure?.message || "")), `owner-state lock accepted malformed ${name} metadata`);
    await rm(join(state.paths.profileDir, fileName), { force: true });
  }

  const oversizedOwnerLock = join(state.paths.profileDir, "oversized-owner.lock");
  await writeFile(oversizedOwnerLock, "x".repeat(8 * 1024 + 1), "utf8");
  await assert.rejects(
    () => withOwnerStateLock(state.paths.profileDir, async () => {}, { purpose: "oversized-owner", fileName: "oversized-owner.lock", label: "oversized owner" }),
    /file exceeds 8192 bytes/,
    "owner-state lock converted a bounded-read/storage failure into malformed metadata",
  );
  await rm(oversizedOwnerLock, { force: true });

  await withOwnerStateLock(state.paths.profileDir, async () => {
    let busyFailure;
    try {
      await withOwnerStateLock(state.paths.profileDir, async () => {}, {
        purpose: "busy-owner", fileName: "busy-owner.lock", label: "busy owner", timeoutMs: 20, pollMs: 2,
      });
    } catch (error) { busyFailure = error; }
    assert(/state is busy \(pid /.test(String(busyFailure?.message || "")),
      "owner-state lock did not wait for and time out on a live owner");
  }, { purpose: "busy-owner", fileName: "busy-owner.lock", label: "busy owner" });

  const hardLinkedOwnerPath = join(state.paths.profileDir, "hard-linked-owner.lock");
  const hardLinkedOwnerAlias = join(state.paths.profileDir, "hard-linked-owner.alias");
  await writeFile(hardLinkedOwnerPath, `${JSON.stringify({
    pid: 2_147_483_647,
    token: "c".repeat(32),
    purpose: "hard-linked-owner",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    processStartedAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      await link(hardLinkedOwnerPath, hardLinkedOwnerAlias);
      await assert.rejects(
        () => withOwnerStateLock(state.paths.profileDir, async () => "should-not-run", {
          purpose: "hard-linked-owner", fileName: "hard-linked-owner.lock", label: "hard-linked owner", maxAgeMs: 1_000,
        }),
        /multiple hard links/,
        "owner-state acquisition treated a multiply-linked ownership file as reclaimable state",
      );
      assert((await readFile(hardLinkedOwnerPath, "utf8")).includes('"hard-linked-owner"')
        && (await readFile(hardLinkedOwnerAlias, "utf8")).includes('"hard-linked-owner"'),
      "owner-state hard-link rejection modified ownership evidence");
    } finally {
      await rm(hardLinkedOwnerAlias, { force: true });
    }
  }
  await rm(hardLinkedOwnerPath, { force: true });

  const staleOwnerPath = join(state.paths.profileDir, "stale-owner.lock");
  await writeFile(staleOwnerPath, `${JSON.stringify({
    pid: 2_147_483_647,
    token: "b".repeat(32),
    purpose: "stale-owner",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    processStartedAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`, "utf8");
  const reclaimed = await withOwnerStateLock(state.paths.profileDir, async () => "reclaimed", {
    purpose: "stale-owner", fileName: "stale-owner.lock", label: "stale owner", maxAgeMs: 1_000,
  });
  assert.equal(reclaimed, "reclaimed", "owner-state lock did not reclaim a lock whose process is no longer running");

  let releaseReadFailure;
  const releaseThrowPath = join(state.paths.profileDir, "release-throw.lock");
  try {
    await withOwnerStateLock(state.paths.profileDir, async () => {
      await rm(releaseThrowPath, { force: true });
      await mkdir(releaseThrowPath);
      return "committed";
    }, { purpose: "release-throw", fileName: "release-throw.lock", label: "release throw" });
  } catch (error) { releaseReadFailure = error; }
  assert(/lock release failed/.test(String(releaseReadFailure?.message || ""))
    && /not a regular file/.test(String(releaseReadFailure?.cause?.message || "")),
    "owner-state lock did not fail closed with causal evidence when the owned file was replaced by a directory");
  await rm(releaseThrowPath, { recursive: true, force: true });

  assert.rejects(() => withOwnerStateLock(state.paths.profileDir, null), /requires a callback/);
  assert.rejects(() => withOwnerStateLock("", async () => {}), /root is missing/);
  assert.rejects(() => withOwnerStateLock(state.paths.profileDir, async () => {}, { fileName: "../invalid" }), /filename is invalid/);
  const fallbackLockResult = await withOwnerStateLock(state.paths.profileDir, async () => "fallback", {
    purpose: "", label: "\n", timeoutMs: 0, pollMs: 0, maxAgeMs: Number.NaN,
  });
  assert.equal(fallbackLockResult, "fallback", "owner-state lock option fallbacks changed normal acquisition");

  const stagedJobId = `job_${"J".repeat(24)}`;
  const jobRoot = join(state.paths.profileDir, "jobs");
  const stagedJobDir = join(jobRoot, stagedJobId);
  await mkdir(stagedJobDir, { recursive: true, mode: 0o700 });
  const capacity = acquireJobCapacityLock(jobRoot);
  assert(capacity, "managed-job capacity lock could not be acquired");
  const capacityLocks = activeStateLocks(stateRoot);
  assert.equal(capacityLocks.length, 1);
  assert.equal(capacityLocks[0].kind, "job-capacity");
  assert.equal(capacityLocks[0].pid, process.pid);
  capacity.release();
  assert.deepEqual(activeStateLocks(stateRoot), []);
  const transition = acquireJobTransitionLock(stagedJobDir);
  assert(transition, "managed-job transition lock could not be acquired");
  const nestedLocks = activeStateLocks(stateRoot);
  assert.equal(nestedLocks.length, 1);
  assert.equal(nestedLocks[0].kind, "job-transition");
  assert.equal(nestedLocks[0].job_id, stagedJobId);
  transition.release();
  assert.deepEqual(activeStateLocks(stateRoot), []);

  const oversizedRecoveryLock = join(stagedJobDir, "recovery.lock");
  await writeFile(oversizedRecoveryLock, "x".repeat(1025), "utf8");
  const oldRecoveryLock = new Date(Date.now() - 120_000);
  await utimes(oversizedRecoveryLock, oldRecoveryLock, oldRecoveryLock);
  assert.throws(
    () => acquireRecoveryLock(stagedJobDir),
    /file exceeds 1024 bytes/,
    "managed-job recovery lock reclaimed an old bounded-read failure as malformed metadata",
  );
  assert((await readFileSafe(oversizedRecoveryLock)).length === 1025, "managed-job recovery lock read failure removed the existing lock");
  await rm(oversizedRecoveryLock, { force: true });

  assert.deepEqual(activeStateJobs(stateRoot), []);
  console.log("state inventory test ok");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

async function readFileSafe(file) { return await (await import("node:fs/promises")).readFile(file); }
