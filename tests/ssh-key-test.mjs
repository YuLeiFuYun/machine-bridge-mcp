import { chmod, copyFile, link, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKeyPair, inspectSshKeyPair, removeGeneratedSshKeyPair } from "../src/local/ssh-key.mjs";
import { generateRegisteredSshKey } from "../src/local/resource-operations.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-ssh-key-test-"));
try {
  const edPath = join(root, "operator-ed25519");
  const privateCommentMarker = "private-operator-label";
  const ed = await generateSshKeyPair({ privateKeyPath: edPath, comment: `${privateCommentMarker}\u202e` });
  assert(ed.created && ed.publicKeyType === "ssh-ed25519" && /^SHA256:[A-Za-z0-9+/=]+$/.test(ed.fingerprint), "Ed25519 generation failed");
  assert(!ed.fingerprint.includes(privateCommentMarker) && !ed.fingerprint.includes("\u202e"), "SSH fingerprint result exposed the public-key comment or display controls");
  const publicText = await readFile(`${edPath}.pub`, "utf8");
  assert(!publicText.includes("\u202e"), "SSH key comment retained a Unicode display control");
  const privateBytes = await readFile(edPath);
  assert(!JSON.stringify(ed).includes(privateBytes.toString("base64")), "SSH result exposed encoded private key bytes");
  if (process.platform !== "win32") assert(((await stat(edPath)).mode & 0o777) === 0o600, "Ed25519 private key mode is not 0600");
  if (process.platform !== "win32") await chmod(`${edPath}.pub`, 0o600);
  const reused = await generateSshKeyPair({ privateKeyPath: edPath, comment: "ignored-on-reuse" });
  assert(reused.created === false && reused.fingerprint === ed.fingerprint, "existing SSH key pair was not reused idempotently");
  if (process.platform !== "win32") assert(((await stat(`${edPath}.pub`)).mode & 0o777) === 0o644, "validated existing SSH public key was not normalized after validation");

  const rsaPath = join(root, "operator-rsa");
  const rsa = await generateSshKeyPair({ privateKeyPath: rsaPath, type: "rsa", bits: 2048, comment: "test-rsa" });
  assert(rsa.created && rsa.publicKeyType === "ssh-rsa", "RSA generation or argument ordering failed");

  await expectReject(() => generateSshKeyPair({ privateKeyPath: join(root, "unsupported-key"), type: "dsa" }),
    "SSH key type must be ed25519 or rsa");
  const invalidBitsParent = join(root, "invalid-rsa", "nested");
  await expectReject(() => generateSshKeyPair({ privateKeyPath: join(invalidBitsParent, "key"), type: "rsa", bits: "2048junk" }),
    "RSA bits must be 2048, 3072, or 4096");
  assert(!(await exists(invalidBitsParent)), "invalid RSA bits mutated the filesystem before request validation completed");
  await expectReject(() => generateSshKeyPair({ privateKeyPath: "" }), "private key path is required");
  await expectReject(() => removeGeneratedSshKeyPair({
    created: true, privateKeyPath: join(root, "missing-identity"), publicKeyPath: join(root, "missing-identity.pub"),
  }), "rollback identity is unavailable");

  for (const [name, code, message] of [
    ["install-eexist", "EEXIST", "refusing to replace existing SSH key file"],
    ["install-eio", "EIO", "synthetic install link I/O failure"],
  ]) {
    await expectReject(() => generateSshKeyPair({
      privateKeyPath: join(root, name),
      installOptions: {
        async link() {
          if (code === "EEXIST") throw Object.assign(new Error("synthetic install collision"), { code });
          throw Object.assign(new Error("synthetic install link I/O failure"), { code });
        },
      },
    }), message);
  }

  const otherPath = join(root, "other-ed25519");
  await generateSshKeyPair({ privateKeyPath: otherPath, comment: "other" });
  const mismatchedPath = join(root, "mismatched-ed25519");
  await copyFile(edPath, mismatchedPath);
  await copyFile(`${otherPath}.pub`, `${mismatchedPath}.pub`);
  if (process.platform !== "win32") {
    await chmod(mismatchedPath, 0o600);
    await chmod(`${mismatchedPath}.pub`, 0o600);
  }
  const mismatchedPrivateBefore = await readFile(mismatchedPath);
  const mismatchedPublicBefore = await readFile(`${mismatchedPath}.pub`);
  await expectReject(() => generateSshKeyPair({ privateKeyPath: mismatchedPath }), "does not match");
  assert(Buffer.compare(await readFile(mismatchedPath), mismatchedPrivateBefore) === 0
    && Buffer.compare(await readFile(`${mismatchedPath}.pub`), mismatchedPublicBefore) === 0,
  "invalid existing SSH pair was modified before validation");
  if (process.platform !== "win32") {
    assert(((await stat(mismatchedPath)).mode & 0o777) === 0o600
      && ((await stat(`${mismatchedPath}.pub`)).mode & 0o777) === 0o600,
    "invalid existing SSH pair permissions changed before validation");
  }
  await copyFile(`${otherPath}.pub`, `${edPath}.pub`);
  await expectReject(() => inspectSshKeyPair(edPath), "does not match");

  const incompletePath = join(root, "incomplete");
  await writeFile(incompletePath, "not-a-key", { mode: 0o600 });
  await expectReject(() => generateSshKeyPair({ privateKeyPath: incompletePath }), "incomplete");

  const invalidPairPath = join(root, "invalid-pair");
  await writeFile(invalidPairPath, "not-a-private-key", { mode: 0o600 });
  await writeFile(`${invalidPairPath}.pub`, "not-a-public-key", { mode: 0o600 });
  await expectReject(() => generateSshKeyPair({ privateKeyPath: invalidPairPath }), "cannot be used");
  if (process.platform !== "win32") assert(((await stat(`${invalidPairPath}.pub`)).mode & 0o777) === 0o600,
    "invalid existing public-key path was made world-readable before validation");

  const replacedDuringLinkPath = join(root, "replace-during-link");
  await expectReject(() => generateSshKeyPair({
    privateKeyPath: replacedDuringLinkPath,
    installOptions: {
      async link(source, target) {
        await link(source, target);
        await rm(target, { force: true });
        await writeFile(target, "replacement-during-link", { mode: 0o600 });
      },
    },
  }), "does not match the staging key");
  assert(await readFile(replacedDuringLinkPath, "utf8") === "replacement-during-link",
    "SSH install identity verification deleted a target replaced after link creation");
  assert(!await exists(`${replacedDuringLinkPath}.pub`),
    "SSH install continued to the public key after private target identity changed");

  const replacedStagingPath = join(root, "replace-staging-after-link");
  let stagingReplacement = null;
  await expectReject(() => generateSshKeyPair({
    privateKeyPath: replacedStagingPath,
    installOptions: {
      async link(source, target) {
        stagingReplacement = source;
        await link(source, target);
        await rm(source, { force: true });
        await writeFile(source, "replacement-staging-key", { mode: 0o600 });
      },
    },
  }), "SSH staging key changed after link");
  assert(!await exists(replacedStagingPath) && !await exists(`${replacedStagingPath}.pub`),
    "SSH install retained a target after the descriptor-pinned staging source changed");
  assert(stagingReplacement && await readFile(stagingReplacement, "utf8") === "replacement-staging-key",
    "SSH staging cleanup deleted a replacement that appeared after link creation");

  const installCleanupPath = join(root, "install-cleanup");
  let syntheticSourceUnlinkFailures = 0;
  await expectReject(() => generateSshKeyPair({
    privateKeyPath: installCleanupPath,
    installOptions: {
      async unlink() {
        syntheticSourceUnlinkFailures += 1;
        throw Object.assign(new Error("synthetic staging unlink failure"), { code: "EACCES" });
      },
    },
  }), "synthetic staging unlink failure");
  assert(syntheticSourceUnlinkFailures === 1 && !await exists(installCleanupPath) && !await exists(`${installCleanupPath}.pub`),
    "SSH install left a target behind after staging-source cleanup failed");

  const partialPath = join(root, "partial-install");
  let partialInstallCalls = 0;
  const partialFailure = await captureReject(() => generateSshKeyPair({
    privateKeyPath: partialPath,
    installNoReplace: async (source, target) => {
      partialInstallCalls += 1;
      if (partialInstallCalls === 1) { await link(source, target); await unlink(source); return; }
      await rm(partialPath, { force: true });
      await writeFile(partialPath, "replacement-private-key", { mode: 0o600 });
      throw Object.assign(new Error("synthetic public-key collision"), { code: "EEXIST" });
    },
  }));
  assert(partialFailure instanceof AggregateError && String(partialFailure.message).includes("rollback was incomplete"),
    "partial SSH install replacement did not preserve primary-plus-cleanup causality");
  assert(await readFile(partialPath, "utf8") === "replacement-private-key",
    "partial SSH install rollback deleted a replacement private-key path");

  const registrationState = { resources: {} };
  let lockReleased = 0;
  let saved = 0;
  const registered = await generateRegisteredSshKey({
    workspace: root, name: "registered-key", targetPath: join(root, "registered-key"), comment: "registered",
  }, {
    loadState: () => registrationState,
    acquireStartupLockWithWait: async () => ({ release() { lockReleased += 1; } }),
    generateSshKeyPair: async ({ privateKeyPath }) => ({
      created: true,
      privateKeyPath,
      publicKeyPath: `${privateKeyPath}.pub`,
      fingerprint: "SHA256:registered",
      publicKeyType: "ssh-ed25519",
      privateMode: "0600",
      publicMode: "0644",
    }),
    inspectResourceFile: (privateKeyPath) => ({ kind: "file", path: privateKeyPath, size: 100, mode: "0600" }),
    saveState: () => { saved += 1; },
  });
  assert(registered.registered === true && registrationState.resources["registered-key"].mode === "0600"
    && saved === 1 && lockReleased === 1, "generated SSH key was not atomically registered under the startup lock");

  const staleLockState = { resources: { stale: { path: join(root, "stale-resource") } } };
  const concurrentState = { resources: { concurrent: { path: join(root, "concurrent-resource") } } };
  let authorityLoads = 0;
  let savedAuthority = null;
  await generateRegisteredSshKey({
    workspace: root, name: "fresh-after-lock", targetPath: join(root, "fresh-after-lock"),
  }, {
    loadState: () => { authorityLoads += 1; return authorityLoads === 1 ? staleLockState : concurrentState; },
    acquireStartupLockWithWait: async (lockState) => {
      assert(lockState === staleLockState, "SSH registration did not use the initial state only for lock location");
      return { release() {} };
    },
    generateSshKeyPair: async ({ privateKeyPath }) => ({
      created: true, privateKeyPath, publicKeyPath: `${privateKeyPath}.pub`, fingerprint: "SHA256:fresh",
      publicKeyType: "ssh-ed25519", privateMode: "0600", publicMode: "0644",
    }),
    inspectResourceFile: (privateKeyPath) => ({ kind: "file", path: privateKeyPath, size: 100, mode: "0600" }),
    saveState: (state) => { savedAuthority = state; },
  });
  assert(authorityLoads === 2 && savedAuthority === concurrentState
    && Object.hasOwn(savedAuthority.resources, "concurrent")
    && Object.hasOwn(savedAuthority.resources, "fresh-after-lock")
    && !Object.hasOwn(savedAuthority.resources, "stale"),
  "SSH registration overwrote a state update committed while it waited for the startup lock");

  await expectReject(() => generateRegisteredSshKey({ workspace: root, name: "invalid-target", targetPath: "" }),
    "target path is required");
  let conflictReleased = 0;
  await expectReject(() => generateRegisteredSshKey({
    workspace: root, name: "conflict-key", targetPath: join(root, "new-target"),
  }, {
    loadState: () => ({ resources: { "conflict-key": { path: edPath } } }),
    acquireStartupLockWithWait: async () => ({ release() { conflictReleased += 1; } }),
  }), "different file");
  assert(conflictReleased === 1, "conflicting SSH resource did not release its startup lock");

  const fullRegistry = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    `resource-${index}`, { path: join(root, `resource-${index}`) },
  ]));
  await expectReject(() => generateRegisteredSshKey({
    workspace: root, name: "registry-overflow", targetPath: join(root, "registry-overflow"),
  }, {
    loadState: () => ({ resources: fullRegistry }),
    acquireStartupLockWithWait: async () => ({ release() {} }),
  }), "registry limit reached");

  const reusedRegistrationState = { resources: { "existing-key": { path: edPath } } };
  const reusedRegistration = await generateRegisteredSshKey({
    workspace: root, name: "existing-key", targetPath: edPath,
  }, {
    loadState: () => reusedRegistrationState,
    acquireStartupLockWithWait: async () => ({ release() {} }),
    generateSshKeyPair: async () => ({ ...ed, created: false, privateKeyPath: edPath, publicKeyPath: `${edPath}.pub` }),
    inspectResourceFile: () => ({ kind: "file", path: edPath, size: 100, mode: "0600" }),
    saveState: () => {},
  });
  assert(reusedRegistration.created === false, "existing SSH key registration was not idempotent");

  const rollbackCalls = [];
  const saveFailure = new Error("synthetic state write failure");
  await expectReject(() => generateRegisteredSshKey({
    workspace: root, name: "rollback-key", targetPath: join(root, "rollback-key"),
  }, {
    loadState: () => ({ resources: {} }),
    acquireStartupLockWithWait: async () => ({ release() {} }),
    generateSshKeyPair: async ({ privateKeyPath }) => ({
      created: true, privateKeyPath, publicKeyPath: `${privateKeyPath}.pub`, fingerprint: "SHA256:rollback",
      publicKeyType: "ssh-ed25519", privateMode: "0600", publicMode: "0644",
    }),
    inspectResourceFile: (privateKeyPath) => ({ kind: "file", path: privateKeyPath, size: 100, mode: "0600" }),
    saveState: () => { throw saveFailure; },
    removeGeneratedSshKeyPair: async (key) => { rollbackCalls.push(key.privateKeyPath, key.publicKeyPath); },
  }), "synthetic state write failure");
  assert(rollbackCalls.length === 2, "state-write failure did not remove both generated SSH key files");

  const incompleteRollbackCalls = [];
  await expectReject(() => generateRegisteredSshKey({
    workspace: root, name: "incomplete-rollback", targetPath: join(root, "incomplete-rollback"),
  }, {
    loadState: () => ({ resources: {} }),
    acquireStartupLockWithWait: async () => ({ release() {} }),
    generateSshKeyPair: async ({ privateKeyPath }) => ({
      created: true, privateKeyPath, publicKeyPath: `${privateKeyPath}.pub`, fingerprint: "SHA256:rollback",
      publicKeyType: "ssh-ed25519", privateMode: "0600", publicMode: "0644",
    }),
    inspectResourceFile: (privateKeyPath) => ({ kind: "file", path: privateKeyPath, size: 100, mode: "0600" }),
    saveState: () => { throw saveFailure; },
    removeGeneratedSshKeyPair: async (key) => {
      incompleteRollbackCalls.push(key.privateKeyPath, key.publicKeyPath);
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    },
  }), "rollback was incomplete");
  assert(incompleteRollbackCalls.length === 2, "incomplete SSH rollback did not attempt all cleanup paths");

  const cleanupPath = join(root, "cleanup-owned");
  const cleanupKey = await generateSshKeyPair({ privateKeyPath: cleanupPath, comment: "cleanup-owned" });
  const cleanupCalls = [];
  await expectReject(() => removeGeneratedSshKeyPair(cleanupKey, {
    removeIfCurrent: async (filePath) => {
      cleanupCalls.push(filePath);
      if (filePath === cleanupKey.privateKeyPath) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  }), "rollback was incomplete");
  assert(cleanupCalls.join(",") === `${cleanupKey.privateKeyPath},${cleanupKey.publicKeyPath}`,
    "SSH key rollback stopped after the first cleanup failure");
  const noCleanupCalls = [];
  await removeGeneratedSshKeyPair({ created: false }, { removeIfCurrent: async (filePath) => { noCleanupCalls.push(filePath); } });
  assert(noCleanupCalls.length === 0, "reused SSH key material was removed during rollback");
  const alreadyAbsentCleanupPath = join(root, "already-absent-cleanup");
  const alreadyAbsentCleanupKey = await generateSshKeyPair({ privateKeyPath: alreadyAbsentCleanupPath, comment: "already-absent" });
  await rm(alreadyAbsentCleanupPath, { force: true });
  await rm(`${alreadyAbsentCleanupPath}.pub`, { force: true });
  await removeGeneratedSshKeyPair(alreadyAbsentCleanupKey);

  const identityRollbackPath = join(root, "identity-rollback");
  const identitySaveFailure = new Error("synthetic identity rollback state failure");
  const identityRollbackError = await captureReject(() => generateRegisteredSshKey({
    workspace: root, name: "identity-rollback", targetPath: identityRollbackPath,
  }, {
    loadState: () => ({ resources: {} }),
    acquireStartupLockWithWait: async () => ({ release() {} }),
    inspectResourceFile: (privateKeyPath) => ({ kind: "file", path: privateKeyPath, size: 100, mode: "0600" }),
    saveState: () => {
      rmSync(identityRollbackPath, { force: true });
      writeFileSync(identityRollbackPath, "replacement-after-generation", { mode: 0o600 });
      throw identitySaveFailure;
    },
  }));
  assert(identityRollbackError instanceof AggregateError && identityRollbackError.errors?.[0] === identitySaveFailure,
    "SSH registration rollback did not preserve the state-write failure as the primary cause");
  assert(readFileSync(identityRollbackPath, "utf8") === "replacement-after-generation",
    "SSH registration rollback deleted a replacement private-key path");
  assert(!await exists(`${identityRollbackPath}.pub`), "SSH registration rollback failed to remove the unchanged generated public key");

  if (process.platform !== "win32") {
    const linkedPath = join(root, "linked-key");
    try {
      await symlink(otherPath, linkedPath);
      await symlink(`${otherPath}.pub`, `${linkedPath}.pub`);
      await expectReject(() => generateSshKeyPair({ privateKeyPath: linkedPath }), "symbolic link");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    }
  }

  console.log("SSH key generation/security test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function expectReject(callback, pattern) {
  const error = await captureReject(callback);
  if (!String(error?.message || error).includes(pattern)) throw error;
}

async function captureReject(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected rejection");
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
