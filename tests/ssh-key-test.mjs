import { copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKeyPair, inspectSshKeyPair } from "../src/local/ssh-key.mjs";
import { generateRegisteredSshKey, removeGeneratedSshKeyPair } from "../src/local/resource-operations.mjs";

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
  const reused = await generateSshKeyPair({ privateKeyPath: edPath, comment: "ignored-on-reuse" });
  assert(reused.created === false && reused.fingerprint === ed.fingerprint, "existing SSH key pair was not reused idempotently");

  const rsaPath = join(root, "operator-rsa");
  const rsa = await generateSshKeyPair({ privateKeyPath: rsaPath, type: "rsa", bits: 2048, comment: "test-rsa" });
  assert(rsa.created && rsa.publicKeyType === "ssh-rsa", "RSA generation or argument ordering failed");

  const otherPath = join(root, "other-ed25519");
  await generateSshKeyPair({ privateKeyPath: otherPath, comment: "other" });
  await copyFile(`${otherPath}.pub`, `${edPath}.pub`);
  await expectReject(() => inspectSshKeyPair(edPath), "does not match");

  const incompletePath = join(root, "incomplete");
  await writeFile(incompletePath, "not-a-key", { mode: 0o600 });
  await expectReject(() => generateSshKeyPair({ privateKeyPath: incompletePath }), "incomplete");

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
    removeFile: async (filePath) => { rollbackCalls.push(filePath); },
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
    removeFile: async (filePath) => {
      incompleteRollbackCalls.push(filePath);
      if (!filePath.endsWith(".pub")) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    },
  }), "rollback was incomplete");
  assert(incompleteRollbackCalls.length === 2, "incomplete SSH rollback did not attempt all cleanup paths");

  const cleanupCalls = [];
  await expectReject(() => removeGeneratedSshKeyPair({
    created: true, privateKeyPath: "private-key", publicKeyPath: "public-key",
  }, async (filePath) => {
    cleanupCalls.push(filePath);
    if (filePath === "private-key") throw Object.assign(new Error("denied"), { code: "EACCES" });
  }), "rollback was incomplete");
  assert(cleanupCalls.join(",") === "private-key,public-key",
    "SSH key rollback stopped after the first cleanup failure");
  const noCleanupCalls = [];
  await removeGeneratedSshKeyPair({ created: false }, async (filePath) => { noCleanupCalls.push(filePath); });
  assert(noCleanupCalls.length === 0, "reused SSH key material was removed during rollback");

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
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
