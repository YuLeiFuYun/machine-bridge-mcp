import { closeSync, constants as fsConstants, fstatSync, lstatSync, unlinkSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { runExecutable } from "./shell.mjs";
import { chmodRegularFileIfIdentitySync, openRegularFileSync, readBoundedRegularFileWithInfoSync, unlinkRegularFileIfIdentitySync } from "./secure-file.mjs";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";

const KEY_TYPES = new Set(["ed25519", "rsa"]);
const GENERATED_KEY_IDENTITIES = Symbol("generated-key-identities");

export async function generateSshKeyPair(options = {}) {
  const request = normalizeKeyRequest(options);
  await mkdir(request.parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(request.parent, 0o700);

  const existing = await inspectExistingKeyFiles(request.privateKeyPath, request.publicKeyPath);
  if (existing) {
    const inspected = await inspectSshKeyPair(request.privateKeyPath, request.publicKeyPath, false);
    await secureKeyModes(request.privateKeyPath, request.publicKeyPath, keyIdentities(inspected));
    return inspectSshKeyPair(request.privateKeyPath, request.publicKeyPath, false);
  }
  return createSshKeyPair(request, options);
}
function normalizeKeyRequest(options) {
  const privateKeyPath = resolve(String(options.privateKeyPath || ""));
  if (!privateKeyPath || privateKeyPath === resolve(".")) throw new Error("private key path is required");
  const type = String(options.type || "ed25519").toLowerCase();
  if (!KEY_TYPES.has(type)) throw new Error("SSH key type must be ed25519 or rsa");
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
    parent: dirname(privateKeyPath),
    type,
    bits: type === "rsa" ? normalizeRsaBits(options.bits) : null,
    comment: boundedComment(options.comment || `machine-mcp:${basename(privateKeyPath)}`),
  };
}
async function inspectExistingKeyFiles(privateKeyPath, publicKeyPath) {
  const privateSnapshot = tryReadKeySnapshot(privateKeyPath, 1024 * 1024, "SSH private key");
  const publicSnapshot = tryReadKeySnapshot(publicKeyPath, 64 * 1024, "SSH public key");
  if (!privateSnapshot && !publicSnapshot) return false;
  if (!privateSnapshot || !publicSnapshot) throw new Error("SSH key pair is incomplete or not a pair of regular files");
  return true;
}
async function createSshKeyPair(request, options = {}) {
  const install = typeof options.installNoReplace === "function"
    ? options.installNoReplace
    : (source, target) => installNoReplace(source, target, options.installOptions);
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tempPrivate = resolve(request.parent, `.${basename(request.privateKeyPath)}.mbm-${suffix}`);
  const tempPublic = `${tempPrivate}.pub`;
  const tempIdentities = {};
  let primaryError = null;
  let result;
  try {
    const args = ["-q", "-t", request.type];
    if (request.type === "rsa") args.push("-b", String(request.bits));
    args.push("-N", "", "-f", tempPrivate, "-C", request.comment);
    const generated = await runExecutable("ssh-keygen", args, { capture: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (generated.code !== 0) throw new Error("ssh-keygen failed");
    tempIdentities.private = keyPathIdentity(tempPrivate, "generated temporary SSH private key");
    tempIdentities.public = keyPathIdentity(tempPublic, "generated temporary SSH public key");
    await secureKeyModes(tempPrivate, tempPublic, tempIdentities);
    await install(tempPrivate, request.privateKeyPath);
    const installedPrivateIdentity = keyPathIdentity(request.privateKeyPath, "generated SSH private key");
    try {
      await install(tempPublic, request.publicKeyPath);
    } catch (error) {
      try {
        removeKeyPathIfCurrent(request.privateKeyPath, installedPrivateIdentity, "generated SSH private key");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "SSH key pair installation failed and private-key rollback was incomplete");
      }
      throw error;
    }
    const installedIdentities = {
      private: installedPrivateIdentity,
      public: keyPathIdentity(request.publicKeyPath, "generated SSH public key"),
    };
    await secureKeyModes(request.privateKeyPath, request.publicKeyPath, installedIdentities);
    result = await inspectSshKeyPair(request.privateKeyPath, request.publicKeyPath, true);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  for (const [filePath, identity] of [[tempPrivate, tempIdentities.private], [tempPublic, tempIdentities.public]]) {
    if (!identity) continue;
    try { unlinkKnownLinkIfCurrent(filePath, identity); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, "SSH key staging cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  return result;
}
export async function inspectSshKeyPair(privateKeyPath, publicKeyPath = `${privateKeyPath}.pub`, created = false) {
  const privateSnapshot = readKeySnapshot(privateKeyPath, 1024 * 1024, "SSH private key");
  const publicSnapshot = readKeySnapshot(publicKeyPath, 64 * 1024, "SSH public key");
  const inspectionRoot = await mkdtemp(join(tmpdir(), "machine-mcp-key-inspection-"));
  const inspectionPrivate = join(inspectionRoot, "key");
  const inspectionPublic = `${inspectionPrivate}.pub`;
  try {
    await writeFile(inspectionPrivate, privateSnapshot.buffer, { mode: 0o600, flag: "wx" });
    await writeFile(inspectionPublic, publicSnapshot.buffer, { mode: 0o600, flag: "wx" });
    const derived = await runExecutable("ssh-keygen", ["-y", "-P", "", "-f", inspectionPrivate], {
      capture: true,
      allowFailure: true,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (derived.code !== 0) throw new Error("SSH private key cannot be used non-interactively or is invalid");
    const publicLine = new TextDecoder("utf-8", { fatal: true }).decode(publicSnapshot.buffer).trim();
    if (!/^(ssh-ed25519|ssh-rsa)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(publicLine)) throw new Error("generated SSH public key is invalid");
    const expectedFields = publicLine.split(/\s+/).slice(0, 2).join(" ");
    const derivedFields = derived.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
    if (expectedFields !== derivedFields) throw new Error("SSH public key does not match the private key");
    const fingerprint = await runExecutable("ssh-keygen", ["-lf", inspectionPublic, "-E", "sha256"], {
      capture: true,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    const fingerprintValue = fingerprint.stdout.trim().split(/\s+/)[1] || "";
    if (!/^SHA256:[A-Za-z0-9+/=]+$/.test(fingerprintValue)) throw new Error("SSH key fingerprint output is invalid");
    assertKeySnapshotCurrent(privateKeyPath, privateSnapshot, 1024 * 1024, "SSH private key");
    assertKeySnapshotCurrent(publicKeyPath, publicSnapshot, 64 * 1024, "SSH public key");
    const result = {
      created,
      privateKeyPath: resolve(privateKeyPath),
      publicKeyPath: resolve(publicKeyPath),
      privateMode: process.platform === "win32" ? null : `0${(privateSnapshot.info.mode & 0o777).toString(8)}`,
      publicMode: process.platform === "win32" ? null : `0${(publicSnapshot.info.mode & 0o777).toString(8)}`,
      fingerprint: fingerprintValue,
      publicKeyType: publicLine.split(/\s+/, 1)[0],
    };
    Object.defineProperty(result, GENERATED_KEY_IDENTITIES, {
      value: Object.freeze({ private: privateSnapshot.identity, public: publicSnapshot.identity }),
      enumerable: false,
    });
    return result;
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true });
  }
}
export async function removeGeneratedSshKeyPair(key, options = {}) {
  if (!key?.created) return;
  const identities = key[GENERATED_KEY_IDENTITIES];
  if (!identities?.private || !identities?.public) {
    throw new Error("generated SSH key rollback identity is unavailable; refusing path-only cleanup");
  }
  const remove = typeof options.removeIfCurrent === "function" ? options.removeIfCurrent : removeKeyPathIfCurrent;
  const failures = [];
  for (const [kind, filePath, identity] of [
    ["private", key.privateKeyPath, identities.private],
    ["public", key.publicKeyPath, identities.public],
  ]) {
    try { await remove(filePath, identity, `generated SSH ${kind} key`); }
    catch (cause) { failures.push(new Error(`generated SSH ${kind} key cleanup failed`, { cause })); }
  }
  if (failures.length) throw new AggregateError(failures, "generated SSH key rollback was incomplete");
}
function keyPathIdentity(filePath, label) {
  const info = lstatSync(filePath, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) throw new Error(`${label} is not an exclusive regular file`);
  return filesystemIdentity(info, label);
}
function removeKeyPathIfCurrent(filePath, identity, label) {
  let current;
  try { current = lstatSync(filePath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
      || !sameFilesystemIdentity(identity, filesystemIdentity(current, label))) {
    throw new Error(`${label} changed before rollback; replacement was preserved`);
  }
  if (!unlinkRegularFileIfIdentitySync(filePath, identity, label)) {
    throw new Error(`${label} changed before rollback; replacement was preserved`);
  }
}
async function installNoReplace(source, target, options = {}) {
  const createLink = options?.link || link;
  const opened = openRegularFileSync(source, fsConstants.O_RDONLY, { label: "SSH staging key", verifyPathIdentity: true, rejectMultipleLinks: true });
  let primaryError = null;
  try {
    try { await createLink(source, target); }
    catch (error) {
      if (error?.code === "EEXIST") throw new Error(`refusing to replace existing SSH key file: ${target}`);
      throw error;
    }
    const installedIdentity = installedLinkIdentity(opened.fd, source, target);
    try {
      if (typeof options?.unlink === "function") await options.unlink(source, installedIdentity);
      else removeInstalledLinkIfCurrent(source, installedIdentity, "SSH staging key");
    } catch (error) {
      try { removeInstalledLinkIfCurrent(target, installedIdentity); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "SSH key installation failed and target rollback was incomplete"); }
      throw error;
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try { unlinkKnownLinkIfCurrent(source, filesystemIdentity(fstatSync(opened.fd, { bigint: true }), "SSH staging key cleanup")); }
  catch (error) { cleanupErrors.push(error); }
  try { closeSync(opened.fd); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, "SSH key installation staging cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
}
function installedLinkIdentity(sourceFd, source, target) {
  const sourceIdentity = filesystemIdentity(fstatSync(sourceFd, { bigint: true }), "SSH staging key after link");
  const targetInfo = lstatSync(target, { bigint: true });
  const targetIdentity = filesystemIdentity(targetInfo, "installed SSH key target");
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || !sameFilesystemIdentity(sourceIdentity, targetIdentity)) {
    throw new Error("installed SSH key target does not match the staging key; replacement was preserved");
  }
  try {
    const sourceInfo = lstatSync(source, { bigint: true });
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()
        || !sameFilesystemIdentity(sourceIdentity, filesystemIdentity(sourceInfo, "SSH staging key after link"))) {
      throw new Error("SSH staging key changed after link");
    }
  } catch (error) {
    try { removeInstalledLinkIfCurrent(target, targetIdentity); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "SSH key link verification failed and target rollback was incomplete"); }
    throw error;
  }
  return targetIdentity;
}
function unlinkKnownLinkIfCurrent(filePath, expectedIdentity) {
  let current;
  try { current = lstatSync(filePath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (current.isSymbolicLink() || !current.isFile()
      || !sameFilesystemIdentity(expectedIdentity, filesystemIdentity(current, "SSH key link"))) return false;
  try { unlinkSync(filePath); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function removeInstalledLinkIfCurrent(filePath, expectedIdentity, label = "installed SSH key target") {
  if (unlinkKnownLinkIfCurrent(filePath, expectedIdentity)) return;
  try { lstatSync(filePath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error(`${label} changed before rollback; replacement was preserved`);
}
async function secureKeyModes(privateKeyPath, publicKeyPath, expected) {
  if (process.platform === "win32") return;
  if (!expected?.private || !expected?.public) throw new Error("SSH key permission update requires exact key identities");
  chmodRegularFileIfIdentitySync(privateKeyPath, expected.private, 0o600, "SSH private key");
  chmodRegularFileIfIdentitySync(publicKeyPath, expected.public, 0o644, "SSH public key");
}
function keyIdentities(key) {
  const identities = key?.[GENERATED_KEY_IDENTITIES];
  if (!identities?.private || !identities?.public) throw new Error("SSH key inspection identity is unavailable");
  return identities;
}
function tryReadKeySnapshot(path, maxBytes, label) {
  try { return readKeySnapshot(path, maxBytes, label); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readKeySnapshot(path, maxBytes, label) {
  return readBoundedRegularFileWithInfoSync(path, maxBytes, label);
}

function assertKeySnapshotCurrent(path, expected, maxBytes, label) {
  const current = readKeySnapshot(path, maxBytes, label);
  const sameIdentity = sameFilesystemIdentity(current.identity, expected.identity);
  const sameBytes = current.buffer.length === expected.buffer.length
    && timingSafeEqual(current.buffer, expected.buffer);
  if (!sameIdentity || !sameBytes) throw new Error(`${label} changed during inspection; retry`);
}

function boundedComment(value) {
  const comment = String(value || "").replace(/[\r\n\0\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ").replace(/\s+/g, " ").trim();
  if (!comment) return "machine-mcp";
  if (Buffer.byteLength(comment) > 256) throw new Error("SSH key comment exceeds 256 bytes");
  return comment;
}

function normalizeRsaBits(value) {
  const bits = value === undefined || value === null || value === "" ? 3072 : Number(value);
  if (!Number.isInteger(bits) || ![2048, 3072, 4096].includes(bits)) throw new Error("RSA bits must be 2048, 3072, or 4096");
  return bits;
}
