import { createDeviceIdentity } from "../src/local/device-identity.mjs";
import { redactState } from "../src/local/state.mjs";
import { supportStateProjection } from "../src/local/support-state-projection.mjs";

export function runStateRedactionPrivacyTest() {
  const active = decorate(createDeviceIdentity(), "active");
  const pending = decorate(createDeviceIdentity(), "pending");
  const retiredSource = decorate(createDeviceIdentity(), "retired");
  const state = {
    worker: {
      url: "https://worker.example.invalid",
      mcpServerUrl: "https://worker.example.invalid/mcp",
      name: "synthetic-worker-name",
      deviceIdentity: active,
      pendingDeviceIdentity: pending,
      previousDeviceIdentities: [{
        scheme: retiredSource.scheme,
        publicJwk: retiredSource.publicJwk,
        keyId: retiredSource.keyId,
        createdAt: retiredSource.createdAt,
        keyTag: retiredSource.keyTag,
        brokerPath: retiredSource.brokerPath,
      }],
      oauthTokenVersion: "synthetic-token-version",
    },
    resources: {},
  };

  const activePrivateBefore = state.worker.deviceIdentity.privateJwk.d;
  const redacted = redactState(state);
  for (const identity of [
    redacted.worker.deviceIdentity,
    redacted.worker.pendingDeviceIdentity,
    ...redacted.worker.previousDeviceIdentities,
  ]) {
    assert(!identity.privateJwk && !identity.publicJwk, "redacted state exposed device JWK material");
    assert(identity.keyTag === "<local-key-tag>", "redacted state exposed a stable local key tag");
    assert(identity.brokerPath === "<local-broker-path>", "redacted state exposed a local broker path");
    assert(typeof identity.keyId === "string" && identity.keyId.length > 0, "redacted state removed the diagnostic device key id");
  }
  assert(redacted.worker.oauthTokenVersion === "<redacted>", "redacted state exposed the deployment token version");
  assert(state.worker.deviceIdentity.privateJwk.d === activePrivateBefore && state.worker.deviceIdentity.publicJwk,
    "redactState mutated the persisted device identity instead of a projection copy");

  const support = supportStateProjection({ ...state, schemaVersion: 5, policy: { profile: "full", origin: "explicit", revision: 5 } });
  const supportJson = JSON.stringify(support);
  for (const privateValue of [state.worker.url, state.worker.mcpServerUrl, state.worker.name, state.worker.deviceIdentity.keyId]) {
    assert(!supportJson.includes(privateValue), "support state projection exposed a stable local identity or endpoint");
  }
  assert(support.worker.configured === true && support.worker.endpoint_configured === true
    && support.worker.device_root_provider === "portable-jwk-v1" && support.worker.retired_device_root_count === 1,
  "support state projection removed bounded configuration facts needed for diagnosis");
  const emptySupport = supportStateProjection({});
  assert(emptySupport.schema_version === null && emptySupport.policy.profile === null
    && emptySupport.worker.configured === false && emptySupport.worker.endpoint_configured === false
    && emptySupport.worker.device_root_provider === null && emptySupport.worker.retired_device_root_count === 0
    && emptySupport.resource_count === 0,
  "support state projection did not preserve safe defaults for an incomplete state");
}

function decorate(identity, suffix) {
  return { ...identity, keyTag: `synthetic-key-${suffix}`, brokerPath: `/synthetic/${suffix}` };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
