import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { run } from "./shell.mjs";

const KEY_TYPES = new Set(["ed25519", "rsa"]);

export async function generateSshKeyPair(options = {}) {
  const privateKeyPath = resolve(String(options.privateKeyPath || ""));
  if (!privateKeyPath || privateKeyPath === resolve(".")) throw new Error("private key path is required");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const type = String(options.type || "ed25519").toLowerCase();
  if (!KEY_TYPES.has(type)) throw new Error("SSH key type must be ed25519 or rsa");
  const comment = boundedComment(options.comment || `machine-mcp:${basename(privateKeyPath)}`);
  const parent = dirname(privateKeyPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(parent, 0o700);

  const privateInfo = await safeLstat(privateKeyPath);
  const publicInfo = await safeLstat(publicKeyPath);
  if (privateInfo?.isSymbolicLink() || publicInfo?.isSymbolicLink()) throw new Error("SSH key path must not be a symbolic link");
  if (privateInfo || publicInfo) {
    if (!privateInfo?.isFile() || !publicInfo?.isFile()) throw new Error("SSH key pair is incomplete or not a pair of regular files");
    await secureKeyModes(privateKeyPath, publicKeyPath);
    return inspectSshKeyPair(privateKeyPath, publicKeyPath, false);
  }

  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tempPrivate = resolve(parent, `.${basename(privateKeyPath)}.mbm-${suffix}`);
  const tempPublic = `${tempPrivate}.pub`;
  try {
    const args = ["-q", "-t", type];
    if (type === "rsa") args.push("-b", String(normalizeRsaBits(options.bits)));
    args.push("-N", "", "-f", tempPrivate, "-C", comment);
    const generated = await run("ssh-keygen", args, { capture: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (generated.code !== 0) throw new Error("ssh-keygen failed");
    await secureKeyModes(tempPrivate, tempPublic);
    await installNoReplace(tempPrivate, privateKeyPath);
    try {
      await installNoReplace(tempPublic, publicKeyPath);
    } catch (error) {
      await rm(privateKeyPath, { force: true });
      throw error;
    }
    await secureKeyModes(privateKeyPath, publicKeyPath);
    return inspectSshKeyPair(privateKeyPath, publicKeyPath, true);
  } finally {
    await rm(tempPrivate, { force: true });
    await rm(tempPublic, { force: true });
  }
}

export async function inspectSshKeyPair(privateKeyPath, publicKeyPath = `${privateKeyPath}.pub`, created = false) {
  const privateInfo = await stat(privateKeyPath);
  const publicInfo = await stat(publicKeyPath);
  if (!privateInfo.isFile() || !publicInfo.isFile()) throw new Error("SSH key pair is not composed of regular files");
  const derived = await run("ssh-keygen", ["-y", "-P", "", "-f", privateKeyPath], {
    capture: true,
    allowFailure: true,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  if (derived.code !== 0) throw new Error("SSH private key cannot be used non-interactively or is invalid");
  const publicLine = (await readFile(publicKeyPath, "utf8")).trim();
  if (!/^(ssh-ed25519|ssh-rsa)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(publicLine)) throw new Error("generated SSH public key is invalid");
  const expectedFields = publicLine.split(/\s+/).slice(0, 2).join(" ");
  const derivedFields = derived.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
  if (expectedFields !== derivedFields) throw new Error("SSH public key does not match the private key");
  const fingerprint = await run("ssh-keygen", ["-lf", publicKeyPath, "-E", "sha256"], {
    capture: true,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  return {
    created,
    privateKeyPath: resolve(privateKeyPath),
    publicKeyPath: resolve(publicKeyPath),
    privateMode: process.platform === "win32" ? null : `0${(privateInfo.mode & 0o777).toString(8)}`,
    publicMode: process.platform === "win32" ? null : `0${(publicInfo.mode & 0o777).toString(8)}`,
    fingerprint: fingerprint.stdout.trim(),
    publicKeyType: publicLine.split(/\s+/, 1)[0],
  };
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
  await chmod(privateKeyPath, 0o600);
  await chmod(publicKeyPath, 0o644);
}

async function safeLstat(path) {
  try { return await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function boundedComment(value) {
  const comment = String(value || "").replace(/[\r\n\0]/g, " ").trim();
  if (!comment) return "machine-mcp";
  if (Buffer.byteLength(comment) > 256) throw new Error("SSH key comment exceeds 256 bytes");
  return comment;
}

function normalizeRsaBits(value) {
  const bits = Number.parseInt(String(value || "3072"), 10);
  if (![2048, 3072, 4096].includes(bits)) throw new Error("RSA bits must be 2048, 3072, or 4096");
  return bits;
}
