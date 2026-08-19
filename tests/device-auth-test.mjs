import {
  createDaemonAuthentication,
  createDaemonPreflightHeaders,
  createDeviceIdentity,
  createDeviceSessionIdentity,
  deviceKeyId,
  publicDeviceJwkJson,
  validateDeviceIdentity,
  validateDeviceSessionIdentity,
} from "../src/local/device-identity.mjs";
import { consumeDaemonPreflightNonce, createDaemonChallenge, sanitizeDaemonChallengeAttachment, verifyDaemonAuthentication, verifyDaemonPreflight } from "../src/worker/daemon-auth.ts";
import { consumeBoundedNonce } from "../src/worker/nonce-store.ts";

const workerOrigin = "https://bridge.example.com";
const server = "machine-bridge-mcp";
const version = "3.0.0";
const instanceId = `daemon_${"a".repeat(24)}`;
const issuedAt = 1_800_000_000;
const rootIdentity = createDeviceIdentity();
const sessionIdentity = createDeviceSessionIdentity(rootIdentity, workerOrigin, server, version, issuedAt * 1000);
const historicalIssuedAt = 1_700_000_000;
const historicalSessionIdentity = createDeviceSessionIdentity(rootIdentity, workerOrigin, server, version, historicalIssuedAt * 1000);

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(structuredClone(initial))); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
}

assert(validateDeviceIdentity(rootIdentity) === rootIdentity, "generated root device identity did not validate");
assert(validateDeviceSessionIdentity(sessionIdentity, issuedAt * 1000) === sessionIdentity, "generated session device identity did not validate");
assert(validateDeviceSessionIdentity(historicalSessionIdentity, historicalIssuedAt * 1000) === historicalSessionIdentity,
  "synthetic historical device-session creation ignored its explicit clock during finalization");
const historicalPreflightHeaders = new Headers(createDaemonPreflightHeaders(
  historicalSessionIdentity, workerOrigin, server, version, historicalIssuedAt * 1000,
));
assert(historicalPreflightHeaders.get("X-Bridge-Device-Certificate"),
  "synthetic historical preflight switched back to real wall time while encoding the session certificate");
assert(rootIdentity.keyId === deviceKeyId(rootIdentity.publicJwk), "root device key id was not deterministic");
assert(sessionIdentity.keyId === deviceKeyId(sessionIdentity.publicJwk), "session device key id was not deterministic");
assert(rootIdentity.keyId !== sessionIdentity.keyId, "session identity reused the long-term root key");
const rootPublicJson = publicDeviceJwkJson(rootIdentity);
assert(!rootPublicJson.includes('"d"'), "Worker root public-key material contained the private scalar");

const preflightHeaders = new Headers(createDaemonPreflightHeaders(sessionIdentity, workerOrigin, server, version, issuedAt * 1000));
const preflight = await verifyDaemonPreflight({
  publicKeyJson: rootPublicJson,
  headers: preflightHeaders,
  workerOrigin,
  server,
  version,
  now: issuedAt,
});
assert(preflight, "valid session-certificate preflight was rejected");
assert(preflight.sessionKeyId === sessionIdentity.keyId, "preflight lost the ephemeral session key identity");
assert(!preflight.sessionPublicKeyJson.includes('"d"'), "preflight returned session private-key material");

const preflightStorage = new MemoryStorage();
assert(await consumeDaemonPreflightNonce(preflightStorage, preflight, issuedAt), "fresh daemon preflight nonce was rejected");
assert(!await consumeDaemonPreflightNonce(preflightStorage, preflight, issuedAt + 1), "daemon preflight nonce replay was accepted");
const malformedPreflightStorage = new MemoryStorage({ "daemon-preflight-nonces": { invalid: "value" } });
assert(!await consumeDaemonPreflightNonce(malformedPreflightStorage, preflight, issuedAt), "malformed daemon preflight nonce state was silently reset");

const capacityStorage = new MemoryStorage({
  "bounded-nonces": { ["a".repeat(24)]: issuedAt + 300, ["b".repeat(24)]: issuedAt + 300 },
});
assert(!await consumeBoundedNonce(capacityStorage, {
  key: "bounded-nonces", nonce: "c".repeat(24), expiresAt: issuedAt + 300, now: issuedAt,
  noncePattern: /^[a-z]{24}$/, maximum: 2, maxFutureSeconds: 600,
}), "nonce capacity evicted an unexpired replay marker");
const retainedCapacityState = await capacityStorage.get("bounded-nonces");
assert(retainedCapacityState["a".repeat(24)] && retainedCapacityState["b".repeat(24)] && !retainedCapacityState["c".repeat(24)], "nonce capacity changed existing replay markers");
const oversizedCapacityStorage = new MemoryStorage({
  "bounded-nonces": {
    ["a".repeat(24)]: issuedAt - 1,
    ["b".repeat(24)]: issuedAt - 1,
    ["c".repeat(24)]: issuedAt - 1,
  },
});
assert(!await consumeBoundedNonce(oversizedCapacityStorage, {
  key: "bounded-nonces", nonce: "d".repeat(24), expiresAt: issuedAt + 300, now: issuedAt,
  noncePattern: /^[a-z]{24}$/, maximum: 2, maxFutureSeconds: 600,
}), "oversized persisted nonce state was normalized past its read-boundary cardinality cap");
assert(Object.keys(await oversizedCapacityStorage.get("bounded-nonces")).length === 3,
  "invalid oversized nonce state was silently rewritten instead of failing closed");
const farFutureStorage = new MemoryStorage({
  "bounded-nonces": { ["a".repeat(24)]: issuedAt + 601 },
});
assert(!await consumeBoundedNonce(farFutureStorage, {
  key: "bounded-nonces", nonce: "b".repeat(24), expiresAt: issuedAt + 300, now: issuedAt,
  noncePattern: /^[a-z]{24}$/, maximum: 2, maxFutureSeconds: 600,
}), "persisted nonce expiry beyond the protocol replay horizon was accepted");
let farFutureWriteRejected = false;
try {
  await consumeBoundedNonce(new MemoryStorage(), {
    key: "bounded-nonces", nonce: "b".repeat(24), expiresAt: issuedAt + 601, now: issuedAt,
    noncePattern: /^[a-z]{24}$/, maximum: 2, maxFutureSeconds: 600,
  });
} catch (error) {
  farFutureWriteRejected = error instanceof Error && error.message.includes("expiration is invalid");
}
assert(farFutureWriteRejected, "nonce store allowed a new replay marker beyond its declared future horizon");

const tamperedPreflight = new Headers(preflightHeaders);
tamperedPreflight.set("X-Bridge-Device-Nonce", `${tamperedPreflight.get("X-Bridge-Device-Nonce")}x`);
assert(!await verifyDaemonPreflight({ publicKeyJson: rootPublicJson, headers: tamperedPreflight, workerOrigin, server, version, now: issuedAt }), "tampered session preflight was accepted");

const tamperedCertificateHeaders = new Headers(preflightHeaders);
const encodedCertificate = tamperedCertificateHeaders.get("X-Bridge-Device-Certificate");
const certificate = JSON.parse(Buffer.from(encodedCertificate, "base64url").toString("utf8"));
certificate.signature = mutate(certificate.signature);
tamperedCertificateHeaders.set("X-Bridge-Device-Certificate", Buffer.from(JSON.stringify(certificate)).toString("base64url"));
assert(!await verifyDaemonPreflight({ publicKeyJson: rootPublicJson, headers: tamperedCertificateHeaders, workerOrigin, server, version, now: issuedAt }), "tampered root-signed session certificate was accepted");

const otherRoot = createDeviceIdentity();
assert(!await verifyDaemonPreflight({ publicKeyJson: publicDeviceJwkJson(otherRoot), headers: preflightHeaders, workerOrigin, server, version, now: issuedAt }), "session certificate was accepted under another enrolled root");
assert(!await verifyDaemonPreflight({ publicKeyJson: rootPublicJson, headers: preflightHeaders, workerOrigin, server, version: "3.0.1", now: issuedAt }), "session certificate was reusable for another package version");
assert(!await verifyDaemonPreflight({ publicKeyJson: rootPublicJson, headers: preflightHeaders, workerOrigin, server, version, now: issuedAt + 24 * 60 * 60 + 1 }), "expired device session certificate was accepted");
let localExpiryError = null;
try { validateDeviceSessionIdentity(sessionIdentity, (issuedAt + 24 * 60 * 60 + 1) * 1000); } catch (error) { localExpiryError = error; }
assert(localExpiryError?.code === "device_session_expired",
  "expired local device session did not expose the stable supervised-restart error code");

const challenge = createDaemonChallenge(workerOrigin, issuedAt);
const sanitizedAttachment = sanitizeDaemonChallengeAttachment({
  authChallenge: challenge.challenge,
  authIssuedAt: challenge.issuedAt,
  authExpiresAt: challenge.expiresAt,
  workerOrigin,
  authSessionPublicKeyJson: preflight.sessionPublicKeyJson,
  authSessionKeyId: preflight.sessionKeyId,
  authCertificateExpiresAt: preflight.certificateExpiresAt,
});
assert(sanitizedAttachment.authChallenge === challenge.challenge, "valid daemon challenge attachment was not retained");
assert(sanitizedAttachment.authSessionKeyId === preflight.sessionKeyId, "valid session key attachment was not retained");
assert(sanitizedAttachment.authCertificateExpiresAt === preflight.certificateExpiresAt, "valid certificate expiry attachment was not retained");
const rejectedAttachment = sanitizeDaemonChallengeAttachment({
  authChallenge: "bad",
  authIssuedAt: -1,
  authExpiresAt: 0,
  workerOrigin: "http://remote.example.com",
  authSessionPublicKeyJson: "{}",
  authSessionKeyId: "bad",
  authCertificateExpiresAt: Number.NaN,
});
assert(Object.values(rejectedAttachment).every((value) => value === undefined), "invalid daemon challenge attachment was not rejected field-by-field");
const welcome = {
  type: "welcome", server, version, worker_origin: workerOrigin,
  authentication: { scheme: challenge.scheme, challenge: challenge.challenge, issued_at: challenge.issuedAt, expires_at: challenge.expiresAt },
};
const authentication = await createDaemonAuthentication(sessionIdentity, welcome, instanceId);
assert(await verifyDaemonAuthentication({
  publicKeyJson: preflight.sessionPublicKeyJson,
  authentication,
  challenge,
  server,
  version,
  instanceId,
  certificateExpiresAt: preflight.certificateExpiresAt,
  now: issuedAt + 1,
}), "valid ephemeral session challenge signature was rejected");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: rootPublicJson,
  authentication,
  challenge,
  server,
  version,
  instanceId,
  certificateExpiresAt: preflight.certificateExpiresAt,
  now: issuedAt + 1,
}), "ephemeral daemon authentication was accepted under the long-term root key");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: preflight.sessionPublicKeyJson,
  authentication: { ...authentication, signature: mutate(authentication.signature) },
  challenge,
  server,
  version,
  instanceId,
  certificateExpiresAt: preflight.certificateExpiresAt,
  now: issuedAt + 1,
}), "tampered session challenge signature was accepted");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: preflight.sessionPublicKeyJson,
  authentication,
  challenge,
  server,
  version,
  instanceId: `${instanceId}x`,
  certificateExpiresAt: preflight.certificateExpiresAt,
  now: issuedAt + 1,
}), "session signature was reusable for another daemon instance");
assert(!await verifyDaemonAuthentication({
  publicKeyJson: preflight.sessionPublicKeyJson,
  authentication,
  challenge,
  server,
  version,
  instanceId,
  certificateExpiresAt: issuedAt,
  now: issuedAt + 1,
}), "expired session certificate remained valid for challenge authentication");

console.log("root-certified ephemeral device session test ok");

function mutate(value) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
