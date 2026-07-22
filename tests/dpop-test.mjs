import { webcrypto } from "node:crypto";
import { consumeDpopProof, jwkThumbprint, normalizedHtu, verifyDpopProof } from "../src/worker/dpop.ts";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
}

const now = 1_800_000_000;
const endpoint = "https://bridge.example.com/mcp?ignored=query";
const token = `mcp_at_${"t".repeat(43)}`;
const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await webcrypto.subtle.exportKey("jwk", keys.privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
const jkt = await jwkThumbprint(publicJwk);
const storage = new MemoryStorage();

const validProof = await createProof({ privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now, jti: "proof-valid-1234567890", accessToken: token });
const request = new Request(endpoint, {
  method: "POST",
  headers: { Authorization: `DPoP ${token}`, DPoP: validProof },
});
const verified = await verifyDpopProof({ request, accessToken: token, expectedJkt: jkt, now });
assert(verified?.jkt === jkt, "valid DPoP proof was rejected");
assert(await storage.get("dpop-proof-jtis") === undefined, "cryptographic DPoP validation consumed replay capacity before authorization");
assert(await consumeDpopProof(storage, verified, now), "authorized DPoP proof was not consumed");
const replay = await verifyDpopProof({ request, accessToken: token, expectedJkt: jkt, now: now + 1 });
assert(replay && !await consumeDpopProof(storage, replay, now + 1), "DPoP jti replay was accepted");

const wrongMethodProof = await createProof({ privateJwk, publicJwk, htm: "GET", htu: endpoint, iat: now, jti: "proof-method-123456789", accessToken: token });
assert(await verifyDpopProof({
  request: new Request(endpoint, { method: "POST", headers: { DPoP: wrongMethodProof } }),
  accessToken: token, expectedJkt: jkt, now,
}) === null, "DPoP proof was reusable under another HTTP method");

const wrongTokenProof = await createProof({ privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now, jti: "proof-token-1234567890", accessToken: "different-token" });
assert(await verifyDpopProof({
  request: new Request(endpoint, { method: "POST", headers: { DPoP: wrongTokenProof } }),
  accessToken: token, expectedJkt: jkt, now,
}) === null, "DPoP proof was reusable for another access token");

const otherKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const otherPublicJwk = await webcrypto.subtle.exportKey("jwk", otherKeys.publicKey);
assert(await verifyDpopProof({
  request: new Request(endpoint, { method: "POST", headers: { DPoP: await createProof({ privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now, jti: "proof-key-123456789012", accessToken: token }) } }),
  accessToken: token, expectedJkt: await jwkThumbprint(otherPublicJwk), now,
}) === null, "DPoP proof was accepted under another bound key");

const criticalProof = await createProof({ privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now, jti: "proof-critical-12345678", accessToken: token, headerExtra: { crit: ["b64"], b64: false } });
assert(await verifyDpopProof({ request: new Request(endpoint, { method: "POST", headers: { DPoP: criticalProof } }), accessToken: token, expectedJkt: jkt, now }) === null, "DPoP accepted unsupported critical JWS semantics");

assert(normalizedHtu(endpoint) === "https://bridge.example.com/mcp", "DPoP htu normalization retained query data");
console.log("DPoP proof test ok");

async function createProof({ privateJwk, publicJwk, htm, htu, iat, jti, accessToken, headerExtra = {} }) {
  const header = base64Url(Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk, ...headerExtra })));
  const payload = {
    htm,
    htu: normalizedHtu(htu),
    iat,
    jti,
    ...(accessToken ? { ath: await sha256Base64Url(accessToken) } : {}),
  };
  const encodedPayload = base64Url(Buffer.from(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${header}.${encodedPayload}`));
  return `${header}.${encodedPayload}.${base64Url(Buffer.from(signature))}`;
}

async function sha256Base64Url(value) {
  return base64Url(Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(value))));
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
