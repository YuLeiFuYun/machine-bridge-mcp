import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseBrowserPairingGrant } from "../src/local/browser-pairing-grant.mjs";
import { startBrowserPairingLaunch } from "../src/local/browser-pairing-launch.mjs";

class FakeServer extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.handler = null;
    this.listenArgs = null;
    this.closeCalls = 0;
    this.factory = (handler) => { this.handler = handler; return this; };
  }

  listen(port, host) {
    this.listenArgs = [port, host];
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close(callback) {
    this.closeCalls += 1;
    queueMicrotask(() => callback?.());
    return this;
  }

  dispatch({ host, path, method = "GET" }) {
    if (typeof this.handler !== "function") throw new Error("fake pairing server has no handler");
    return new Promise((resolvePromise) => {
      const request = { headers: { host }, url: path, method };
      const response = {
        status: 0,
        headers: {},
        writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
        end: (body = "", onEnd) => {
          queueMicrotask(() => {
            onEnd?.();
            resolvePromise({ status: response.status, headers: response.headers, body: String(body || "") });
          });
          return response;
        },
      };
      this.handler(request, response);
    });
  }
}

const token = "p".repeat(43);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 80, extensionToken: token }), /broker port is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393, extensionToken: "x" }), /credential is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393 }), /credential is invalid/);
await assert.rejects(() => startBrowserPairingLaunch({ brokerPort: 39393, extensionToken: token, timeoutMs: 0 }), /launch timeout is invalid/);

const brokerPort = 39393;
const listener = new FakeServer(49152);
const launch = await startBrowserPairingLaunch({
  brokerPort,
  extensionToken: token,
  timeoutMs: 5_000,
  serverFactory: listener.factory,
});
const url = new URL(launch.url);
assert.deepEqual(listener.listenArgs, [0, "127.0.0.1"], "pairing launch changed its production listener target contract");
assert.equal(Number(url.port), listener.port, "pairing launch URL lost the ephemeral listener port");
assert.notEqual(Number(url.port), brokerPort, "pairing launch reused the long-lived broker port");
const fragment = new URLSearchParams(url.hash.slice(1));
const grant = String(fragment.get("grant") || "");
assert.equal(Number(fragment.get("broker_port")), brokerPort);
assert(parseBrowserPairingGrant(grant), "pairing launch did not create a valid short-lived grant");
assert(!url.search, "pairing launch leaked bootstrap data into the HTTP query");

const wrongPath = await listener.dispatch({ host: `127.0.0.1:${listener.port}`, path: "/other" });
assert.equal(wrongPath.status, 404, "ephemeral pairing handler accepted a non-pair path");
const wrongHost = await listener.dispatch({ host: `localhost:${listener.port}`, path: "/pair" });
assert.equal(wrongHost.status, 403, "ephemeral pairing handler accepted a non-loopback Host authority");
const delivered = await listener.dispatch({ host: `127.0.0.1:${listener.port}`, path: "/pair" });
assert.equal(delivered.status, 200);
assert(delivered.body.includes(String(brokerPort)), "pairing page lost the target broker port");
assert(!delivered.body.includes(token) && !delivered.body.includes(grant),
  "pairing page exposed a long-lived token or fragment bootstrap");
await launch.closed;
assert.equal(listener.closeCalls, 1, "pairing listener did not close exactly once after page delivery");
launch.close();
launch.close();
assert.equal(listener.closeCalls, 1, "pairing launch close stopped being idempotent");

const expiringListener = new FakeServer(49153);
const expiring = await startBrowserPairingLaunch({
  brokerPort,
  extensionToken: token,
  timeoutMs: 20,
  serverFactory: expiringListener.factory,
});
await new Promise((resolvePromise) => { setTimeout(resolvePromise, 40); });
await expiring.closed;
assert.equal(expiringListener.closeCalls, 1, "unused pairing listener did not close after its bounded TTL");
console.log("browser ephemeral pairing launch test ok");
