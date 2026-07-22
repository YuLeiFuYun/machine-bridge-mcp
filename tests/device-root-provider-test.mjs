import { createDeviceIdentity, deviceKeyId } from "../src/local/device-identity.mjs";
import {
  deviceRootProviderStatus,
  ensurePreferredDeviceRoot,
  validateDeviceRootIdentity,
} from "../src/local/device-root-provider.mjs";
import { promotePendingDeviceIdentity, redactState } from "../src/local/state.mjs";

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

await expectReject(
  () => ensurePreferredDeviceRoot({ platform: "darwin", existing, env: { MBM_MACOS_TRUST_BROKER: "relative/broker" } }),
  "absolute path",
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
assert(portableStatus.provider === "portable-jwk-v1", "portable provider status is incorrect");
assert(portableStatus.private_key_exportable === true, "portable provider status hid private-key exportability");
assert(portableStatus.broker_provisioned === false, "portable provider status reported an unconfigured broker");
assert(portableStatus.secure_enclave_enrollment.includes("provisioning-profile-validated"), "portable provider status omitted the Secure Enclave requirement");

const secureStatus = deviceRootProviderStatus(secureIdentity, { env: {} });
assert(secureStatus.provider === "macos-secure-enclave-v1", "Secure Enclave provider status is incorrect");
assert(secureStatus.private_key_exportable === false && secureStatus.broker_provisioned === true, "Secure Enclave provider status lost its trust properties");

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
assert(retiredSecureRoot?.brokerProtocol === secureIdentity.brokerProtocol, "retired Secure Enclave root lost its broker protocol");
assert(retiredSecureRoot?.brokerPath === secureIdentity.brokerPath, "retired Secure Enclave root lost its broker path");
assert(retiredSecureRoot?.brokerIdentifier === secureIdentity.brokerIdentifier, "retired Secure Enclave root lost its broker identifier");
assert(retiredSecureRoot?.brokerTeamIdentifier === secureIdentity.brokerTeamIdentifier, "retired Secure Enclave root lost its broker Team ID");

const redacted = redactState(rotationState);
assert(redacted.worker.previousDeviceIdentities[0].brokerPath === "<local-broker-path>", "redacted state exposed a retired broker path");
assert(redacted.worker.oauthTokenVersion === "<redacted>", "redacted state exposed the deployment token version");

console.log("device root provider selection test ok");

async function expectReject(callback, fragment) {
  try {
    await callback();
  } catch (error) {
    assert(String(error?.message || error).includes(fragment), `unexpected rejection: ${error?.message || error}`);
    return;
  }
  throw new Error(`expected rejection containing ${fragment}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
