import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceIdentity, deviceKeyId } from "../src/local/state/device-identity.mjs";
import {
  deviceRootProviderStatus,
  ensurePreferredDeviceRoot,
  validateDeviceRootIdentity,
} from "../src/local/state/device-root-provider.mjs";
import { promotePendingDeviceIdentity, redactState } from "../src/local/state/state.mjs";

test("device root provider selects portable vs Secure Enclave roots and redacts state", async () => {
  const existing = createDeviceIdentity();
  const retained = await ensurePreferredDeviceRoot({
    platform: "darwin",
    existing,
    env: {},
  });
  assert(retained === existing, "macOS startup replaced a portable root without a provisioned broker");

  const enrolled = await ensurePreferredDeviceRoot({ platform: "darwin", env: {} });
  assert(enrolled.provider === undefined && enrolled.privateJwk?.d, "macOS startup without a broker did not create a portable root");
  validateDeviceRootIdentity(enrolled);

  const rotated = await ensurePreferredDeviceRoot({
    platform: "darwin",
    existing,
    rotate: true,
    env: {},
  });
  assert(rotated.keyId !== existing.keyId, "portable root rotation reused the existing key");
  validateDeviceRootIdentity(rotated);

  let secureFactoryInput = null;
  const secureResult = { marker: "secure-result" };
  const dispatched = await ensurePreferredDeviceRoot({
    platform: "darwin",
    existing,
    brokerPath: "/Applications/Machine Bridge Trust Broker.app/Contents/MacOS/machine-bridge-trust-broker",
    workspaceHash: "a".repeat(24),
    secureRootFactory: async (input) => {
      secureFactoryInput = input;
      return secureResult;
    },
  });
  assert(dispatched === secureResult, "explicit provisioned broker did not select the Secure Enclave provider");
  assert(secureFactoryInput?.existing === existing, "Secure Enclave provider lost the existing root during migration");
  assert(secureFactoryInput?.brokerPath.startsWith("/Applications/"), "Secure Enclave provider lost the configured broker path");

  await assert.rejects(
    () => ensurePreferredDeviceRoot({ platform: "darwin", existing, env: { MBM_MACOS_TRUST_BROKER: "relative/broker" } }),
    /absolute path/,
  );

  const secureIdentity = {
    scheme: "device-signature-v1",
    provider: "macos-secure-enclave-v1",
    brokerProtocol: 1,
    brokerPath: "/Applications/Machine Bridge Trust Broker.app/Contents/MacOS/machine-bridge-trust-broker",
    brokerIdentifier: "com.machine-bridge-mcp.trust-broker",
    brokerTeamIdentifier: "ABCDEFGHIJ",
    keyTag: "com.machine-bridge-mcp.device.test.secure-root",
    publicJwk: existing.publicJwk,
    keyId: deviceKeyId(existing.publicJwk),
    createdAt: new Date().toISOString(),
  };
  validateDeviceRootIdentity(secureIdentity);
  let reusedSecurePath = "";
  const reusedSecure = await ensurePreferredDeviceRoot({
    platform: "darwin",
    existing: secureIdentity,
    env: {},
    secureRootFactory: async ({ brokerPath }) => {
      reusedSecurePath = brokerPath;
      return secureIdentity;
    },
  });
  assert(reusedSecure === secureIdentity, "existing Secure Enclave root was not retained");
  assert(reusedSecurePath === secureIdentity.brokerPath, "existing Secure Enclave root lost its enrolled broker binding");

  const portableStatus = deviceRootProviderStatus(existing, { env: {} });
  assert.equal(portableStatus.provider, "portable-jwk-v1");
  assert.equal(portableStatus.private_key_exportable, true);
  assert.equal(portableStatus.broker_provisioned, false);
  assert.match(portableStatus.secure_enclave_enrollment, /provisioning-profile-validated/,
    "portable provider status omitted the Secure Enclave requirement");

  const secureStatus = deviceRootProviderStatus(secureIdentity, { env: {} });
  assert.equal(secureStatus.provider, "macos-secure-enclave-v1");
  assert(secureStatus.private_key_exportable === false && secureStatus.broker_provisioned === true,
    "Secure Enclave provider status lost its trust properties");

  const rotationState = {
    worker: {
      deviceIdentity: secureIdentity,
      pendingDeviceIdentity: rotated,
      oauthTokenVersion: "token_version_test",
    },
    resources: {},
  };
  assert(promotePendingDeviceIdentity(rotationState), "pending device root was not promoted");
  const retiredSecureRoot = rotationState.worker.previousDeviceIdentities?.[0];
  assert.equal(retiredSecureRoot?.brokerProtocol, secureIdentity.brokerProtocol);
  assert.equal(retiredSecureRoot?.brokerPath, secureIdentity.brokerPath);
  assert.equal(retiredSecureRoot?.brokerIdentifier, secureIdentity.brokerIdentifier);
  assert.equal(retiredSecureRoot?.brokerTeamIdentifier, secureIdentity.brokerTeamIdentifier);

  const redacted = redactState(rotationState);
  assert.equal(redacted.worker.previousDeviceIdentities[0].brokerPath, "<local-broker-path>");
  assert.equal(redacted.worker.oauthTokenVersion, "<redacted>");
});
