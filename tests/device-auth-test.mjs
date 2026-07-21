import {
  createDaemonAuthentication,
  createDaemonPreflightHeaders,
  createDeviceIdentity,
  deviceKeyId,
  publicDeviceJwkJson,
  validateDeviceIdentity,
} from "../src/local/device-identity.mjs";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "../src/worker/daemon-auth.ts";

const workerOrigin = "https://bridge.example.com";
const server = "machine-bridge-mcp";
const version = "2.0.0";
const instanceId = `daemon_${"a".repeat(24)}`;
const issuedAt = 1_800_000_000;
const identity = createDeviceIdentity();

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(structuredClone(initial)));
  }

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

assert(validateDeviceIdentity(identity) === identity, "generated device identity did not validate");
assert(identity.keyId === deviceKeyId(identity.publicJwk), "device key id was not deterministic");
const publicJson = publicDeviceJwkJson(identity);
assert(!publicJson.includes('"d"'), "Worker public-key material contained the device private scalar");

const preflightHeaders = new Headers(createDaemonPreflightHeaders(identity, workerOrigin, server, version, issuedAt * 1000));
const preflight = await verifyDaemonPreflight({
  publicKeyJson: publicJson,
  headers: preflightHeaders,
  workerOrigin,
  server,
  version,
  now: issuedAt,
});
assert(preflight, "valid device preflight signature was rejected");
const preflightStorage = new MemoryStorage();
assert(await consumeDaemonPreflightNonce(preflightStorage, preflight, issuedAt), "fresh daemon preflight nonce was rejected");
assert(!await consumeDaemonPreflightNonce(preflightStorage, preflight, issuedAt + 1), "daemon preflight nonce replay was accepted");
const malformedPreflightStorage = new MemoryStorage({ "daemon-preflight-nonces": { invalid: "value" } });
assert(!await consumeDaemonPreflightNonce(malformedPreflightStorage, preflight, issuedAt), "malformed daemon preflight nonce state was silently reset");
const tamperedPreflight = new Headers(preflightHeaders);
tamperedPreflight.set("X-Bridge-Device-Nonce", `${tamperedPreflight.get("X-Bridge-Device-Nonce")}x`);
assert(!await verifyDaemonPreflight({
  publicKeyJson: publicJson,
  headers: tamperedPreflight,
  workerOrigin,
  server,
  version,
  now: issuedAt,
}), "tampered device preflight was accepted");
assert(!await verifyDaemonPreflight({
  publicKeyJson: publicJson,
  headers: preflightHeaders,
  workerOrigin,
  server,
  version,
  now: issuedAt + 301,
}), "expired device preflight was accepted");

const challenge = createDaemonChallenge(workerOrigin, issuedAt);
const welcome = {
  type: "welcome",
  server,
  version,
  worker_origin: workerOrigin,
  authentication: {
    scheme: challenge.scheme,
    challenge: challenge.challenge,
    issued_at: challenge.issuedAt,
    expires_at: challenge.expiresAt,
  },
};
const authentication = await createDaemonAuthentication(identity, welcome, instanceId);
assert(await verifyDaemonAuthentication({
  publicKeyJson: publicJson,
  authentication,
  challenge,
  server,
  version,
  instanceId,
  now: issuedAt + 1,
}), "valid device challenge signature was rejected");

assert(!await verifyDaemonAuthentication({
  publicKeyJson: publicJson,
  authentication: { ...authentication, signature: mutate(authentication.signature) },
  challenge,
  server,
  version,
  instanceId,
  now: issuedAt + 1,
}), "tampered device signature was accepted");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: publicJson,
  authentication,
  challenge,
  server,
  version,
  instanceId: `${instanceId}x`,
  now: issuedAt + 1,
}), "device signature was reusable for another daemon instance");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: publicJson,
  authentication,
  challenge,
  server,
  version,
  instanceId,
  now: challenge.expiresAt + 1,
}), "expired device challenge was accepted");

const otherIdentity = createDeviceIdentity();
assert(!await verifyDaemonAuthentication({
  publicKeyJson: publicDeviceJwkJson(otherIdentity),
  authentication,
  challenge,
  server,
  version,
  instanceId,
  now: issuedAt + 1,
}), "device signature was accepted under another enrolled public key");

console.log("device authentication test ok");


function mutate(value) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
