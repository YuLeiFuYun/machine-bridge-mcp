import { applyResourceProfileEnv, resourceCommandEffectiveCwd, resourceCommandProfile } from "./resource-command-profile.mjs";
import { ResourceAdmissionError } from "./resource-admission.mjs";
import { BridgeError } from "./errors.mjs";
import { prepareResourceBuildCommand } from "./resource-build-root.mjs";
import { applyResourceProcessPriority } from "./resource-process-priority.mjs";

export async function acquireProcessResources(coordinator, command, args, environment, options = {}) {
  if (!coordinator) return { lease: null, environment, request: null };
  const request = resourceCommandProfile(command, args, { priority: options.priority, environment });
  const resourceCwd = resourceCommandEffectiveCwd(command, args, options.cwd, request);
  let lease;
  try {
    lease = await coordinator.acquire(request, {
      cwd: resourceCwd,
      waitMs: options.waitMs,
      signal: options.signal,
      cancelCheck: options.cancelCheck,
    });
  } catch (error) {
    const transactionBusy = error?.code === "MBM_RESOURCE_TRANSACTION_BUSY";
    if (!(error instanceof ResourceAdmissionError) && !transactionBusy) throw error;
    const decision = error instanceof ResourceAdmissionError ? error.decision : { state: "unknown", reason: "coordinator_busy" };
    throw new BridgeError("unavailable", "local heavy-resource capacity is temporarily unavailable", {
      retryable: true,
      details: {
        reason: "resource_admission",
        pressure_state: decision?.state || "unknown",
        admission_reason: decision?.reason || "resource_busy",
      },
    });
  }
  const effectiveRequest = lease?.request ? { ...request, ...lease.request } : request;
  try {
    const buildRoot = environment?.AGENT_BUILD_ROOT || process.env.AGENT_BUILD_ROOT || "";
    const prepared = prepareResourceBuildCommand(
      command, args, applyResourceProfileEnv(environment, effectiveRequest), effectiveRequest, resourceCwd,
      buildRoot ? { root: buildRoot } : {},
    );
    const prioritized = applyResourceProcessPriority(prepared.command, prepared.args, effectiveRequest);
    return { lease, request: effectiveRequest, ...prepared, ...prioritized };
  } catch (error) {
    await releaseProcessResources(lease);
    throw error;
  }
}

export function bindProcessResources(lease, child) {
  return lease?.bindProcess?.(child, { processGroupIsolated: process.platform !== "win32" }) ?? Promise.resolve();
}

export function releaseProcessResources(lease) {
  return lease?.release?.() ?? Promise.resolve(false);
}

export async function releaseProcessResourcesQuietly(lease) {
  try { return await releaseProcessResources(lease); }
  catch { return false; }
}
