import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDeviceIdentity, deviceKeyId, validateDeviceIdentity } from "../src/local/state/device-identity.mjs";
import { publicKeyId as workerDeviceKeyId } from "../src/worker/oauth/device-session-verifier.ts";

test("version 3 preserves version 2 device key id persistence format across local and worker", async () => {
  const identity = createDeviceIdentity();
  const publicJwk = identity.publicJwk;
  const version2KeyId = `device_${createHash("sha256")
    .update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
    .digest("base64url")
    .slice(0, 32)}`;

  assert.equal(deviceKeyId(publicJwk), version2KeyId, "version 3 changed the persisted version 2 device key id algorithm");
  assert.equal(await workerDeviceKeyId(publicJwk), version2KeyId, "Worker and daemon device key id algorithms diverged from version 2");
  assert.equal(validateDeviceIdentity({ ...identity, keyId: version2KeyId }).keyId, version2KeyId, "a valid persisted version 2 identity was rejected");

  const wrongOrderKeyId = `device_${createHash("sha256")
    .update(JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }))
    .digest("base64url")
    .slice(0, 32)}`;
  if (wrongOrderKeyId !== version2KeyId) {
    assert.throws(
      () => validateDeviceIdentity({ ...identity, keyId: wrongOrderKeyId }),
      /device identity key id is invalid/,
    );
  }
});
