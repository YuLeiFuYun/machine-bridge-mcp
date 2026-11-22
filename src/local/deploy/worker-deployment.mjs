import { createHmac } from "node:crypto";
import { lstatSync, opendirSync, realpathSync, readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { publicDeviceJwkJson } from "../state/device-identity.mjs";
import { readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { deploymentDeviceIdentity, saveState } from "../state/state.mjs";
import { packageRoot } from "../core/timing.mjs";
import { isOAuthTokenVersion, isWorkerName } from "../state/worker-identity-contract.mjs";
import { runCf } from "./shell.mjs";
import { ensureCfAuthenticated, cfDeploymentAccount, withCfProject } from "./cf-project.mjs";
import { withWorkerSecretsFile } from "../state/worker-secret-file.mjs";
import { normalizeWorkerOrigin, retryWorkerHealth, workerHealthRequiresRedeploy, workerHealthUserReason } from "../transport/network-proxy.mjs";

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
  const worker = exactDeploymentWorkerIdentity(state);
  const keyMaterial = [
    publicDeviceJwkJson(deploymentDeviceIdentity(state)),
    worker.oauthTokenVersion,
  ].join("\0");
  const fingerprint = createHmac("sha256", keyMaterial);
  addFingerprintField(fingerprint, "mbm-worker-deploy-cf-v6");
  addFingerprintField(fingerprint, worker.name);
  addFingerprintField(fingerprint, String(source.files.length));
  for (const file of source.files) {
    addFingerprintField(fingerprint, file.path);
    addFingerprintField(fingerprint, file.content);
  }
  return fingerprint.digest("hex");
}

function exactDeploymentWorkerIdentity(state) {
  const worker = state?.worker;
  if (!worker || typeof worker !== "object" || Array.isArray(worker)
      || !isWorkerName(worker.name) || !isOAuthTokenVersion(worker.oauthTokenVersion)) {
    throw new Error("Worker deployment identity is invalid");
  }
  return worker;
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
const DEFAULT_DEPLOYMENT_HEALTH_ATTEMPTS = 20;

export async function ensureWorkerDeployment(state, args = {}, options = {}) {
  const logger = options.logger || console;
  const expectedVersion = options.expectedVersion || currentPackageVersion(options.packageRoot || packageRoot);
  const sourceSnapshot = workerDeploymentSourceSnapshot(options.packageRoot || packageRoot);
  const desiredHash = workerDeploymentFingerprint(state, { sourceSnapshot });
  const cfOptions = cfDeploymentOptions(state, options);
  const runCfFn = cfOptions.runCf;
  const cfStateRoot = cfOptions.stateRoot;
  const withCfProjectFn = cfOptions.withCfProject;
  const saveStateFn = options.saveState || saveState;
  const retryHealthFn = options.retryHealth || retryWorkerHealth;
  const withSecretsFileFn = options.withSecretsFile || withWorkerSecretsFile;
  const healthOptions = { expectedWorkerName: state.worker.name, ...(options.healthOptions || {}) };
  const complete = hasCompleteWorkerState(state.worker);

  if (!args.forceWorker && !args.rotateSecrets && !complete
      && state.worker.deployHash === desiredHash && state.worker.deployedVersion === expectedVersion) {
    throw workerEndpointUnverifiedError(false);
  }

  if (!args.forceWorker && !args.rotateSecrets && complete && state.worker.deployHash === desiredHash) {
    const recordedCurrentDeployment = state.worker.deployedVersion === expectedVersion;
    const attempts = recordedCurrentDeployment
      ? (options.recordedDeploymentHealthAttempts ?? DEFAULT_DEPLOYMENT_HEALTH_ATTEMPTS)
      : (options.existingHealthAttempts ?? 2);
    const health = await retryHealthFn(state.worker.url, expectedVersion, attempts, healthOptions);
    if (health.ok) {
      logger.success?.("Worker unchanged and healthy");
      logger.debug?.("Worker health route", { network_route: health.networkRoute || "unknown" });
      return state.worker;
    }
    logger.debug?.("Worker health check detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
    if (recordedCurrentDeployment) {
      throw workerVerificationError(health.error, { deploymentSucceeded: false, recordedCurrentDeployment: true });
    }
    if (!workerHealthRequiresRedeploy(health.error)) {
      throw workerVerificationError(health.error, { deploymentSucceeded: false });
    }
    logger.warn?.("Recorded Worker is stale; redeploying the same Worker", { reason: workerHealthUserReason(health.error) });
  }

  logger.info?.("Checking Cloudflare cf login");
  const environment = cfOptions.env;
  const auth = await ensureCfAuthenticated({
    runCf: runCfFn, shared: { stateRoot: cfStateRoot, packageRoot: options.packageRoot || packageRoot, env: environment },
    interactive: !args.json, logger,
  });
  const accountId = cfDeploymentAccount(auth, environment);
  logger.info?.("Deploying Cloudflare Worker");
  await withCfProjectFn(sourceSnapshot, state.worker.name,
    project => withSecretsFileFn(state, async secretFile => {
      const deploy = await runCfFn([
        "deploy", "--prebuilt", "--secrets-file", secretFile,
      ], { ...project, capture: true, hardTimeout: true, stateRoot: cfStateRoot, packageRoot: options.packageRoot || packageRoot });
      // Persist confirmed external success before staging cleanup can fail.
      recordWorkerUpload(state, deploy, desiredHash, expectedVersion, saveStateFn);
      return deploy;
    }),
    { runCf: runCfFn, stateRoot: cfStateRoot, packageRoot: options.packageRoot || packageRoot,
      env: { ...environment, CLOUDFLARE_ACCOUNT_ID: accountId } });

  const health = await retryHealthFn(state.worker.url, expectedVersion, options.deploymentHealthAttempts ?? DEFAULT_DEPLOYMENT_HEALTH_ATTEMPTS, healthOptions);
  if (!health.ok) {
    logger.debug?.("Worker post-deployment health detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
    throw workerVerificationError(health.error, { deploymentSucceeded: true });
  }
  logger.success?.("Worker ready", { version: health.version });
  logger.debug?.("Worker health route", { network_route: health.networkRoute || "unknown" });
  return state.worker;
}

function recordWorkerUpload(state, deploy, desiredHash, expectedVersion, saveStateFn) {
  const detectedUrl = extractWorkerUrl(deploy.stdout, state.worker.name) || extractWorkerUrl(deploy.stderr, state.worker.name);
  const recordedUrl = workerUrlMatchesName(state.worker.url, state.worker.name) ? state.worker.url : "";
  const workerUrl = detectedUrl || recordedUrl;
  state.worker.deployHash = desiredHash;
  state.worker.deployedVersion = expectedVersion;
  state.worker.updatedAt = new Date().toISOString();
  if (workerUrl) {
    state.worker.url = workerUrl.replace(/\/+$/, "");
    state.worker.mcpServerUrl = state.worker.url + "/mcp";
  } else {
    delete state.worker.url;
    delete state.worker.mcpServerUrl;
  }
  saveStateFn(state);
  if (!workerUrl) throw workerEndpointUnverifiedError(true);
}

function workerEndpointUnverifiedError(deploymentSucceeded) {
  const error = new Error("Worker upload success is recorded, but its endpoint is unverified. No automatic redeployment is allowed; reconcile the existing workers.dev endpoint before retrying.");
  error.code = "worker_endpoint_unverified";
  error.deploymentSucceeded = deploymentSucceeded;
  error.retryable = false;
  return error;
}

export function extractWorkerUrl(text = "", workerName = "") {
  const candidates = [...String(text).matchAll(/https:\/\/[^\s"'<>]+/g)]
    .map((match) => match[0].replace(/[),.;:!?]+$/, ""));
  for (const candidate of candidates.reverse()) {
    try {
      return normalizeWorkerOrigin(candidate, workerName);
    } catch {
      // cf output may contain unrelated links; only a canonical matching workers.dev origin is deployment evidence.
    }
  }
  return "";
}

export function workerUrlMatchesName(workerUrl, workerName) {
  if (!workerUrl || !workerName) return false;
  try {
    normalizeWorkerOrigin(workerUrl, workerName);
    return true;
  } catch {
    return false;
  }
}

function hasCompleteWorkerState(worker = {}) {
  return Boolean(worker.url && worker.mcpServerUrl && worker.deviceIdentity && worker.oauthTokenVersion && worker.name);
}

function workerVerificationError(reason, { deploymentSucceeded, recordedCurrentDeployment = false }) {
  const readable = workerHealthUserReason(reason);
  const guidance = workerVerificationGuidance(reason);
  const message = deploymentSucceeded
    ? `Cloudflare reported the Worker deployment succeeded, but ${readable}. The deployment fingerprint was saved, so retrying will verify the same Worker instead of deploying again. ${guidance}`
    : recordedCurrentDeployment
      ? `The current Worker deployment fingerprint is already recorded, but ${readable}. No deployment was attempted because duplicating the recorded deployment is unsafe; use --force-worker only after diagnosis. ${guidance}`
      : `The recorded Worker could not be verified because ${readable}. No deployment was attempted. ${guidance}`;
  const error = new Error(message);
  error.code = "worker_health_unverified";
  error.healthError = reason;
  error.deploymentSucceeded = deploymentSucceeded;
  return error;
}

function workerVerificationGuidance(reason) {
  if (reason === "proxy_configuration") {
    return "Check HTTPS_PROXY, HTTP_PROXY, and NO_PROXY, then run machine-mcp doctor.";
  }
  if (["timeout", "tls_error", "network_error", "request_failed"].includes(reason)) {
    return "Check network/TLS access and HTTPS_PROXY, HTTP_PROXY, and NO_PROXY, then run machine-mcp doctor.";
  }
  if (/^HTTP 5\d\d$/.test(String(reason || ""))) {
    return "Retry after the service recovers, or run machine-mcp doctor for the current health result.";
  }
  return "Run machine-mcp doctor and inspect the health endpoint before forcing another deployment.";
}

function currentPackageVersion(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return String(pkg.version);
}

function cfDeploymentOptions(state, options) {
  return { runCf: options.runCf || runCf, withCfProject: options.withCfProject || withCfProject,
    stateRoot: options.stateRoot || state.paths?.stateRoot, env: options.env || process.env };
}
