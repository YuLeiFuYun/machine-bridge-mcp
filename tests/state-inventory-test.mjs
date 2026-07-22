import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeStateJobs, activeStateLocks, knownProfileStates, knownWorkerNames } from "../src/local/state-inventory.mjs";
import { acquireDaemonLock, acquireStartupLock, loadState, saveState } from "../src/local/state.mjs";
import { withOwnerStateLock } from "../src/local/owner-state-lock.mjs";
import { acquireJobTransitionLock } from "../src/local/managed-job-lock.mjs";

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

  assert.deepEqual(activeStateJobs(stateRoot), []);
  console.log("state inventory test ok");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
