import { createHmac, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const serviceWorkerSource = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
const brokerAuthSource = await readFile(new URL("../browser-extension/broker-auth.js", import.meta.url), "utf8");
const pairingBootstrapSource = await readFile(new URL("../browser-extension/pairing-bootstrap.js", import.meta.url), "utf8");
const browserErrorBoundarySource = await readFile(new URL("../browser-extension/browser-error-boundary.js", import.meta.url), "utf8");
const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const browserOperationsSource = await readFile(new URL("../browser-extension/browser-operations.js", import.meta.url), "utf8");

await testPairingGrantBoundary();
await testHandshakeReadiness();
await testFailedReplacementPreservesPairing();
await testSocketReplacementCleanup();
await testResponseDeliveryFailureClosesSocket();
await testBrowserErrorRedaction();
await testExtensionConcurrencyLimit();
await testTrustedFallbackBoundary();
await testScreenshotRestoresActiveTab();
await testNavigationWaitStopsWhenTabCloses();
await testBrowserWaitIgnoresWallClockRollback();
await testAggregateFrameAndSourceBudgets();
console.log("browser service worker test ok");

async function testPairingGrantBoundary() {
  const token = "g".repeat(32);
  const context = createContext({ brokerTokens: { "39393": token }, chrome: baseChrome() });
  loadServiceWorker(context, ["pairFromBootstrap"]);
  const bootstrap = context.__machineBridgePairingBootstrap;
  await expectReject(() => bootstrap.bootstrapPairing(39393, "invalid"), "bootstrap is invalid");
  const grant = pairingGrant(39393, token);
  const tampered = `${grant.slice(0, -1)}x`;
  await expectReject(() => bootstrap.bootstrapPairing(39393, tampered), "broker authentication failed");
  const candidate = await bootstrap.bootstrapPairing(39393, grant);
  assert(candidate.endpoint === "ws://127.0.0.1:39393/extension" && candidate.token === token, "authenticated pairing bootstrap did not return the broker-bound extension credential");
}


async function testHandshakeReadiness() {
  const badge = [];
  const sent = [];
  const persisted = [];
  let storedPairing = {};
  let instance;
  let socketCount = 0;
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(_endpoint, protocols) { this.protocols = protocols; this.readyState = MockWebSocket.CONNECTING; instance = this; socketCount += 1; }
    send(value) { sent.push(JSON.parse(value)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
    open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const context = createContext({
    brokerTokens: { "39393": "x".repeat(32) },
    WebSocket: MockWebSocket,
    chrome: baseChrome({
      action: {
        setBadgeText: async ({ text }) => { badge.push(text); },
        setTitle: async () => {},
        onClicked: listener(),
      },
      runtime: {
        ...runtimeBase(),
        getManifest: () => ({ version: PACKAGE_VERSION, version_name: PACKAGE_VERSION }),
      },
      storage: { local: {
        async get() { return { ...storedPairing }; },
        async set(value) { persisted.push({ ...value }); storedPairing = { ...value }; },
      } },
    }),
  });
  const api = loadServiceWorker(context, ["pairConfiguration"]);
  const ready = api.pairConfiguration("ws://127.0.0.1:39393/extension", "x".repeat(32), { replace: false });
  await waitForCondition(() => Boolean(instance));
  assert(instance.protocols?.[0]?.startsWith("mbm-extension-v2.") && !instance.protocols[0].includes("x".repeat(32)), "extension WebSocket exposed the long-lived pairing token");
  instance.open();
  await tick();
  assert(!badge.includes("ON"), "extension reported connected before broker hello acknowledgement");
  assert(sent.length === 0, "extension sent its hello before receiving the broker hello");
  assert(persisted.length === 0, "pairing material was persisted before broker authentication");
  instance.receive({ type: "hello", role: "extension", protocol: 3 });
  await tick();
  assert(sent[0]?.type === "hello" && sent[0]?.protocol === 3, "extension did not answer the broker hello");
  assert(!badge.includes("ON"), "extension reported connected before hello_ack");
  instance.receive({ type: "hello_ack", role: "extension", protocol: 3 });
  const paired = await ready;
  assert(paired.ok === true && persisted.length === 1, "authenticated pairing was not persisted exactly once");
  assert(badge.at(-1) === "ON", "extension did not report connected after hello_ack");
  const repeated = await api.pairConfiguration("ws://127.0.0.1:39393/extension", "x".repeat(32), { replace: false });
  assert(repeated.already_connected === true && socketCount === 1 && persisted.length === 1, "reopening the same pairing page disrupted or rewrote an authenticated connection");
  const mismatched = await api.pairConfiguration("ws://127.0.0.1:39394/extension", "y".repeat(32), { replace: false });
  assert(mismatched.ok === false && mismatched.requires_manual_repair === true, "a different authenticated broker candidate bypassed explicit repair confirmation");
  const decorated = await api.pairConfiguration("ws://127.0.0.1:39393/extension?unexpected=1", "z".repeat(32), { replace: false });
  assert(decorated.ok === false && decorated.error === "invalid_pairing_material", "pairing accepted a decorated broker endpoint");
}

async function testFailedReplacementPreservesPairing() {
  const oldEndpoint = "ws://127.0.0.1:39393/extension";
  const oldToken = "o".repeat(32);
  const newEndpoint = "ws://127.0.0.1:39394/extension";
  const newToken = "n".repeat(32);
  const instances = [];
  const persisted = [];
  let storedPairing = {};
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(endpoint) { this.endpoint = endpoint; this.readyState = MockWebSocket.CONNECTING; instances.push(this); }
    send() {}
    close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
    fail() { this.close(1002, "candidate rejected"); }
  }
  const context = createContext({
    brokerTokens: { "39393": oldToken, "39394": newToken },
    WebSocket: MockWebSocket,
    chrome: baseChrome({
      storage: { local: {
        async get() { return { ...storedPairing }; },
        async set(value) { persisted.push(value); storedPairing = { ...value }; },
      } },
    }),
  });
  const api = loadServiceWorker(context, ["pairConfiguration"]);
  await tick();
  storedPairing = { endpoint: oldEndpoint, token: oldToken };
  const candidate = api.pairConfiguration(newEndpoint, newToken, { replace: true });
  await waitForCondition(() => instances.length >= 1);
  assert(instances[0]?.endpoint === newEndpoint, "replacement did not start with the candidate endpoint");
  instances[0].fail();
  await expectReject(() => candidate, "handshake failed");
  await waitForCondition(() => instances.length >= 2);
  assert(persisted.length === 0, "failed replacement overwrote stored pairing material");
  assert(instances[1]?.endpoint === oldEndpoint, "failed replacement did not reconnect the previous pairing");
  instances[1].close();
}

async function testSocketReplacementCleanup() {
  const instances = [];
  const clearedIntervals = [];
  let nextInterval = 1;
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(endpoint) { this.endpoint = endpoint; this.readyState = MockWebSocket.CONNECTING; instances.push(this); }
    send() {}
    close(code = 1000, reason = "") { this.readyState = 3; this.closeInfo = { code, reason }; this.onclose?.({ code, reason }); }
    open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
    receive(value) { return this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const context = createContext({
    brokerTokens: { "39393": "a".repeat(32), "39394": "b".repeat(32) },
    WebSocket: MockWebSocket,
    setInterval() { return nextInterval++; },
    clearInterval(value) { if (value) clearedIntervals.push(value); },
    chrome: baseChrome(),
  });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    dispatch: () => new Promise(() => {}),
  };
  const api = loadServiceWorker(context, ["connect", "handleMessage", "activeRequests"]);
  const firstReady = api.connect("ws://127.0.0.1:39393/extension", "a".repeat(32));
  await waitForCondition(() => instances.length >= 1);
  const first = instances.at(-1);
  first.open();
  first.receive({ type: "hello", role: "extension", protocol: 3 });
  await tick();
  first.receive({ type: "hello_ack", role: "extension", protocol: 3 });
  await firstReady;
  const firstKeepalive = first.keepaliveTimer;
  void api.handleMessage(first, JSON.stringify({ type: "request", id: "request-1", method: "wait", timeout_ms: 30000 }));
  await tick();
  assert(api.activeRequests.get("request-1")?.cancelled === false, "browser request did not enter the active registry");

  const replacement = api.connect("ws://127.0.0.1:39394/extension", "b".repeat(32), { reconnect: false });
  assert(api.activeRequests.get("request-1")?.cancelled === true, "socket replacement did not cancel the old socket requests");
  assert(clearedIntervals.includes(firstKeepalive), "socket replacement did not clear the old keepalive timer");
  await waitForCondition(() => instances.length >= 2);
  const second = instances.at(-1);
  second.open();
  second.receive({ type: "hello", role: "extension", protocol: 3 });
  await tick();
  second.receive({ type: "hello_ack", role: "extension", protocol: 3 });
  await replacement;
  void api.handleMessage(second, JSON.stringify({ type: "request", id: "request-1", method: "duplicate", timeout_ms: 30000 }));
  await tick();
  assert(second.closeInfo?.code === 1002, "duplicate browser request id did not close the protocol connection");
}

async function testResponseDeliveryFailureClosesSocket() {
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    async dispatch() { return { ok: true }; },
  };
  const api = loadServiceWorker(context, ["handleMessage"]);
  const socket = {
    bridgeReady: true, readyState: context.WebSocket.OPEN, closeInfo: null,
    send() { throw new Error("closed transport"); },
    close(code, reason) { this.closeInfo = { code, reason }; this.readyState = 3; },
  };
  await api.handleMessage(socket, JSON.stringify({ type: "request", id: "delivery-failure", method: "status", timeout_ms: 30000 }));
  assert(socket.closeInfo?.code === 1011 && socket.closeInfo.reason.includes("delivery failed"),
    "browser response send failure did not close the half-dead socket");
}

async function testBrowserErrorRedaction() {
  const sent = [];
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    async dispatch(method) {
      if (method === "stale") throw new Error("element reference is stale; inspect the page again");
      throw new Error("page failed at https://private.example/path?token=secret under /Users/private and operator@example.com");
    },
  };
  const api = loadServiceWorker(context, ["handleMessage"]);
  const socket = {
    bridgeReady: true,
    readyState: context.WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)); },
    close() {},
  };
  await api.handleMessage(socket, JSON.stringify({ type: "request", id: "private-error", method: "secret", timeout_ms: 30000 }));
  assert(sent[0]?.error === "browser operation failed", "unclassified browser exception was exposed to the remote caller");
  assert(!JSON.stringify(sent[0]).includes("private.example") && !JSON.stringify(sent[0]).includes("/Users/private")
    && !JSON.stringify(sent[0]).includes("operator@example.com") && !JSON.stringify(sent[0]).includes("secret"),
  "browser error response leaked URL, path, email, or credential-shaped text");
  await api.handleMessage(socket, JSON.stringify({ type: "request", id: "safe-error", method: "stale", timeout_ms: 30000 }));
  assert(sent[1]?.error === "element reference is stale; inspect the page again",
    "known safe browser guidance was unnecessarily replaced by a generic error");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("invalid CSS selector: body[data-secret='x']")) === "invalid CSS selector",
    "selector details were retained in the public browser error");
}

async function testExtensionConcurrencyLimit() {
  const sent = [];
  let dispatches = 0;
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    async dispatch() { dispatches += 1; return { ok: true }; },
  };
  const api = loadServiceWorker(context, ["handleMessage", "activeRequests"]);
  for (let index = 0; index < 32; index += 1) api.activeRequests.set(`occupied-${index}`, { cancelled: false });
  const socket = {
    bridgeReady: true,
    readyState: context.WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)); },
    close() {},
  };
  await api.handleMessage(socket, JSON.stringify({ type: "request", id: "overflow", method: "status", timeout_ms: 30000 }));
  assert(dispatches === 0 && sent[0]?.ok === false && sent[0]?.error === "too many concurrent browser requests",
    "browser extension exceeded its independent concurrent-request ceiling");
}

async function testTrustedFallbackBoundary() {
  const operations = [];
  const context = createContext({
    chrome: baseChrome({
      tabs: { async get(id) { return { id, windowId: 1, active: true, title: "Fixture", url: "https://example.test/" }; }, async query() { return []; } },
      scripting: {
        async executeScript(options) {
          if (options.files) return [];
          operations.push(options.args?.[0] || "");
          const operation = options.args?.[0];
          if (operation === "prepareAction") return [{ result: { ok: true, point: { x: 1, y: 2 }, element: { ref: "e1" } } }];
          if (operation === "action") return [{ result: { ok: true, element: { ref: "e1" } } }];
          throw new Error(`unexpected page operation: ${operation}`);
        },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  context.__machineBridgeDevtoolsInput = {
    async perform() {
      const error = new Error("debugger attach failed");
      Object.defineProperty(error, "safeToFallback", { value: true });
      throw error;
    },
  };
  const fallback = await api.dispatch("action", { tabId: 7, action: "click", inputMode: "auto", selector: { ref: "e1" }, waitFor: "none" }, { timeoutMs: 30000 });
  assert(fallback.input_mode === "dom" && fallback.trusted_input_fallback === true, "safe pre-dispatch failure did not fall back to DOM");
  assert(fallback.fallback_reason === "trusted_input_unavailable_before_dispatch"
    && !JSON.stringify(fallback).includes("debugger attach failed"),
  "successful trusted-input fallback leaked a raw local debugging error");
  assert(operations.join(",") === "prepareAction,action", "safe fallback did not execute exactly one DOM fallback");

  operations.length = 0;
  context.__machineBridgeDevtoolsInput = {
    async perform() {
      const error = new Error("mouse command response was lost");
      Object.defineProperty(error, "safeToFallback", { value: false });
      throw error;
    },
  };
  await expectReject(
    () => api.dispatch("action", { tabId: 7, action: "click", inputMode: "auto", selector: { ref: "e1" }, waitFor: "none" }, { timeoutMs: 30000 }),
    "outcome is unknown",
  );
  assert(operations.join(",") === "prepareAction", "ambiguous trusted-input failure was replayed through DOM");
}

async function testScreenshotRestoresActiveTab() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
  ]);
  const activations = [];
  let focusedWindow = false;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)).map((tab) => ({ ...tab }));
        },
        async update(id, patch) {
          if (patch.active) {
            for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
            tabs.get(id).active = true;
            activations.push(id);
          }
          return { ...tabs.get(id) };
        },
        async captureVisibleTab(windowId) {
          const active = [...tabs.values()].find((tab) => tab.windowId === windowId && tab.active);
          assert(active?.id === 2, "screenshot did not activate the requested tab");
          return "data:image/png;base64,AAAA";
        },
      },
      windows: { async update() { focusedWindow = true; } },
    }),
  });
  const api = loadBrowserOperations(context);
  const result = await api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {});
  assert(result.tab_id === 2, "screenshot returned the wrong tab");
  assert(activations.join(",") === "2,1", "screenshot did not restore the previously active tab");
  assert(focusedWindow === false, "screenshot unnecessarily stole window focus");
}

async function testNavigationWaitStopsWhenTabCloses() {
  let removedListener = null;
  const tabs = {
    async get(id) { return { id, windowId: 1, active: true, title: "Navigation", url: "https://example.test/start" }; },
    async query() { return []; },
    async update(id) { return { id, windowId: 1, active: true, title: "Navigation", url: "https://example.test/next" }; },
    onUpdated: listener(),
    onRemoved: {
      addListener(value) { removedListener = value; },
      removeListener(value) { if (removedListener === value) removedListener = null; },
    },
  };
  const context = createContext({ chrome: baseChrome({ tabs }) });
  const api = loadBrowserOperations(context);
  const navigation = api.dispatch("action", { tabId: 7, action: "navigate", url: "https://example.test/next", waitFor: "complete" }, { timeoutMs: 5000 });
  await tick();
  assert(typeof removedListener === "function", "navigation wait did not install a tab-removal listener");
  removedListener(7);
  await expectReject(() => navigation, "tab closed during navigation wait");
  assert(removedListener === null, "navigation wait did not remove its tab-removal listener");
}

async function testBrowserWaitIgnoresWallClockRollback() {
  const tabs = {
    async get(id) { return { id, windowId: 1, active: true, status: "complete", title: "Clock", url: "https://example.test/pending" }; },
    async query() { return []; },
  };
  const context = createContext({
    Date: { now: () => 0 },
    chrome: baseChrome({ tabs }),
  });
  const api = loadBrowserOperations(context);
  let error = null;
  try {
    await Promise.race([
      api.dispatch("wait", { tabId: 7, urlContains: "/complete", timeoutMs: 30 }, { cancelled: false }),
      new Promise((_, reject) => { setTimeout(() => reject(new Error("wall-clock watchdog expired")), 1000); }),
    ]);
  } catch (caught) {
    error = caught;
  }
  assert(String(error?.message || "").includes("browser wait timed out"), "browser wait did not use an elapsed monotonic deadline when wall time was frozen");
}

async function testAggregateFrameAndSourceBudgets() {
  let frameResults = Array.from({ length: 70 }, (_, frameId) => ({ frameId, result: { url: `https://example.test/frame-${frameId}` } }));
  const allocatedElements = [];
  const allocatedBytes = [];
  const scripting = {
    async executeScript(options) {
      if (options.target?.allFrames) return frameResults;
      if (options.files) return [];
      const frameId = options.target?.frameIds?.[0] ?? 0;
      if (options.args?.[0] === "inspect") {
        const count = Number(options.args[1]?.maxElements) || 0;
        allocatedElements.push(count);
        return [{ frameId, result: { snapshot_version: 2, document: {}, elements: Array.from({ length: count }, (_, index) => ({ ref: `e${frameId}-${index}` })), truncated: false } }];
      }
      if (typeof options.args?.[0] === "number") {
        const budget = options.args[0];
        allocatedBytes.push(budget);
        return [{ frameId, result: { source: "x".repeat(budget), bytes: budget, returned_bytes: budget, truncated: false, url: `https://example.test/frame-${frameId}` } }];
      }
      throw new Error("unexpected scripting call in frame-budget test");
    },
  };
  const tabs = {
    async get(id) { return { id, windowId: 1, active: true, title: "Frames", url: "https://example.test/" }; },
    async query() { return []; },
  };
  const context = createContext({ chrome: baseChrome({ scripting, tabs }) });
  const api = loadBrowserOperations(context);
  const inspected = await api.dispatch("inspect_page", { tabId: 1, allFrames: true, maxElements: 10, includeValues: false }, {});
  assert(inspected.frames.length === 10 && inspected.frames_truncated === true, "frame inspection did not enforce the aggregate frame budget");
  assert(inspected.total_elements === 10 && allocatedElements.reduce((sum, value) => sum + value, 0) === 10, "max_elements was applied per frame instead of per request");
  const sourceResult = await api.dispatch("get_source", { tabId: 1, allFrames: true, maxBytes: 100 }, {});
  assert(sourceResult.frames.length === 64 && sourceResult.frames_truncated === true, "source collection did not enforce the accessible-frame cap");
  assert(sourceResult.returned_bytes === 100 && allocatedBytes.reduce((sum, value) => sum + value, 0) === 100, "max_bytes was applied per frame instead of per request");
  allocatedBytes.length = 0;
  frameResults = frameResults.slice(0, 3);
  const tinySource = await api.dispatch("get_source", { tabId: 1, allFrames: true, maxBytes: 1 }, {});
  assert(tinySource.frames.length === 1 && tinySource.frames_truncated === true && tinySource.returned_bytes === 1, "source byte exhaustion did not report omitted frames");
  allocatedBytes.length = 0;
  const cancellation = { cancelled: false };
  const originalExecute = scripting.executeScript.bind(scripting);
  scripting.executeScript = async (options) => {
    const result = await originalExecute(options);
    if (typeof options.args?.[0] === "number" && allocatedBytes.length === 1) cancellation.cancelled = true;
    return result;
  };
  await expectReject(() => api.dispatch("get_source", { tabId: 1, allFrames: true, maxBytes: 100 }, cancellation), "cancelled");
  assert(allocatedBytes.length === 1, "source cancellation did not stop before the next frame");

  const host = {
    nodeType: 1,
    tagName: "DIV",
    attributes: [],
    childNodes: [{ nodeType: 3, data: "light-content", parentElement: { tagName: "DIV" } }],
    shadowRoot: { childNodes: [{ nodeType: 3, data: "shadow-content", parentElement: { tagName: "SPAN" } }] },
  };
  context.document = {
    doctype: { name: "html" },
    childNodes: [{
      nodeType: 1,
      tagName: "HTML",
      attributes: [{ name: "data-large", value: "a".repeat(10000) }],
      childNodes: [host, { nodeType: 3, data: "b".repeat(100000), parentElement: { tagName: "DIV" } }],
    }],
  };
  context.location = { href: "https://example.test/large" };
  const bounded = api.boundedDocumentSource(1024);
  assert(bounded.returned_bytes <= 1024 && bounded.truncated === true, "bounded DOM serializer exceeded its byte or safety budget");
  const shadowSerialized = api.boundedDocumentSource(20000);
  assert(shadowSerialized.source.includes("light-content") && shadowSerialized.source.includes("data-machine-bridge-shadow-root=\"open\"") && shadowSerialized.source.includes("shadow-content"), "bounded DOM serializer omitted open Shadow DOM content");
  assert(shadowSerialized.open_shadow_roots === 1, "bounded DOM serializer lost its open Shadow DOM count");
  context.document = { childNodes: [{ nodeType: 3, data: "😀中文", parentElement: { tagName: "DIV" } }] };
  for (const limit of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const unicode = api.boundedDocumentSource(limit);
    const actualBytes = new TextEncoder().encode(unicode.source).byteLength;
    assert(actualBytes === unicode.returned_bytes, `UTF-8 serializer misreported ${actualBytes} bytes as ${unicode.returned_bytes} at limit ${limit}`);
    assert(actualBytes <= limit && !unicode.source.includes("�"), `UTF-8 serializer split a code point at limit ${limit}`);
  }
}

function loadServiceWorker(context, names) {
  vm.runInContext(browserErrorBoundarySource, context, { filename: "browser-error-boundary.js" });
  vm.runInContext(brokerAuthSource, context, { filename: "broker-auth.js" });
  vm.runInContext(pairingBootstrapSource, context, { filename: "pairing-bootstrap.js" });
  vm.runInContext(`${serviceWorkerSource}\nglobalThis.__machineBridgeServiceWorkerTest = { ${names.join(", ")} };`, context, { filename: "service-worker.js" });
  return context.__machineBridgeServiceWorkerTest;
}

function loadBrowserOperations(context) {
  vm.runInContext(browserOperationsSource, context, { filename: "browser-operations.js" });
  return context.__machineBridgeBrowserOperations;
}

function createContext(overrides = {}) {
  const brokerTokens = overrides.brokerTokens || {};
  return vm.createContext({
    importScripts() {},
    console,
    TextEncoder,
    TextDecoder,
    JSON,
    URL,
    Promise,
    performance,
    crypto: webcrypto,
    AbortController,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    fetch: brokerAuthFetch(brokerTokens),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    WebSocket: class { static OPEN = 1; static CONNECTING = 0; },
    ...overrides,
  });
}

function brokerAuthFetch(tokens) {
  const pairing = new Map();
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const token = tokens[String(url.port)];
    const challenge = String(url.searchParams.get("challenge") || "");
    const marker = init.headers?.["x-machine-bridge-broker-auth"];
    if (marker !== "machine-bridge-browser-v2" || typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(challenge)) {
      return response(404);
    }
    if (url.pathname === "/extension-auth" && init.method === "GET") {
      const initProof = String(url.searchParams.get("init") || "");
      const expectedInit = createHmac("sha256", token).update(`machine-bridge-browser-extension-init-v2\0${challenge}`).digest("base64url");
      if (initProof !== expectedInit) return response(400);
      const serverNonce = "s".repeat(32);
      const proof = createHmac("sha256", token).update(`machine-bridge-browser-extension-server-v2\0${challenge}\0${serverNonce}`).digest("base64url");
      return response(204, { "x-machine-bridge-broker-nonce": serverNonce, "x-machine-bridge-broker-proof": proof });
    }
    if (url.pathname !== "/pair-auth") return response(404);
    const grantId = String(url.searchParams.get("grant") || "");
    const match = /^(\d{13})\.([A-Za-z0-9_-]{22})$/.exec(grantId);
    if (!match) return response(401);
    const secret = createHmac("sha256", token).update(`machine-bridge-browser-pair-v2\0${url.port}\0${match[1]}\0${match[2]}`).digest("base64url");
    if (init.method === "GET") {
      const initProof = String(url.searchParams.get("init") || "");
      const expectedInit = createHmac("sha256", secret).update(`machine-bridge-browser-pair-init-v2\0${grantId}\0${challenge}`).digest("base64url");
      if (initProof !== expectedInit) return response(401);
      const serverNonce = "p".repeat(32);
      pairing.set(grantId, { challenge, serverNonce });
      const proof = createHmac("sha256", secret).update(`machine-bridge-browser-pair-server-v2\0${grantId}\0${challenge}\0${serverNonce}`).digest("base64url");
      return response(204, { "x-machine-bridge-broker-nonce": serverNonce, "x-machine-bridge-broker-proof": proof });
    }
    if (init.method === "POST") {
      const pending = pairing.get(grantId); pairing.delete(grantId);
      const nonce = String(url.searchParams.get("nonce") || "");
      const proof = String(url.searchParams.get("proof") || "");
      const expected = createHmac("sha256", secret).update(`machine-bridge-browser-pair-client-v2\0${grantId}\0${challenge}\0${nonce}`).digest("base64url");
      if (!pending || pending.challenge !== challenge || pending.serverNonce !== nonce || proof !== expected) return response(401);
      return response(204, { "x-machine-bridge-extension-token": token });
    }
    return response(405);
  };
}

function response(status, values = {}) {
  const headers = new Map(Object.entries(values));
  return { status, headers: { get(name) { return headers.get(String(name).toLowerCase()) || null; } } };
}


function pairingGrant(port, token, now = Date.now()) {
  const expiresAt = now + 30_000;
  const nonce = Buffer.alloc(16, 7).toString("base64url");
  const proof = createHmac("sha256", token)
    .update(`machine-bridge-browser-pair-v2\0${port}\0${expiresAt}\0${nonce}`)
    .digest("base64url");
  return `${expiresAt}.${nonce}.${proof}`;
}


function baseChrome(overrides = {}) {
  return {
    runtime: runtimeBase(),
    alarms: { create() {}, onAlarm: listener() },
    action: { setBadgeText: async () => {}, setTitle: async () => {}, onClicked: listener() },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: { async query() { return []; } },
    windows: {},
    scripting: { async executeScript() { return []; } },
    debugger: {},
    ...overrides,
  };
}

function runtimeBase() {
  return { onInstalled: listener(), onStartup: listener(), onMessage: listener(), getManifest: () => ({ version: PACKAGE_VERSION }) };
}

function listener() {
  return { addListener() {}, removeListener() {} };
}

function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function waitForCondition(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("timed out waiting for browser service-worker test condition");
}

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
