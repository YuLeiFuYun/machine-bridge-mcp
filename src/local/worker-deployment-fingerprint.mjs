import { createHmac } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import path, { resolve } from "node:path";
import { publicDeviceJwkJson } from "./device-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { deploymentDeviceIdentity } from "./state.mjs";
import { packageRoot } from "./package-identity.mjs";

const MAX_WORKER_DEPLOY_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_DEPLOYMENT_FILES = 4096;
const MAX_DEPLOYMENT_ENTRIES = 8192;
const MAX_DEPLOYMENT_DEPTH = 64;
const REQUIRED_DEPLOYMENT_PATHS = Object.freeze([
  "src/worker",
  "src/shared",
  "wrangler.jsonc",
  "cloudflare.config.ts",
  "wrangler.config.ts",
  "src/local/wrangler-toolchain/package.json",
  "src/local/wrangler-toolchain/package-lock.json",
  "tsconfig.json",
]);

export function workerDeploymentFingerprint(state, options = {}) {
  const source = options.sourceSnapshot || workerDeploymentSourceSnapshot(options.packageRoot || packageRoot);
  const keyMaterial = [
    publicDeviceJwkJson(deploymentDeviceIdentity(state)),
    String(state.worker.oauthTokenVersion || ""),
  ].join("\0");
  const fingerprint = createHmac("sha256", keyMaterial);
  addFingerprintField(fingerprint, "mbm-worker-deploy-cf-v6");
  addFingerprintField(fingerprint, String(state.worker.name || ""));
  addFingerprintField(fingerprint, String(source.files.length));
  for (const file of source.files) {
    addFingerprintField(fingerprint, file.path);
    addFingerprintField(fingerprint, file.content);
  }
  return fingerprint.digest("hex");
}

export function workerDeploymentSourceSnapshot(root = packageRoot) {
  const source = workerDeployHashFiles(root);
  let totalBytes = 0;
  const files = source.files.map(file => {
    const content = readBoundedRegularFileSync(file, MAX_WORKER_DEPLOY_SOURCE_BYTES,
      "Worker deployment source", { verifyPathIdentity: true, rejectMultipleLinks: true });
    totalBytes += content.length;
    if (totalBytes > 64 * 1024 * 1024) throw new Error("Worker deployment source exceeds 64 MiB");
    return Object.freeze({ path: path.relative(source.root, file).replaceAll(path.sep, "/"), content });
  });
  return Object.freeze({ files: Object.freeze(files) });
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
  const budget = { visited: 0 };
  for (const item of REQUIRED_DEPLOYMENT_PATHS) collectRequiredHashPath(canonicalRoot, item, files, budget);
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

function collectRequiredHashPath(root, relativePath, out, budget) {
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
  collectHashFiles(current, out, budget);
}

function requiredPathInfo(target) {
  try { return lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Worker deployment required source is missing: ${target}`);
    throw error;
  }
}

function collectHashFiles(target, out, budget, depth = 0) {
  budget.visited += 1;
  if (budget.visited > MAX_DEPLOYMENT_ENTRIES) throw new Error("Worker deployment source exceeds its entry limit");
  if (depth > MAX_DEPLOYMENT_DEPTH) throw new Error("Worker deployment source exceeds its depth limit");
  const info = requiredPathInfo(target);
  if (info.isSymbolicLink()) throw new Error("Worker deployment source must not be a symbolic link: " + target);
  if (info.isFile()) {
    if (/\.(ts|js|mjs|json|jsonc|yaml|yml|lock)$/.test(target)) {
      if (out.length >= MAX_DEPLOYMENT_FILES) throw new Error("Worker deployment source exceeds 4096 files");
      out.push(target);
    }
    return;
  }
  if (!info.isDirectory()) throw new Error("Worker deployment source must be a regular file or directory: " + target);
  // Streaming bounds enumeration allocation as well as visited entries.
  const directory = opendirSync(target);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (entry.name === "node_modules" || entry.name === ".wrangler" || entry.name.endsWith(".d.ts")) {
        budget.visited += 1;
        if (budget.visited > MAX_DEPLOYMENT_ENTRIES) throw new Error("Worker deployment source exceeds its entry limit");
        continue;
      }
      collectHashFiles(resolve(target, entry.name), out, budget, depth + 1);
    }
  } finally {
    directory.closeSync();
  }
}
