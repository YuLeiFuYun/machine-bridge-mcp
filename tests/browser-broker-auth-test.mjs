import assert from "node:assert/strict";
import {
  createBrokerAuthChallenge,
  createBrokerAuthRegistry,
  createBrokerClientProtocol,
  createBrokerInitProof,
  createBrokerServerProof,
  verifyBrokerServerProof,
  parseBrokerAuthResponse,
  BROKER_AUTH_REQUEST_HEADER,
  BROKER_AUTH_REQUEST_VALUE,
} from "../src/local/browser-broker-auth.mjs";
import { createBrowserBrokerAuthHttpHandler } from "../src/local/browser-broker-auth-http.mjs";
import {
  createBrowserPairingGrant,
  createPairingBootstrapInitProof,
  createPairingBootstrapProof,
  createPairingBootstrapRegistry,
  parseBrowserPairingGrant,
} from "../src/local/browser-pairing-grant.mjs";

const token = "t".repeat(43);
const challenge = createBrokerAuthChallenge();
assert.match(challenge, /^[A-Za-z0-9_-]{32}$/);
const registry = createBrokerAuthRegistry(token, "runtime", { now: () => 1000 });
const issued = issueBroker(registry, token, "runtime", challenge);
assert(issued);
const duplicateIssued = issueBroker(registry, token, "runtime", challenge);
assert.deepEqual(duplicateIssued, issued, "replayed broker init proof allocated a second server nonce for the same client challenge");
assert.equal(verifyBrokerServerProof(token, "runtime", challenge, issued.serverNonce, issued.serverProof), true);
assert.equal(verifyBrokerServerProof(token, "extension", challenge, issued.serverNonce, issued.serverProof), false);
const protocol = createBrokerClientProtocol(token, "runtime", challenge, issued.serverNonce);
assert(!protocol.includes(token));
assert.equal(registry.consume(protocol), true);
assert.equal(registry.consume(protocol), false, "one-time broker authentication protocol replayed successfully");
assert.equal(registry.issue("invalid", "x".repeat(43)), null);
assert.throws(() => createBrokerClientProtocol(token, "invalid-role", challenge, issued.serverNonce), /role is invalid/);
assert.throws(() => createBrokerServerProof("short", "runtime", challenge, issued.serverNonce), /credential is invalid/);

let monotonicNow = 2000;
const expiring = createBrokerAuthRegistry(token, "extension", { now: () => monotonicNow });
const expiringChallenge = createBrokerAuthChallenge();
const expiringIssued = issueBroker(expiring, token, "extension", expiringChallenge);
monotonicNow += 5001;
assert.equal(expiring.consume(createBrokerClientProtocol(token, "extension", expiringChallenge, expiringIssued.serverNonce)), false);

const grantNow = 1_786_185_600_000;
const grant = createBrowserPairingGrant(token, 39393, grantNow);
const parsed = parseBrowserPairingGrant(grant, grantNow + 1);
assert(parsed?.id && parsed?.secret && parsed.expiresAt === grantNow + 30_000, "pairing grant did not parse into an id/secret boundary");
assert.equal(parseBrowserPairingGrant(grant, grantNow + 30_001), null);
assert.equal(parseBrowserPairingGrant(grant, -1), null);
assert.throws(() => createBrowserPairingGrant(token, 80, grantNow), /port is invalid/);

let pairMono = 3000;
const pairing = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => pairMono });
const pairChallenge = createBrokerAuthChallenge();
const pairIssued = issuePair(pairing, parsed, pairChallenge);
assert(pairIssued, "pairing bootstrap registry did not accept a valid grant id");
assert.equal(pairIssued.serverProof, createPairingBootstrapProof(parsed.secret, "server", parsed.id, pairChallenge, pairIssued.serverNonce));
assert.deepEqual(issuePair(pairing, parsed, pairChallenge), pairIssued, "replayed pairing init proof allocated a second server nonce for the same client challenge");
assert.equal(issuePair(pairing, parsed, createBrokerAuthChallenge()), null, "a second pairing challenge replaced an in-flight bootstrap exchange");
const pairClientProof = createPairingBootstrapProof(parsed.secret, "client", parsed.id, pairChallenge, pairIssued.serverNonce);
assert.equal(pairing.consume(parsed.id, pairChallenge, pairIssued.serverNonce, pairClientProof), true);
assert.equal(pairing.consume(parsed.id, pairChallenge, pairIssued.serverNonce, pairClientProof), false, "pairing bootstrap grant replayed successfully");
assert.equal(issuePair(pairing, parsed, createBrokerAuthChallenge()), null, "used pairing grant was issued again");

const expiringGrant = createBrowserPairingGrant(token, 39393, grantNow);
const expiringParsed = parseBrowserPairingGrant(expiringGrant, grantNow + 1);
const expiringPairing = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => pairMono });
const expiringPairChallenge = createBrokerAuthChallenge();
const expiringPairIssued = issuePair(expiringPairing, expiringParsed, expiringPairChallenge);
pairMono += 5001;
assert.equal(expiringPairing.consume(
  expiringParsed.id,
  expiringPairChallenge,
  expiringPairIssued.serverNonce,
  createPairingBootstrapProof(expiringParsed.secret, "client", expiringParsed.id, expiringPairChallenge, expiringPairIssued.serverNonce),
), false, "expired pairing bootstrap proof was accepted");

const capacityRegistry = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => 4000 });
for (let index = 0; index < 32; index += 1) {
  const candidate = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
  assert(issuePair(capacityRegistry, candidate, createBrokerAuthChallenge()), `pairing bootstrap capacity rejected slot ${index + 1}`);
}
const overflow = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
assert.equal(issuePair(capacityRegistry, overflow, createBrokerAuthChallenge()), null, "pairing bootstrap registry exceeded its bounded pending capacity");

const antiChurn = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => 4500 });
for (let index = 0; index < 64; index += 1) {
  const fakeId = `${grantNow + 30_000}.${Buffer.alloc(16, index).toString("base64url")}`;
  assert.equal(antiChurn.issue(fakeId, createBrokerAuthChallenge(), "f".repeat(43)), null, "fabricated grant id consumed a pairing bootstrap slot");
}
const realAfterChurn = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
assert(issuePair(antiChurn, realAfterChurn, createBrokerAuthChallenge()), "fabricated grant churn exhausted the bounded pairing registry");

// Generic broker-auth negative and bounded-state paths.
assert.equal(verifyBrokerServerProof(token, "runtime", challenge, issued.serverNonce, "bad"), false);
assert.equal(parseBrokerAuthResponse(null), null);
assert.equal(parseBrokerAuthResponse({ get: () => "bad" }), null);
assert.deepEqual(parseBrokerAuthResponse({ get(name) {
  return name === "x-machine-bridge-broker-nonce" ? issued.serverNonce : issued.serverProof;
} }), { serverNonce: issued.serverNonce, serverProof: issued.serverProof });
assert.throws(() => createBrokerAuthRegistry("short", "runtime"), /credential is invalid/);
assert.throws(() => createBrokerAuthRegistry(token, "other"), /role is invalid/);
assert.throws(() => createBrokerServerProof(token, "runtime", "short", issued.serverNonce), /challenge is invalid/);
assert.throws(() => createBrokerServerProof(token, "runtime", challenge, "short"), /challenge is invalid/);
assert.equal(registry.consume("not-a-protocol"), false);
assert.equal(registry.consume(`mbm-extension-v2.${challenge}.${issued.serverNonce}.${issued.serverProof}`), false);
assert.equal(registry.consume(`mbm-runtime-v2.short.${issued.serverNonce}.${issued.serverProof}`), false);
assert.equal(registry.consume(`mbm-runtime-v2.${challenge}.short.${issued.serverProof}`), false);
assert.equal(registry.consume(`mbm-runtime-v2.${challenge}.${issued.serverNonce}.bad`), false);
const missingChallenge = createBrokerAuthChallenge();
const missingNonce = createBrokerAuthChallenge();
const missingProof = createBrokerClientProtocol(token, "runtime", missingChallenge, missingNonce);
assert.equal(registry.consume(missingProof), false, "protocol without an issued challenge was accepted");
let pruneNow = 10_000;
const pruning = createBrokerAuthRegistry(token, "runtime", { now: () => pruneNow });
const pruneChallenge = createBrokerAuthChallenge();
issueBroker(pruning, token, "runtime", pruneChallenge);
pruneNow += 5_001;
assert(issueBroker(pruning, token, "runtime", createBrokerAuthChallenge()), "expired generic broker auth entry prevented a new issue");
const bounded = createBrokerAuthRegistry(token, "runtime", { now: () => 20_000 });
for (let index = 0; index < 65; index += 1) assert(issueBroker(bounded, token, "runtime", createBrokerAuthChallenge()));
const genericAntiChurn = createBrokerAuthRegistry(token, "runtime", { now: () => 30_000 });
for (let index = 0; index < 128; index += 1) {
  assert.equal(genericAntiChurn.issue(createBrokerAuthChallenge(), "f".repeat(43)), null, "unauthenticated broker challenge consumed a pending slot");
}
assert(issueBroker(genericAntiChurn, token, "runtime", createBrokerAuthChallenge()), "unauthenticated broker challenge churn evicted valid capacity");
assert.throws(() => createBrokerInitProof("short", "runtime", challenge), /credential is invalid/);
assert.throws(() => createBrokerInitProof(token, "other", challenge), /role is invalid/);
assert.throws(() => createBrokerInitProof(token, "runtime", "bad"), /challenge is invalid/);

// Pairing grant parse/validation and exchange mismatch paths.
assert.equal(parseBrowserPairingGrant("invalid", grantNow), null);
assert.equal(parseBrowserPairingGrant(grant, grantNow - 1), null, "future grant beyond the maximum lifetime was accepted");
assert.throws(() => createBrowserPairingGrant("short", 39393, grantNow), /credential is invalid/);
assert.throws(() => createBrowserPairingGrant(token, 39393, Number.MAX_SAFE_INTEGER), /time is invalid/);
assert.throws(() => createPairingBootstrapRegistry("short", 39393), /credential is invalid/);
assert.throws(() => createPairingBootstrapInitProof("bad", parsed.id, pairChallenge), /init proof input is invalid/);
assert.throws(() => createPairingBootstrapInitProof(parsed.secret, "bad", pairChallenge), /init proof input is invalid/);
assert.throws(() => createPairingBootstrapInitProof(parsed.secret, parsed.id, "bad"), /init proof input is invalid/);
assert.throws(() => createPairingBootstrapProof("bad", "server", parsed.id, pairChallenge, pairIssued.serverNonce), /input is invalid/);
assert.throws(() => createPairingBootstrapProof(parsed.secret, "other", parsed.id, pairChallenge, pairIssued.serverNonce), /input is invalid/);
assert.throws(() => createPairingBootstrapProof(parsed.secret, "server", "bad", pairChallenge, pairIssued.serverNonce), /input is invalid/);
assert.throws(() => createPairingBootstrapProof(parsed.secret, "server", parsed.id, "bad", pairIssued.serverNonce), /input is invalid/);
assert.throws(() => createPairingBootstrapProof(parsed.secret, "server", parsed.id, pairChallenge, "bad"), /input is invalid/);
const mismatchGrant = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
let mismatchMono = 50_000;
const mismatchRegistry = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => mismatchMono });
assert.equal(mismatchRegistry.issue("bad", pairChallenge, "x".repeat(43)), null);
assert.equal(mismatchRegistry.issue(mismatchGrant.id, "bad", "x".repeat(43)), null);
const mismatchIssued = issuePair(mismatchRegistry, mismatchGrant, pairChallenge);
assert(mismatchIssued);
assert.equal(issuePair(mismatchRegistry, mismatchGrant, createBrokerAuthChallenge()), null, "same grant received two live bootstrap exchanges");
assert.equal(mismatchRegistry.consume(mismatchGrant.id, pairChallenge, mismatchIssued.serverNonce, "bad"), false);
const mismatchGrant2 = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
const mismatchRegistry2 = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => mismatchMono });
const mismatchChallenge2 = createBrokerAuthChallenge();
const mismatchIssued2 = issuePair(mismatchRegistry2, mismatchGrant2, mismatchChallenge2);
const mismatchProof2 = createPairingBootstrapProof(mismatchGrant2.secret, "client", mismatchGrant2.id, mismatchChallenge2, mismatchIssued2.serverNonce);
assert.equal(mismatchRegistry2.consume(mismatchGrant2.id, createBrokerAuthChallenge(), mismatchIssued2.serverNonce, mismatchProof2), false);
const mismatchGrant3 = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
const mismatchRegistry3 = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => mismatchMono });
const mismatchChallenge3 = createBrokerAuthChallenge();
const mismatchIssued3 = issuePair(mismatchRegistry3, mismatchGrant3, mismatchChallenge3);
assert.equal(mismatchRegistry3.consume(mismatchGrant3.id, mismatchChallenge3, createBrokerAuthChallenge(), createPairingBootstrapProof(mismatchGrant3.secret, "client", mismatchGrant3.id, mismatchChallenge3, mismatchIssued3.serverNonce)), false);
const wrongProofGrant = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393, grantNow), grantNow + 1);
const wrongProofRegistry = createPairingBootstrapRegistry(token, 39393, { wallNow: () => grantNow + 1, monotonicNow: () => mismatchMono });
const wrongProofChallenge = createBrokerAuthChallenge();
const wrongProofIssued = issuePair(wrongProofRegistry, wrongProofGrant, wrongProofChallenge);
const wrongProof = createPairingBootstrapProof("z".repeat(43), "client", wrongProofGrant.id, wrongProofChallenge, wrongProofIssued.serverNonce);
assert.equal(wrongProofRegistry.consume(wrongProofGrant.id, wrongProofChallenge, wrongProofIssued.serverNonce, wrongProof), false);
assert.equal(wrongProofRegistry.consume("bad", wrongProofChallenge, wrongProofIssued.serverNonce, wrongProof), false);

// HTTP auth router rejects wrong host/marker/method and covers all status branches.
const httpRuntime = createBrokerAuthRegistry(token, "runtime", { now: () => 70_000 });
const httpExtension = createBrokerAuthRegistry(token, "extension", { now: () => 70_000 });
const handleHttp = createBrowserBrokerAuthHttpHandler({ port: 39393, extensionToken: token, runtimeAuth: httpRuntime, extensionAuth: httpExtension });
assert.equal(handleHttp(fakeRequest("GET", "/unknown", true), fakeResponse()), false);
assert.equal(handleHttp(fakeRequest("GET", "/runtime-auth?challenge=x", true, "evil.test"), fakeResponse()), false);
assertHttp(handleHttp, fakeRequest("POST", "/runtime-auth", true), 405);
const httpRuntimeChallenge = createBrokerAuthChallenge();
const httpRuntimeInit = createBrokerInitProof(token, "runtime", httpRuntimeChallenge);
assertHttp(handleHttp, fakeRequest("GET", `/runtime-auth?challenge=${httpRuntimeChallenge}&init=${httpRuntimeInit}`, false), 403);
assertHttp(handleHttp, fakeRequest("GET", "/runtime-auth?challenge=bad&init=bad", true), 400);
assertHttp(handleHttp, fakeRequest("GET", `/runtime-auth?challenge=${httpRuntimeChallenge}`, true), 400);
assertHttp(handleHttp, fakeRequest("GET", `/runtime-auth?challenge=${httpRuntimeChallenge}&init=${httpRuntimeInit}`, true), 204);
assertHttp(handleHttp, fakeRequest("PUT", "/pair-auth", true), 405);
const httpGrant = parseBrowserPairingGrant(createBrowserPairingGrant(token, 39393), Date.now());
const httpPairChallenge = createBrokerAuthChallenge();
const httpInitProof = createPairingBootstrapInitProof(httpGrant.secret, httpGrant.id, httpPairChallenge);
assertHttp(handleHttp, fakeRequest("GET", `/pair-auth?grant=${encodeURIComponent(httpGrant.id)}&challenge=${httpPairChallenge}`, false), 403);
assertHttp(handleHttp, fakeRequest("GET", `/pair-auth?grant=${encodeURIComponent(httpGrant.id)}&challenge=${httpPairChallenge}`, true), 401);
const httpPairResponse = fakeResponse();
assert.equal(handleHttp(fakeRequest("GET", `/pair-auth?grant=${encodeURIComponent(httpGrant.id)}&challenge=${httpPairChallenge}&init=${httpInitProof}`, true), httpPairResponse), true);
assert.equal(httpPairResponse.status, 204);
const httpServerNonce = httpPairResponse.headers["x-machine-bridge-broker-nonce"];
const httpClientProof = createPairingBootstrapProof(httpGrant.secret, "client", httpGrant.id, httpPairChallenge, httpServerNonce);
const httpPairFinish = fakeResponse();
assert.equal(handleHttp(fakeRequest("POST", `/pair-auth?grant=${encodeURIComponent(httpGrant.id)}&challenge=${httpPairChallenge}&nonce=${httpServerNonce}&proof=${httpClientProof}`, true), httpPairFinish), true);
assert.equal(httpPairFinish.status, 204);
assert.equal(httpPairFinish.headers["x-machine-bridge-extension-token"], token);
assertHttp(handleHttp, fakeRequest("GET", "/pair-auth?grant=bad&challenge=bad&init=bad", true), 401);
assertHttp(handleHttp, fakeRequest("POST", "/pair-auth?grant=bad&challenge=bad&nonce=bad&proof=bad", true), 401);

function issueBroker(registry, tokenValue, role, challengeValue) {
  return registry.issue(challengeValue, createBrokerInitProof(tokenValue, role, challengeValue));
}

function issuePair(registry, parsedGrant, challenge) {
  return registry.issue(parsedGrant.id, challenge, createPairingBootstrapInitProof(parsedGrant.secret, parsedGrant.id, challenge));
}

function fakeRequest(method, url, marked, host = "127.0.0.1:39393") {
  return { method, url, headers: { host, ...(marked ? { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE } : {}) } };
}
function fakeResponse() {
  return { status: 0, headers: null, ended: false, writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end() { this.ended = true; return this; } };
}
function assertHttp(handler, request, expectedStatus) {
  const response = fakeResponse();
  assert.equal(handler(request, response), true);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.ended, true);
}

console.log("browser broker authentication test ok");
