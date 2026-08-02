import { webcrypto } from "node:crypto";
import {
  consumeDpopProof, consumeDpopProofForInternalRetry, jwkThumbprint, normalizedHtu, verifyDpopProof,
} from "../src/worker/dpop.ts";
import { authorizeMcpRequest } from "../src/worker/mcp-access.ts";

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

const internalRetryProof = await createProof({
  privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now,
  jti: "proof-internal-retry-1234", accessToken: token,
});
const verifiedInternalRetry = await verifyDpopProof({
  request: new Request(endpoint, { method: "POST", headers: { Authorization: `DPoP ${token}`, DPoP: internalRetryProof } }),
  accessToken: token, expectedJkt: jkt, now,
});
const retryId = `retry_${"r".repeat(43)}`;
assert(await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, retryId, now),
  "first DPoP use with an internal retry binding was rejected");
assert(await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, retryId, now + 1),
  "same outer request could not transparently retry its consumed DPoP proof");
assert(await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, retryId, now + 2),
  "third bounded internal DPoP attempt was rejected");
assert(await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, retryId, now + 3),
  "fourth bounded internal DPoP attempt was rejected");
assert(!await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, retryId, now + 4),
  "internal DPoP retry binding exceeded its maximum use count");
assert(!await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, `retry_${"s".repeat(43)}`, now + 1),
  "another outer request reused a consumed DPoP proof");
assert(!await consumeDpopProof(storage, verifiedInternalRetry, now + 1),
  "internal retry binding weakened ordinary DPoP replay rejection");
assert(!await consumeDpopProofForInternalRetry(storage, verifiedInternalRetry, "bad", now + 1),
  "malformed internal DPoP retry id was accepted");
const consistencyStorage = new MemoryStorage();
const consistencyProofRaw = await createProof({
  privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: now,
  jti: "proof-consistency-1234567", accessToken: token,
});
const consistencyProof = await verifyDpopProof({
  request: new Request(endpoint, { method: "POST", headers: { DPoP: consistencyProofRaw } }),
  accessToken: token, expectedJkt: jkt, now,
});
assert(await consumeDpopProofForInternalRetry(consistencyStorage, consistencyProof, retryId, now),
  "consistency fixture could not establish an internal retry binding");
await consistencyStorage.put("dpop-proof-jtis", {});
assert(!await consumeDpopProofForInternalRetry(consistencyStorage, consistencyProof, retryId, now + 1),
  "orphaned internal retry binding bypassed missing primary replay state");

const accessNow = Math.floor(Date.now() / 1000);
const accessRetryProof = await createProof({
  privateJwk, publicJwk, htm: "POST", htu: endpoint, iat: accessNow,
  jti: "proof-access-retry-123456", accessToken: token,
});
const accessRequest = () => new Request(endpoint, {
  method: "POST",
  headers: { Authorization: `DPoP ${token}`, DPoP: accessRetryProof },
});
const authorizedToken = {
  tokenKey: "sha256:synthetic",
  accountId: "acct_synthetic",
  accountVersion: 1,
  clientId: "client_synthetic",
  familyId: "family_synthetic",
  dpopJkt: jkt,
  role: "owner",
};
const oauth = { async verifyAccessToken(value) { return value === token ? authorizedToken : null; } };
const accessRetryId = `retry_${"a".repeat(43)}`;
const firstAccess = await authorizeMcpRequest({
  request: accessRequest(), base: "https://bridge.example.com", oauth,
  storage, bodyLimitBytes: 1024, internalDpopRetryId: accessRetryId,
});
assert(firstAccess.authorized?.accountId === authorizedToken.accountId,
  "first MCP DPoP authorization with internal retry binding failed");
const repeatedAccess = await authorizeMcpRequest({
  request: accessRequest(), base: "https://bridge.example.com", oauth,
  storage, bodyLimitBytes: 1024, internalDpopRetryId: accessRetryId,
});
assert(repeatedAccess.authorized?.accountId === authorizedToken.accountId,
  "same outer MCP request could not repeat DPoP authorization internally");
const foreignAccess = await authorizeMcpRequest({
  request: accessRequest(), base: "https://bridge.example.com", oauth,
  storage, bodyLimitBytes: 1024, internalDpopRetryId: `retry_${"b".repeat(43)}`,
});
assert(foreignAccess.response?.status === 401,
  "different outer MCP request reused an internally bound DPoP proof");

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
