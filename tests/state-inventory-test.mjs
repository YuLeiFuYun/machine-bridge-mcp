import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeStateJobs, activeStateLocks, knownProfileStates, knownWorkerNames } from "../src/local/state-inventory.mjs";
import { acquireDaemonLock, acquireStartupLock, loadState, saveState } from "../src/local/state.mjs";
import { withOwnerStateLock } from "../src/local/owner-state-lock.mjs";
import { acquireJobTransitionLock, acquireRecoveryLock } from "../src/local/managed-job-lock.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-inventory-root-"));
const workspace = await mkdtemp(join(tmpdir(), "mbm-state-inventory-workspace-"));
try {
  assert.deepEqual(knownWorkerNames(stateRoot), []);
  assert.deepEqual(knownProfileStates(stateRoot), []);
  assert.deepEqual(activeStateJobs(stateRoot), []);
  assert.deepEqual(activeStateLocks(stateRoot), []);

  const state = loadState(workspace, { stateDir: stateRoot });
  await mkdir(join(stateRoot, "profiles", "not-a-profile"), { recursive: true });
  state.worker.name = "machine-bridge-test";
  state.worker.previousNames = ["machine-bridge-previous"];
  saveState(state);
  assert.deepEqual(knownWorkerNames(stateRoot), ["machine-bridge-test", "machine-bridge-previous"]);
  const profiles = knownProfileStates(stateRoot);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].workspace.path, state.workspace.path);
  const canonicalStateRoot = await realpath(stateRoot);
  assert.equal(profiles[0].paths.stateRoot, canonicalStateRoot);
  assert.equal(profiles[0].paths.profileDir, join(canonicalStateRoot, "profiles", state.workspace.hash));

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
  assert(/lock changed before release/.test(String(releaseReadFailure?.message || "")),
    "owner-state lock did not fail closed when the owned file was replaced by a directory");
  await rm(releaseThrowPath, { recursive: true, force: true });

  assert.rejects(() => withOwnerStateLock(state.paths.profileDir, null), /requires a callback/);
  assert.rejects(() => withOwnerStateLock("", async () => {}), /root is missing/);
  assert.rejects(() => withOwnerStateLock(state.paths.profileDir, async () => {}, { fileName: "../invalid" }), /filename is invalid/);
  const fallbackLockResult = await withOwnerStateLock(state.paths.profileDir, async () => "fallback", {
    purpose: "", label: "\n", timeoutMs: 0, pollMs: 0, maxAgeMs: Number.NaN,
  });
  assert.equal(fallbackLockResult, "fallback", "owner-state lock option fallbacks changed normal acquisition");

  const stagedJobId = `job_${"J".repeat(24)}`;
  const stagedJobDir = join(state.paths.profileDir, "jobs", stagedJobId);
  await mkdir(stagedJobDir, { recursive: true, mode: 0o700 });
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
