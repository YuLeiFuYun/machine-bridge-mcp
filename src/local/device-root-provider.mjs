import {
  createDeviceIdentity,
  createDeviceSessionDraft,
  createDeviceSessionIdentity,
  finalizeDeviceSessionIdentity,
  validateDeviceIdentity,
  validatePublicDeviceRoot,
} from "./device-identity.mjs";
import {
  configuredMacosTrustBrokerPath,
  ensureMacosSecureDeviceRoot,
  isMacosSecureDeviceRoot,
  signWithMacosSecureDeviceRoot,
} from "./macos-trust-broker.mjs";

export function validateDeviceRootIdentity(identity) {
  if (isMacosSecureDeviceRoot(identity)) return identity;
  return validateDeviceIdentity(identity);
}

export async function ensurePreferredDeviceRoot({
  profileDir,
  workspaceHash,
  existing = null,
  rotate = false,
  platform = process.platform,
  brokerPath = undefined,
  env = process.env,
  secureRootFactory = ensureMacosSecureDeviceRoot,
} = {}) {
  const configuredBroker = brokerPath === undefined ? configuredMacosTrustBrokerPath(env) : brokerPath;
  const selectedBroker = configuredBroker || (isMacosSecureDeviceRoot(existing) ? existing.brokerPath : null);
  if (platform === "darwin" && selectedBroker) {
    return secureRootFactory({
      profileDir,
      workspaceHash,
      existing,
      rotate,
      brokerPath: selectedBroker,
    });
  }
  if (!rotate && existing) return validateDeviceRootIdentity(existing);
  return createDeviceIdentity();
}

export async function createDeviceSessionForRoot(identity, workerOrigin, server, version, {
  profileDir,
  now = Date.now(),
  reason = "Authorize Machine Bridge startup",
} = {}) {
  if (!isMacosSecureDeviceRoot(identity)) return createDeviceSessionIdentity(validateDeviceIdentity(identity), workerOrigin, server, version, now);
  validatePublicDeviceRoot(identity);
  const draft = createDeviceSessionDraft(identity, workerOrigin, server, version, now);
  const signature = signWithMacosSecureDeviceRoot(identity, draft.transcript, { profileDir, reason });
  return finalizeDeviceSessionIdentity(draft, signature);
}

export function deviceRootProviderStatus(identity, { env = process.env } = {}) {
  if (isMacosSecureDeviceRoot(identity)) {
    return {
      provider: identity.provider,
      private_key_exportable: false,
      root_storage: "Secure Enclave",
      broker_provisioned: true,
      session_signing: "one user-presence operation per daemon start",
      reconnect_signing: "ephemeral in-memory key",
      key_id: identity.keyId,
    };
  }
  validateDeviceIdentity(identity);
  return {
    provider: "portable-jwk-v1",
    private_key_exportable: true,
    root_storage: "owner-only local state",
    broker_provisioned: Boolean(String(env?.MBM_MACOS_TRUST_BROKER || "").trim()),
    secure_enclave_enrollment: "requires a provisioning-profile-validated app-like broker configured through MBM_MACOS_TRUST_BROKER",
    session_signing: "local file-backed root",
    reconnect_signing: "ephemeral in-memory key",
    key_id: identity.keyId,
  };
}
