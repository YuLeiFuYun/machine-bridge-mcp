import { BROKER_AUTH_REQUEST_HEADER, BROKER_AUTH_REQUEST_VALUE } from "./browser-broker-auth.mjs";
import { isAllowedLoopbackHost } from "./browser-pairing-http.mjs";
import { createPairingBootstrapRegistry } from "./browser-pairing-grant.mjs";

export function createBrowserBrokerAuthHttpHandler({ port, extensionToken, runtimeAuth, extensionAuth }) {
  const pairingAuth = createPairingBootstrapRegistry(extensionToken, port);
  return (request, response) => {
    const host = String(request.headers.host || "");
    if (!isAllowedLoopbackHost(host, port)) return false;
    const url = new URL(request.url || "/", `http://${host}`);
    if (url.pathname === "/pair-auth") {
      handlePairingAuth(request, response, url, pairingAuth, extensionToken);
      return true;
    }
    const auth = url.pathname === "/runtime-auth" ? runtimeAuth : url.pathname === "/extension-auth" ? extensionAuth : null;
    if (!auth) return false;
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
      return true;
    }
    if (!hasAuthMarker(request)) {
      response.writeHead(403, { "cache-control": "no-store" }).end();
      return true;
    }
    const issued = auth.issue(url.searchParams.get("challenge"), url.searchParams.get("init"));
    if (!issued) {
      response.writeHead(400, { "cache-control": "no-store" }).end();
      return true;
    }
    response.writeHead(204, proofHeaders(issued)).end();
    return true;
  };
}

function handlePairingAuth(request, response, url, pairingAuth, extensionToken) {
  if (!hasAuthMarker(request)) {
    response.writeHead(403, { "cache-control": "no-store" }).end();
    return;
  }
  const grantId = url.searchParams.get("grant");
  const clientChallenge = url.searchParams.get("challenge");
  if (request.method === "GET") {
    const issued = pairingAuth.issue(grantId, clientChallenge, url.searchParams.get("init"));
    if (!issued) { response.writeHead(401, { "cache-control": "no-store" }).end(); return; }
    response.writeHead(204, proofHeaders(issued)).end();
    return;
  }
  if (request.method === "POST") {
    const ok = pairingAuth.consume(grantId, clientChallenge, url.searchParams.get("nonce"), url.searchParams.get("proof"));
    if (!ok) { response.writeHead(401, { "cache-control": "no-store" }).end(); return; }
    response.writeHead(204, { "cache-control": "no-store", "x-machine-bridge-extension-token": extensionToken }).end();
    return;
  }
  response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" }).end();
}

function hasAuthMarker(request) {
  return request.headers[BROKER_AUTH_REQUEST_HEADER] === BROKER_AUTH_REQUEST_VALUE;
}

function proofHeaders(issued) {
  return {
    "cache-control": "no-store",
    "x-machine-bridge-broker-nonce": issued.serverNonce,
    "x-machine-bridge-broker-proof": issued.serverProof,
  };
}
