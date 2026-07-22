import { createHash } from "node:crypto";
import { createDeviceIdentity, deviceKeyId, validateDeviceIdentity } from "../src/local/device-identity.mjs";
import { publicKeyId as workerDeviceKeyId } from "../src/worker/device-session-verifier.ts";

const identity = createDeviceIdentity();
const publicJwk = identity.publicJwk;
const version2KeyId = `device_${createHash("sha256")
  .update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
  .digest("base64url")
  .slice(0, 32)}`;

assert(deviceKeyId(publicJwk) === version2KeyId, "version 3 changed the persisted version 2 device key id algorithm");
assert(await workerDeviceKeyId(publicJwk) === version2KeyId, "Worker and daemon device key id algorithms diverged from version 2");
assert(validateDeviceIdentity({ ...identity, keyId: version2KeyId }).keyId === version2KeyId, "a valid persisted version 2 identity was rejected");

const wrongOrderKeyId = `device_${createHash("sha256")
  .update(JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }))
  .digest("base64url")
  .slice(0, 32)}`;
if (wrongOrderKeyId !== version2KeyId) {
  expectThrow(
    () => validateDeviceIdentity({ ...identity, keyId: wrongOrderKeyId }),
    "device identity key id is invalid",
  );
}

console.log("device key id backward-compatibility test ok");

function expectThrow(callback, expected) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
