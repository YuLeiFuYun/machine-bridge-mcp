import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const serviceWorkerSource = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const browserOperationsSource = await readFile(new URL("../browser-extension/browser-operations.js", import.meta.url), "utf8");

await testHandshakeReadiness();
await testFailedReplacementPreservesPairing();
await testTrustedFallbackBoundary();
await testScreenshotRestoresActiveTab();
await testNavigationWaitStopsWhenTabCloses();
await testBrowserWaitIgnoresWallClockRollback();
await testAggregateFrameAndSourceBudgets();
console.log("browser service worker test ok");

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
    constructor() { this.readyState = MockWebSocket.CONNECTING; instance = this; socketCount += 1; }
    send(value) { sent.push(JSON.parse(value)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
    open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const context = createContext({
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
  const ready = api.pairConfiguration("ws://127.0.0.1:39393/extension", "x".repeat(32), { replace: false, senderUrl: "http://127.0.0.1:39393/pair" });
  await tick();
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
  const repeated = await api.pairConfiguration("ws://127.0.0.1:39393/extension", "x".repeat(32), { replace: false, senderUrl: "http://127.0.0.1:39393/pair" });
  assert(repeated.already_connected === true && socketCount === 1 && persisted.length === 1, "reopening the same pairing page disrupted or rewrote an authenticated connection");
  const mismatched = await api.pairConfiguration("ws://127.0.0.1:39394/extension", "y".repeat(32), { replace: false, senderUrl: "http://127.0.0.1:39393/pair" });
  assert(mismatched.ok === false && mismatched.error === "invalid_pairing_material", "pairing accepted a broker port different from the pairing page");
  const decorated = await api.pairConfiguration("ws://127.0.0.1:39393/extension?unexpected=1", "z".repeat(32), { replace: false, senderUrl: "http://127.0.0.1:39393/pair" });
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
  const candidate = api.pairConfiguration(newEndpoint, newToken, { replace: true, senderUrl: "http://127.0.0.1:39394/pair" });
  await tick();
  assert(instances[0]?.endpoint === newEndpoint, "replacement did not start with the candidate endpoint");
  instances[0].fail();
  await expectReject(() => candidate, "handshake failed");
  await tick();
  assert(persisted.length === 0, "failed replacement overwrote stored pairing material");
  assert(instances[1]?.endpoint === oldEndpoint, "failed replacement did not reconnect the previous pairing");
  instances[1].close();
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("wall-clock watchdog expired")), 1000)),
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
}

function loadServiceWorker(context, names) {
  vm.runInContext(`${serviceWorkerSource}\nglobalThis.__machineBridgeServiceWorkerTest = { ${names.join(", ")} };`, context, { filename: "service-worker.js" });
  return context.__machineBridgeServiceWorkerTest;
}

function loadBrowserOperations(context) {
  vm.runInContext(browserOperationsSource, context, { filename: "browser-operations.js" });
  return context.__machineBridgeBrowserOperations;
}

function createContext(overrides = {}) {
  return vm.createContext({
    importScripts() {},
    console,
    TextEncoder,
    TextDecoder,
    JSON,
    URL,
    Promise,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    WebSocket: class { static OPEN = 1; static CONNECTING = 0; },
    ...overrides,
  });
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
  return new Promise((resolve) => setTimeout(resolve, 0));
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
