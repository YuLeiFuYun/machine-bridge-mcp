import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { runExecutable } from "./shell.mjs";
import { chmodRegularFileSync, readBoundedRegularFileWithInfoSync } from "./secure-file.mjs";

const KEY_TYPES = new Set(["ed25519", "rsa"]);

export async function generateSshKeyPair(options = {}) {
  const request = normalizeKeyRequest(options);
  await mkdir(request.parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(request.parent, 0o700);

  const existing = await inspectExistingKeyFiles(request.privateKeyPath, request.publicKeyPath);
  if (existing) {
    await secureKeyModes(request.privateKeyPath, request.publicKeyPath);
    return inspectSshKeyPair(request.privateKeyPath, request.publicKeyPath, false);
  }
  return createSshKeyPair(request);
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
    bits: options.bits,
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

async function createSshKeyPair(request) {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tempPrivate = resolve(request.parent, `.${basename(request.privateKeyPath)}.mbm-${suffix}`);
  const tempPublic = `${tempPrivate}.pub`;
  try {
    const args = ["-q", "-t", request.type];
    if (request.type === "rsa") args.push("-b", String(normalizeRsaBits(request.bits)));
    args.push("-N", "", "-f", tempPrivate, "-C", request.comment);
    const generated = await runExecutable("ssh-keygen", args, { capture: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (generated.code !== 0) throw new Error("ssh-keygen failed");
    await secureKeyModes(tempPrivate, tempPublic);
    await installNoReplace(tempPrivate, request.privateKeyPath);
    try {
      await installNoReplace(tempPublic, request.publicKeyPath);
    } catch (error) {
      await rm(request.privateKeyPath, { force: true });
      throw error;
    }
    await secureKeyModes(request.privateKeyPath, request.publicKeyPath);
    return inspectSshKeyPair(request.privateKeyPath, request.publicKeyPath, true);
  } finally {
    await rm(tempPrivate, { force: true });
    await rm(tempPublic, { force: true });
  }
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
    return {
      created,
      privateKeyPath: resolve(privateKeyPath),
      publicKeyPath: resolve(publicKeyPath),
      privateMode: process.platform === "win32" ? null : `0${(privateSnapshot.info.mode & 0o777).toString(8)}`,
      publicMode: process.platform === "win32" ? null : `0${(publicSnapshot.info.mode & 0o777).toString(8)}`,
      fingerprint: fingerprintValue,
      publicKeyType: publicLine.split(/\s+/, 1)[0],
    };
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true });
  }
}

async function installNoReplace(source, target) {
  try {
    await link(source, target);
    await unlink(source);
  } catch (error) {
    if (error?.code === "EXDEV") {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      await unlink(source);
      return;
    }
    if (error?.code === "EEXIST") throw new Error(`refusing to replace existing SSH key file: ${target}`);
    throw error;
  }
}

async function secureKeyModes(privateKeyPath, publicKeyPath) {
  if (process.platform === "win32") return;
  chmodRegularFileSync(privateKeyPath, 0o600, "SSH private key");
  chmodRegularFileSync(publicKeyPath, 0o644, "SSH public key");
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
  const sameIdentity = Number(current.info.dev) === Number(expected.info.dev)
    && Number(current.info.ino) === Number(expected.info.ino)
    && Number(current.info.size) === Number(expected.info.size)
    && Number(current.info.mtimeMs) === Number(expected.info.mtimeMs);
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
  const bits = Number.parseInt(String(value || "3072"), 10);
  if (![2048, 3072, 4096].includes(bits)) throw new Error("RSA bits must be 2048, 3072, or 4096");
  return bits;
}
