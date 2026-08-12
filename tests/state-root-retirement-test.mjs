import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadState, removeStateRoot } from "../src/local/state.mjs";
import {
  inspectStateRootGeneration, removeStateRootGenerationIfCurrent, retiredStateRootDirectories, stateRootRetirementPath,
} from "../src/local/state-root-retirement.mjs";

const roots = [];
try {
  assert.deepEqual(retiredStateRootDirectories(join(tmpdir(), "mbm-state-retirement-missing-parent", "root")), [],
    "missing state-root parent was not treated as having no retired generations");
  assert.throws(() => stateRootRetirementPath(join(tmpdir(), "root"), { dev: 0n, ino: 0n }, "bad"), /nonce is invalid/,
    "invalid state-root retirement nonce was accepted");
  assert.equal(removeStateRootGenerationIfCurrent(join(tmpdir(), "mbm-state-retirement-missing-root"), { dev: 0n, ino: 0n }, () => {}), false,
    "missing current state root was not treated as an absent generation");

  const normal = await validStateRoot("normal");
  assert.equal(removeStateRoot(normal.root), true, "generation-bound state-root removal did not delete a valid current root");
  assert.equal(existsSync(normal.root), false, "valid state root remained after removal");

  if (process.platform !== "win32") {
    const linkedProfiles = await validStateRoot("linked-profiles");
    rmSync(join(linkedProfiles.root, "profiles"), { recursive: true, force: true });
    symlinkSync(linkedProfiles.workspace, join(linkedProfiles.root, "profiles"));
    assert.throws(() => removeStateRoot(linkedProfiles.root), /state-root profiles must be a real directory/,
      "state-root removal followed a symbolic-link profiles directory during validation");
    assert.equal(existsSync(linkedProfiles.workspace), true, "state-root validation modified the symbolic-link profiles target");
  }

  const crash = await validStateRoot("crash");
  const crashIdentity = inspectStateRootGeneration(crash.root);
  const crashRetired = stateRootRetirementPath(crash.root, crashIdentity, "R".repeat(24));
  renameSync(crash.root, crashRetired);
  const crashInventory = retiredStateRootDirectories(crash.root);
  assert(crashInventory.length === 1 && crashInventory[0].reclaimable === true,
    "crash-left retired state root was not recognized by its encoded filesystem generation");
  assert.equal(removeStateRoot(crash.root), false, "cleanup-only state-root retry claimed a current root was removed");
  assert.equal(existsSync(crashRetired), false, "cleanup-only state-root retry did not reclaim valid crash residue");

  const raced = await validStateRoot("race");
  const racedIdentity = inspectStateRootGeneration(raced.root);
  const replacementMarker = join(raced.root, "replacement.txt");
  const removed = removeStateRootGenerationIfCurrent(raced.root, racedIdentity, () => {
    throw new Error("replacement generation reached state-root verification");
  }, {
    renameSync(source, destination) {
      rmSync(source, { recursive: true, force: true });
      mkdirSync(source, { mode: 0o700 });
      writeFileSync(replacementMarker, "replacement generation\n", { mode: 0o600 });
      renameSync(source, destination);
    },
  });
  assert.equal(removed, false, "state-root retirement deleted a replacement pathname generation");
  const racedInventory = retiredStateRootDirectories(raced.root);
  assert(racedInventory.length === 1 && racedInventory[0].reclaimable === false
    && existsSync(join(racedInventory[0].path, "replacement.txt")) && !existsSync(raced.root),
  "state-root retirement did not preserve the replacement generation as quarantined evidence");
  assert.throws(() => removeStateRoot(raced.root), /retired state-root generation is inconsistent/,
    "replacement-generation quarantine did not block later destructive cleanup");

  const verifyFailure = await validStateRoot("verify-failure");
  const verifyFailureIdentity = inspectStateRootGeneration(verifyFailure.root);
  assert.throws(() => removeStateRootGenerationIfCurrent(verifyFailure.root, verifyFailureIdentity, () => {
    throw new Error("synthetic moved-root verification failure");
  }), /synthetic moved-root verification failure/,
  "state-root retirement swallowed a moved-root safety-verification failure");
  const verificationResidue = retiredStateRootDirectories(verifyFailure.root);
  assert(!existsSync(verifyFailure.root) && verificationResidue.length === 1 && verificationResidue[0].reclaimable === true,
    "failed moved-root verification did not retain a safely identifiable quarantine generation");
  assert.equal(removeStateRoot(verifyFailure.root), false,
    "later state-root cleanup claimed a current root while recovering verification-failure residue");
  assert.equal(retiredStateRootDirectories(verifyFailure.root).length, 0,
    "later state-root cleanup did not reclaim verified quarantine residue");

  const wrongType = await validStateRoot("wrong-type");
  rmSync(wrongType.root, { recursive: true, force: true });
  const wrongTypeRetired = stateRootRetirementPath(wrongType.root, { dev: 0n, ino: 0n }, "F".repeat(24));
  writeFileSync(wrongTypeRetired, "not-a-directory\n", { mode: 0o600 });
  assert.throws(() => removeStateRoot(wrongType.root), /retired state-root generation is inconsistent/,
    "wrong-type retired state-root residue did not block cleanup");
  assert.equal(existsSync(wrongTypeRetired), true, "wrong-type retired state-root residue was deleted");

  const corrupt = await validStateRoot("corrupt");
  rmSync(corrupt.root, { recursive: true, force: true });
  const corruptRetired = stateRootRetirementPath(corrupt.root, { dev: 0n, ino: 0n }, "Z".repeat(24));
  mkdirSync(corruptRetired, { mode: 0o700 });
  assert.throws(() => removeStateRoot(corrupt.root), /retired state-root generation is inconsistent/,
    "inconsistent retired state root did not block destructive cleanup");
  assert.equal(existsSync(corruptRetired), true, "inconsistent retired state root was deleted instead of retained for inspection");

  const malformed = await validStateRoot("malformed");
  rmSync(malformed.root, { recursive: true, force: true });
  const malformedRetired = join(dirname(malformed.root), `.${basename(malformed.root)}.retired_state_malformed`);
  mkdirSync(malformedRetired, { mode: 0o700 });
  assert.throws(() => removeStateRoot(malformed.root), /retired state-root generation is inconsistent/,
    "malformed reserved state-root retirement name was silently ignored");
  assert.equal(existsSync(malformedRetired), true, "malformed reserved state-root retirement residue was deleted");

  console.log("state root retirement test ok");
} finally {
  for (const path of roots) await rm(path, { recursive: true, force: true }).catch(() => {});
}

async function validStateRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `mbm-state-retirement-${label}-`));
  const workspace = await mkdtemp(join(tmpdir(), `mbm-state-retirement-workspace-${label}-`));
  roots.push(root, workspace);
  loadState(workspace, { stateDir: root });
  return { root, workspace };
}
