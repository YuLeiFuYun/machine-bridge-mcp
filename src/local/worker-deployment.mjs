import { createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path, { resolve } from "node:path";
import { runWrangler } from "./shell.mjs";
import { packageRoot, saveState } from "./state.mjs";
import { withWorkerSecretsFile } from "./worker-secret-file.mjs";
import {
  normalizeWorkerOrigin,
  retryWorkerHealth,
  workerHealthRequiresRedeploy,
  workerHealthUserReason,
} from "./worker-health.mjs";

export async function ensureWorkerDeployment(state, args = {}, options = {}) {
  const logger = options.logger || console;
  const expectedVersion = options.expectedVersion || currentPackageVersion(options.packageRoot || packageRoot);
  const desiredHash = workerDeploymentFingerprint(state, { packageRoot: options.packageRoot || packageRoot });
  const runWranglerFn = options.runWrangler || runWrangler;
  const saveStateFn = options.saveState || saveState;
  const retryHealthFn = options.retryHealth || retryWorkerHealth;
  const withSecretsFileFn = options.withSecretsFile || withWorkerSecretsFile;
  const healthOptions = { expectedWorkerName: state.worker.name, ...(options.healthOptions || {}) };
  const complete = hasCompleteWorkerState(state.worker);

  if (!args.forceWorker && !args.rotateSecrets && complete && state.worker.deployHash === desiredHash) {
    const health = await retryHealthFn(state.worker.url, expectedVersion, options.existingHealthAttempts || 2, healthOptions);
    if (health.ok) {
      logger.success?.("Worker unchanged and healthy", { url: state.worker.url });
      logger.debug?.("Worker health route", { network_route: health.networkRoute || "unknown" });
      return state.worker;
    }
    if (!workerHealthRequiresRedeploy(health.error)) {
      logger.debug?.("Worker health check detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
      throw workerVerificationError(health.error, { deploymentSucceeded: false });
    }
    logger.warn?.("Recorded Worker is stale; redeploying the same Worker", { reason: workerHealthUserReason(health.error) });
    logger.debug?.("Worker health check detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
  }

  logger.info?.("Checking Cloudflare Wrangler login");
  const whoami = await runWranglerFn(["whoami"], { capture: true, allowFailure: true });
  if (whoami.code !== 0) {
    logger.info?.("Wrangler is not logged in; opening Cloudflare login");
    await runWranglerFn(["login"]);
  }

  logger.info?.("Deploying Cloudflare Worker", { name: state.worker.name });
  const deploy = await withSecretsFileFn(state, secretFile => runWranglerFn([
    "deploy",
    "--name", state.worker.name,
    "--minify",
    "--keep-vars",
    "--secrets-file", secretFile,
  ], { capture: true }));

  const detectedUrl = extractWorkerUrl(deploy.stdout, state.worker.name) || extractWorkerUrl(deploy.stderr, state.worker.name);
  const recordedUrl = workerUrlMatchesName(state.worker.url, state.worker.name) ? state.worker.url : "";
  const workerUrl = detectedUrl || recordedUrl;
  if (!workerUrl) {
    throw new Error("Worker upload returned success, but Wrangler output contained no workers.dev URL and no matching recorded URL exists. The deployment fingerprint was not saved; rerun with --verbose and inspect the Wrangler output before retrying.");
  }

  state.worker.url = workerUrl.replace(/\/+$/, "");
  state.worker.mcpServerUrl = `${state.worker.url}/mcp`;
  state.worker.deployHash = desiredHash;
  state.worker.deployedVersion = expectedVersion;
  state.worker.updatedAt = new Date().toISOString();
  saveStateFn(state);

  const health = await retryHealthFn(state.worker.url, expectedVersion, options.deploymentHealthAttempts || 8, healthOptions);
  if (!health.ok) {
    logger.debug?.("Worker post-deployment health detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
    throw workerVerificationError(health.error, { deploymentSucceeded: true });
  }
  logger.success?.("Worker ready", { url: state.worker.url, version: health.version });
  logger.debug?.("Worker health route", { network_route: health.networkRoute || "unknown" });
  return state.worker;
}

export function workerDeploymentFingerprint(state, options = {}) {
  const root = resolve(options.packageRoot || packageRoot);
  const keyMaterial = [
    String(state.worker.accountAdminSecret || ""),
    String(state.worker.daemonSecret || ""),
    String(state.worker.oauthTokenVersion || ""),
  ].join("\0");
  const fingerprint = createHmac("sha256", keyMaterial);
  fingerprint.update("mbm-worker-deploy-v3");
  fingerprint.update(String(state.worker.name || ""));
  for (const file of workerDeployHashFiles(root)) {
    fingerprint.update(path.relative(root, file));
    fingerprint.update(readFileSync(file, "utf8"));
  }
  return fingerprint.digest("hex");
}

export function extractWorkerUrl(text = "", workerName = "") {
  const candidates = [...String(text).matchAll(/https:\/\/[^\s"'<>]+/g)]
    .map((match) => match[0].replace(/[),.;:!?]+$/, ""));
  for (const candidate of candidates.reverse()) {
    try {
      return normalizeWorkerOrigin(candidate, workerName);
    } catch {
      // Wrangler output may contain unrelated links; only a canonical matching workers.dev origin is deployment evidence.
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
  return Boolean(worker.url && worker.mcpServerUrl && worker.accountAdminSecret && worker.daemonSecret && worker.oauthTokenVersion && worker.name);
}

function workerDeployHashFiles(root) {
  const files = [];
  for (const item of ["src/worker", "src/shared", "wrangler.jsonc", "tsconfig.json"]) {
    collectHashFiles(resolve(root, item), files);
  }
  return files.sort();
}

function collectHashFiles(target, out) {
  if (!existsSync(target)) return;
  const info = statSync(target);
  if (info.isFile()) {
    if (/\.(ts|js|mjs|json|jsonc|yaml|yml|lock)$/.test(target)) out.push(target);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler" || entry.name.endsWith(".d.ts")) continue;
    collectHashFiles(resolve(target, entry.name), out);
  }
}

function workerVerificationError(reason, { deploymentSucceeded }) {
  const readable = workerHealthUserReason(reason);
  const guidance = workerVerificationGuidance(reason);
  const message = deploymentSucceeded
    ? `Cloudflare reported the Worker deployment succeeded, but ${readable}. The deployment fingerprint was saved, so retrying will verify the same Worker instead of deploying again. ${guidance}`
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
