// @ts-check

/** @typedef {{provider?: unknown}} DeviceIdentitySummaryInput */
/** @typedef {{url?: unknown, mcpServerUrl?: unknown, name?: unknown, deviceIdentity?: DeviceIdentitySummaryInput, pendingDeviceIdentity?: unknown, previousDeviceIdentities?: unknown[], oauthTokenVersion?: unknown}} WorkerSummaryInput */

/** @param {{schemaVersion?: unknown, policy?: Record<string, unknown>, worker?: WorkerSummaryInput, resources?: Record<string, unknown>}} state */
export function supportStateProjection(state) {
  const worker = state?.worker && typeof state.worker === "object" ? state.worker : {};
  const currentIdentity = worker.deviceIdentity && typeof worker.deviceIdentity === "object" ? worker.deviceIdentity : null;
  const previous = Array.isArray(worker.previousDeviceIdentities) ? worker.previousDeviceIdentities : [];
  const resources = state?.resources && typeof state.resources === "object" && !Array.isArray(state.resources) ? state.resources : {};
  const policy = state?.policy && typeof state.policy === "object" ? state.policy : {};
  return {
    schema_version: Number.isSafeInteger(state?.schemaVersion) ? state.schemaVersion : null,
    policy: {
      profile: typeof policy.profile === "string" ? policy.profile : null,
      origin: typeof policy.origin === "string" ? policy.origin : null,
      revision: Number.isSafeInteger(policy.revision) ? policy.revision : null,
    },
    worker: {
      configured: Boolean(worker.url || worker.mcpServerUrl || worker.name || currentIdentity),
      endpoint_configured: Boolean(worker.url || worker.mcpServerUrl),
      oauth_token_version_configured: Boolean(worker.oauthTokenVersion),
      device_root_provider: currentIdentity ? String(currentIdentity.provider || "portable-jwk-v1") : null,
      pending_device_root: Boolean(worker.pendingDeviceIdentity),
      retired_device_root_count: previous.length,
    },
    resource_count: Object.keys(resources).length,
  };
}
