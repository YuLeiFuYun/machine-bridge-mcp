import { createHmac } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path, { resolve } from "node:path";
import { publicDeviceJwkJson } from "./device-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { deploymentDeviceIdentity, packageRoot } from "./state.mjs";

const MAX_WORKER_DEPLOY_SOURCE_BYTES = 16 * 1024 * 1024;
const REQUIRED_DEPLOYMENT_PATHS = Object.freeze([
  "src/worker",
  "src/shared",
  "wrangler.jsonc",
  "tsconfig.json",
]);

export function workerDeploymentFingerprint(state, options = {}) {
  const source = workerDeployHashFiles(options.packageRoot || packageRoot);
  const keyMaterial = [
    publicDeviceJwkJson(deploymentDeviceIdentity(state)),
    String(state.worker.oauthTokenVersion || ""),
  ].join("\0");
  const fingerprint = createHmac("sha256", keyMaterial);
  addFingerprintField(fingerprint, "mbm-worker-deploy-v5");
  addFingerprintField(fingerprint, String(state.worker.name || ""));
  addFingerprintField(fingerprint, String(source.files.length));
  for (const file of source.files) {
    addFingerprintField(fingerprint, path.relative(source.root, file).replaceAll(path.sep, "/"));
    addFingerprintField(fingerprint, readBoundedRegularFileSync(
      file,
      MAX_WORKER_DEPLOY_SOURCE_BYTES,
      "Worker deployment source",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    ));
  }
  return fingerprint.digest("hex");
}

function addFingerprintField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function workerDeployHashFiles(root) {
  const canonicalRoot = requireRealDeploymentRoot(root);
  const files = [];
  for (const item of REQUIRED_DEPLOYMENT_PATHS) collectRequiredHashPath(canonicalRoot, item, files);
  return Object.freeze({ root: canonicalRoot, files: files.sort() });
}

function requireRealDeploymentRoot(root) {
  const target = resolve(root);
  let info;
  try { info = lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Worker deployment package root is missing: ${target}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worker deployment package root must be a real directory: ${target}`);
  }
  return realpathSync(target);
}

function collectRequiredHashPath(root, relativePath, out) {
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const info = requiredPathInfo(current);
    if (info.isSymbolicLink()) throw new Error(`Worker deployment source must not be a symbolic link: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Worker deployment source ancestor must be a real directory: ${current}`);
    }
  }
  collectHashFiles(current, out);
}

function requiredPathInfo(target) {
  try { return lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Worker deployment required source is missing: ${target}`);
    throw error;
  }
}

function collectHashFiles(target, out) {
  const info = requiredPathInfo(target);
  if (info.isSymbolicLink()) throw new Error(`Worker deployment source must not be a symbolic link: ${target}`);
  if (info.isFile()) {
    if (/\.(ts|js|mjs|json|jsonc|yaml|yml|lock)$/.test(target)) out.push(target);
    return;
  }
  if (!info.isDirectory()) throw new Error(`Worker deployment source must be a regular file or directory: ${target}`);
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler" || entry.name.endsWith(".d.ts")) continue;
    collectHashFiles(resolve(target, entry.name), out);
  }
}
