import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeStateJobs, activeStateLocks, knownProfileStates, knownWorkerNames } from "../src/local/state-inventory.mjs";
import { acquireDaemonLock, acquireStartupLock, loadState, saveState } from "../src/local/state.mjs";

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
  saveState(state);
  assert.deepEqual(knownWorkerNames(stateRoot), ["machine-bridge-test"]);
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

  assert.deepEqual(activeStateJobs(stateRoot), []);
  console.log("state inventory test ok");
} finally {
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
