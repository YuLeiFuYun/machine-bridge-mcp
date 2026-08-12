import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { parseBrowserPairingGrant } from "../src/local/browser-pairing-grant.mjs";
import { startBrowserPairingLaunch } from "../src/local/browser-pairing-launch.mjs";

const token = "p".repeat(43);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 80, extensionToken: token }), /broker port is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393, extensionToken: "x" }), /credential is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393 }), /credential is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393, extensionToken: token, timeoutMs: 0 }), /launch timeout is invalid/);

const broker = createServer((_request, response) => response.writeHead(404).end());
await listenRandom(broker);
const brokerPort = broker.address().port;
const launch = await startBrowserPairingLaunch({ brokerPort, extensionToken: token, timeoutMs: 5_000 });
try {
  const url = new URL(launch.url);
  assert.notEqual(Number(url.port), brokerPort, "pairing launch reused the long-lived broker port");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grant = String(fragment.get("grant") || "");
  assert.equal(Number(fragment.get("broker_port")), brokerPort);
  assert(parseBrowserPairingGrant(grant), "pairing launch did not create a valid short-lived grant");
  assert(!url.search, "pairing launch leaked bootstrap data into the HTTP query");

  const wrongPath = new URL(url); wrongPath.hash = ""; wrongPath.pathname = "/other";
  assert.equal((await fetch(wrongPath)).status, 404, "ephemeral pairing listener accepted a non-pair path");
  assert.equal(await rawStatus(Number(url.port), "/pair", `localhost:${url.port}`), 403, "ephemeral pairing listener accepted a non-loopback Host authority");

  const pageUrl = new URL(url); pageUrl.hash = "";
  const response = await fetch(pageUrl);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert(html.includes(String(brokerPort)), "pairing page lost the target broker port");
  assert(!html.includes(token) && !html.includes(grant), "pairing page exposed a long-lived token or fragment bootstrap");
  await launch.closed;
  await assert.rejects(() => fetch(pageUrl), /fetch failed|ECONNREFUSED|other side closed/i, "ephemeral pairing listener still accepted requests after first page delivery");
} finally {
  launch.close();
  await launch.closed;
  await closeServer(broker);
}

const expiringBroker = createServer((_request, response) => response.end());
await listenRandom(expiringBroker);
const expiringPort = expiringBroker.address().port;
const expiring = await startBrowserPairingLaunch({ brokerPort: expiringPort, extensionToken: token, timeoutMs: 20 });
await expiring.closed;
const expiredUrl = new URL(expiring.url); expiredUrl.hash = "";
await assert.rejects(() => fetch(expiredUrl), /fetch failed|ECONNREFUSED|other side closed/i, "unused pairing listener survived its bounded lifetime");
await closeServer(expiringBroker);
console.log("browser ephemeral pairing launch test ok");

function listenRandom(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
}
function closeServer(server) { return new Promise((resolvePromise) => { server.close(resolvePromise); }); }
function rawStatus(port, path, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (response) => {
      response.resume(); response.once("end", () => resolvePromise(response.statusCode));
    });
    request.once("error", rejectPromise); request.end();
  });
}
