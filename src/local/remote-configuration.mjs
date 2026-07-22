import { effectiveLogFormat, effectiveLogLevel } from "./cli-options.mjs";
import { resolvePolicy } from "./cli-policy.mjs";
import { ensurePreferredDeviceRoot } from "./device-root-provider.mjs";
import { createLogger } from "./log.mjs";
import {
  ensureWorkerSecrets,
  promotePendingDeviceIdentity,
  saveState,
} from "./state.mjs";
import { ensureWorkerDeployment } from "./worker-deployment.mjs";

export async function convergeRemoteConfiguration({ args, state }) {
  const workerName = validateWorkerName(args.workerName);
  ensureWorkerSecrets(state, {
    rotateSecrets: Boolean(args.rotateSecrets),
    deferDeviceRotation: true,
    workerName,
    allowWorkerRename: Boolean(args.forceWorker),
  });
  if (!state.worker.pendingDeviceIdentity) {
    const candidate = await ensurePreferredDeviceRoot({
      profileDir: state.paths.profileDir,
      workspaceHash: state.workspace.hash,
      existing: args.rotateSecrets ? null : state.worker.deviceIdentity,
      rotate: Boolean(args.rotateSecrets),
    });
    if (candidate.keyId !== state.worker.deviceIdentity.keyId) state.worker.pendingDeviceIdentity = candidate;
  }
  state.policy = resolvePolicy(args, state.policy);
  state.policy.updatedAt = new Date().toISOString();
  saveState(state);
  const logger = createLogger({
    level: args.json ? "error" : effectiveLogLevel(args),
    format: effectiveLogFormat(args),
    component: "worker",
  });
  await ensureWorkerDeployment(state, args, { logger });
  if (promotePendingDeviceIdentity(state)) saveState(state);
}

export function validateWorkerName(value) {
  if (value === undefined || value === null || value === false) return undefined;
  const name = String(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("--worker-name must be 1-63 lowercase letters, digits, or hyphens, and cannot start or end with a hyphen");
  }
  return name;
}
