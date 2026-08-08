import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWrangler } from "./shell.mjs";
import { saveState } from "./state.mjs";
import { packageRoot } from "./package-identity.mjs";
import { withWorkerSecretsFile } from "./worker-secret-file.mjs";
import { workerDeploymentFingerprint } from "./worker-deployment-fingerprint.mjs";
export { workerDeploymentFingerprint } from "./worker-deployment-fingerprint.mjs";
import {
  normalizeWorkerOrigin,
  retryWorkerHealth,
  workerHealthRequiresRedeploy,
  workerHealthUserReason,
} from "./worker-health.mjs";

const DEFAULT_DEPLOYMENT_HEALTH_ATTEMPTS = 20;

export async function ensureWorkerDeployment(state, args = {}, options = {}) {
  const logger = options.logger || console;
  const expectedVersion = options.expectedVersion || currentPackageVersion(options.packageRoot || packageRoot);
  const desiredHash = workerDeploymentFingerprint(state, { packageRoot: options.packageRoot || packageRoot });
  const runWranglerFn = options.runWrangler || runWrangler;
  const wranglerStateRoot = options.stateRoot || state.paths?.stateRoot;
  const saveStateFn = options.saveState || saveState;
  const retryHealthFn = options.retryHealth || retryWorkerHealth;
  const withSecretsFileFn = options.withSecretsFile || withWorkerSecretsFile;
  const healthOptions = { expectedWorkerName: state.worker.name, ...(options.healthOptions || {}) };
  const complete = hasCompleteWorkerState(state.worker);

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

  logger.info?.("Checking Cloudflare Wrangler login");
  const whoami = await runWranglerFn(["whoami"], { capture: true, allowFailure: true, stateRoot: wranglerStateRoot });
  if (whoami.code !== 0) {
    logger.info?.("Wrangler is not logged in; opening Cloudflare login");
    await runWranglerFn(["login"], { stateRoot: wranglerStateRoot });
  }

  logger.info?.("Deploying Cloudflare Worker");
  const deploy = await withSecretsFileFn(state, secretFile => runWranglerFn([
    "deploy",
    "--name", state.worker.name,
    "--minify",
    "--keep-vars",
    "--secrets-file", secretFile,
  ], { capture: true, stateRoot: wranglerStateRoot }));

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

  const health = await retryHealthFn(state.worker.url, expectedVersion, options.deploymentHealthAttempts ?? DEFAULT_DEPLOYMENT_HEALTH_ATTEMPTS, healthOptions);
  if (!health.ok) {
    logger.debug?.("Worker post-deployment health detail", { health_error: health.error, network_route: health.networkRoute || "unknown" });
    throw workerVerificationError(health.error, { deploymentSucceeded: true });
  }
  logger.success?.("Worker ready", { version: health.version });
  logger.debug?.("Worker health route", { network_route: health.networkRoute || "unknown" });
  return state.worker;
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
