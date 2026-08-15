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
const browserOperationHelpers = loadBrowserOperations(createContext({ chrome: baseChrome() }));

await testPairingGrantBoundary();
await testInternalDelayService();
testBrowserOperationScalarExactness();
await testHandshakeReadiness();
await testFailedReplacementPreservesPairing();
await testSocketReplacementCleanup();
await testResponseDeliveryFailureClosesSocket();
await testMutationResultSettlementFailuresAreUnknown();
await testBrowserErrorRedaction();
await testExtensionConcurrencyLimit();
await testTrustedFallbackBoundary();
await testPageMutationScriptingSettlementBoundary();
await testScreenshotRestoresActiveTab();
await testScreenshotRestoreMutationFailureIsUnknown();
await testScreenshotRestoreVerificationFailureIsUnknown();
await testScreenshotMovedRestoreBaselineDoesNotTouchOtherWindow();
await testScreenshotRejectsActiveTabChangeBeforeActivation();
await testScreenshotRejectsActiveTabChangeDuringCapture();
await testScreenshotActivationFailureIsUnknown();
await testScreenshotWindowChangeDuringActivationIsUnknown();
await testScreenshotPreCaptureVerificationFailureRestoresTab();
await testNavigationMutationApiFailureIsUnknown();
await testHistoryActionRevalidatesExpectedDocumentBeforeMutation();
await testPostActionMetadataReadDoesNotRewriteSettlement();
await testTabMutationApiFailuresAreUnknown();
await testBrokerRejectsCoercibleMutationParameters();
await testCancellationStopsUnstartedBrowserMutations();
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

async function testInternalDelayService() {
  let messageListener = null;
  const extensionId = "test-extension-id";
  const runtime = {
    ...runtimeBase(),
    id: extensionId,
    onMessage: {
      addListener(listener) { messageListener = listener; },
      removeListener() {},
    },
  };
  const context = createContext({ chrome: baseChrome({ runtime }) });
  loadServiceWorker(context, []);
  assert(typeof messageListener === "function", "service worker did not register its internal runtime message listener");

  const responses = [];
  const handled = messageListener(
    { type: "machine_bridge_internal_delay", delay_ms: 5 },
    { id: extensionId },
    (value) => responses.push(value),
  );
  assert(handled === true, "same-extension bounded delay request did not retain the response channel");
  await waitForCondition(() => responses.length === 1);
  assert(responses[0]?.ok === true, "same-extension bounded delay request did not settle successfully");

  const malformedResponses = [];
  const malformedHandled = messageListener(
    { type: "machine_bridge_internal_delay", delay_ms: 251 },
    { id: extensionId },
    (value) => malformedResponses.push(value),
  );
  assert(malformedHandled === false && malformedResponses[0]?.ok === false,
    "internal delay service accepted an out-of-range renderer delay request");

  const foreignResponses = [];
  const foreignHandled = messageListener(
    { type: "machine_bridge_internal_delay", delay_ms: 5 },
    { id: "other-extension" },
    (value) => foreignResponses.push(value),
  );
  assert(foreignHandled === false && foreignResponses.length === 0,
    "internal delay service answered a cross-extension runtime message");
}

function testBrowserOperationScalarExactness() {
  assert(browserOperationHelpers.methodMayMutate("fill_form") === true, "known mutation method lost mutation classification");
  assert(browserOperationHelpers.methodMayMutate(["fill_form"]) === false,
    "coercible browser method acquired mutation settlement classification");
  assert(browserOperationHelpers.boundedRequestTimeout(5000) === 5000);
  for (const malformed of ["5000", [5000], 5000.5, null, {}]) {
    assert(browserOperationHelpers.boundedRequestTimeout(malformed) === 30000,
      "coercible request timeout changed the browser request deadline");
  }
  const malformedMethod = JSON.parse(browserOperationHelpers.responsePayload({
    id: "coercible-method", ok: true, result: { ok: true }, method: ["fill_form"], maxBytes: 1,
  }));
  assert(malformedMethod.error === "browser result exceeds maximum size",
    "coercible method was treated as a completed mutation when response delivery became impossible");
  const malformedLimit = JSON.parse(browserOperationHelpers.responsePayload({
    id: "coercible-limit", ok: true, result: { ok: true }, method: "inspect_page", maxBytes: "100000",
  }));
  assert(malformedLimit.error === "browser result exceeds maximum size",
    "coercible response-size budget was accepted as an extension transport limit");
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
  assert(sent[0]?.capabilities?.includes("computer_observation_v1")
    && sent[0]?.capabilities?.includes("cdp_accessibility_snapshot")
    && sent[0]?.capabilities?.includes("cdp_surface_screenshot")
    && sent[0]?.capabilities?.includes("backend_node_trusted_input"),
  "extension hello omitted Computer Use observation capabilities");
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
    methodMayMutate: browserOperationHelpers.methodMayMutate,
    responsePayload: browserOperationHelpers.responsePayload,
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
  let mutationDispatches = 0;
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    methodMayMutate: browserOperationHelpers.methodMayMutate,
    responsePayload: browserOperationHelpers.responsePayload,
    async dispatch(method) {
      assert(method === "fill_form", "response-loss fixture did not execute the intended mutating browser method");
      mutationDispatches += 1;
      return { ok: true, filled: 1 };
    },
  };
  const api = loadServiceWorker(context, ["handleMessage"]);
  const socket = {
    bridgeReady: true, readyState: context.WebSocket.OPEN, closeInfo: null,
    send() { throw new Error("closed transport"); },
    close(code, reason) { this.closeInfo = { code, reason }; this.readyState = 3; },
  };
  await api.handleMessage(socket, JSON.stringify({ type: "request", id: "delivery-failure", method: "fill_form", timeout_ms: 30000 }));
  assert(mutationDispatches === 1, "mutating extension request was replayed when its success response could not be delivered");
  assert(socket.closeInfo?.code === 1011 && socket.closeInfo.reason.includes("delivery failed"),
    "browser response send failure did not close the half-dead socket");
}

async function testMutationResultSettlementFailuresAreUnknown() {
  const sent = [];
  const dispatches = [];
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    methodMayMutate: browserOperationHelpers.methodMayMutate,
    responsePayload: browserOperationHelpers.responsePayload,
    async dispatch(method, params) {
      dispatches.push(`${method}:${params.mode || ""}`);
      if (params.mode === "unserializable") return { ok: true, value: 1n };
      return { ok: true, data: "x".repeat(7 * 1024 * 1024) };
    },
  };
  const api = loadServiceWorker(context, ["handleMessage"]);
  const socket = {
    bridgeReady: true,
    readyState: context.WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)); },
    close() {},
  };

  await api.handleMessage(socket, JSON.stringify({
    type: "request", id: "mutation-oversize", method: "fill_form", params: { mode: "oversize" }, timeout_ms: 30000,
  }));
  assert(sent[0]?.ok === false && /outcome is unknown/.test(sent[0]?.error || ""),
    "oversized mutating success result was downgraded to a definite browser limit failure");

  await api.handleMessage(socket, JSON.stringify({
    type: "request", id: "mutation-unserializable", method: "fill_form", params: { mode: "unserializable" }, timeout_ms: 30000,
  }));
  assert(sent[1]?.ok === false && /outcome is unknown/.test(sent[1]?.error || ""),
    "unserializable mutating success result was downgraded to a definite browser serialization failure");

  await api.handleMessage(socket, JSON.stringify({
    type: "request", id: "readonly-oversize", method: "inspect_page", params: { mode: "oversize" }, timeout_ms: 30000,
  }));
  assert(sent[2]?.ok === false && sent[2]?.error === "browser result exceeds maximum size",
    "oversized read-only result was unnecessarily classified as a mutation-unknown outcome");
  assert(dispatches.join(",") === "fill_form:oversize,fill_form:unserializable,inspect_page:oversize",
    "result settlement failure replayed or skipped an extension dispatch");
}

async function testBrowserErrorRedaction() {
  const sent = [];
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    methodMayMutate: browserOperationHelpers.methodMayMutate,
    responsePayload: browserOperationHelpers.responsePayload,
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
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("page automation module version mismatch"))
    === "page automation module version mismatch",
  "fixed page-module version mismatch was unnecessarily hidden behind a generic browser error");
  for (const message of [
    "snapshot browser tab changed before navigation dispatch; observe again",
    "snapshot browser tab could not be verified before navigation dispatch; observe again",
    "snapshot history document changed before dispatch; observe again",
    "snapshot history document could not be verified before dispatch; observe again",
    "snapshot history entry changed before dispatch; observe again",
    "snapshot history entry could not be verified before dispatch; observe again",
    "snapshot browser history has no back entry before dispatch; observe again",
    "snapshot browser history has no forward entry before dispatch; observe again",
    "snapshot history mutation API is unavailable before dispatch; observe again",
  ]) {
    assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(message)) === message,
      "snapshot-bound navigation preflight guidance was unnecessarily hidden behind a generic browser error");
  }
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser action may have been dispatched; the action outcome is unknown because post-dispatch wait failed. Inspect the page before retrying. (private wait detail)",
  )) === "browser action may have been dispatched; the action outcome is unknown. Inspect the page before retrying.",
  "post-dispatch wait uncertainty leaked its private wait detail or lost unknown-outcome guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser action may have been dispatched; the action outcome is unknown because the page mutation scripting call did not settle. Inspect the page before retrying. (private scripting detail)",
  )) === "browser action may have been dispatched; the action outcome is unknown. Inspect the page before retrying.",
  "page-mutation scripting uncertainty leaked private detail or lost unknown-outcome guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser tab mutation may have been dispatched; the outcome is unknown during focus_window. Inspect tabs before retrying. (private tab detail)",
  )) === "browser tab mutation may have been dispatched; the outcome is unknown. Inspect tabs before retrying.",
  "tab mutation uncertainty leaked its private browser detail or lost inspection guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser tab activation completed but its current window is unavailable before focus; inspect tabs before retrying",
  )) === "browser tab activation completed but its current window is unavailable before focus; inspect tabs before retrying",
  "partial tab activation lost fixed safe current-window inspection guidance");
  for (const message of [
    "browser tab activation completed but the target tab could not be verified before focus; inspect tabs before retrying",
    "browser tab activation completed but the target tab was no longer active before focus; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab could not be verified; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab moved windows; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab was no longer active; inspect tabs before retrying",
  ]) {
    assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(message)) === message,
      "tab activation/focus verification guidance was unnecessarily hidden behind a generic browser error");
  }
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("browser screenshot could not restore the previous active tab"))
    === "browser screenshot could not restore the previous active tab",
  "pre-dispatch screenshot restore failure was not preserved as fixed safe public guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser screenshot restoration may have been dispatched; the active-tab outcome is unknown. Inspect tabs before retrying. (private restore detail)",
  )) === "browser screenshot restoration may have been dispatched; the active-tab outcome is unknown. Inspect tabs before retrying.",
  "screenshot restoration uncertainty leaked private detail or lost tab-inspection guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("browser screenshot active tab changed during capture"))
    === "browser screenshot active tab changed during capture",
  "screenshot active-tab race was not preserved as fixed safe public guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error(
    "browser screenshot temporary tab activation may have been dispatched; the outcome is unknown. Inspect tabs before retrying. (private activation detail)",
  )) === "browser screenshot temporary tab activation may have been dispatched; the outcome is unknown. Inspect tabs before retrying.",
  "screenshot activation uncertainty leaked private detail or lost tab-inspection guidance");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("browser screenshot could not verify target tab at capture boundary"))
    === "browser screenshot could not verify target tab at capture boundary",
  "pre-capture tab verification failure lost its fixed safe error");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("browser screenshot could not revalidate the active tab before temporary activation"))
    === "browser screenshot could not revalidate the active tab before temporary activation",
  "pre-activation screenshot active-tab revalidation failure lost its fixed safe error");
  assert(context.__machineBridgeBrowserErrorBoundary.publicError(new Error("browser screenshot active tab changed before temporary activation"))
    === "browser screenshot active tab changed before temporary activation",
  "pre-activation concurrent tab switch lost its fixed safe error");
}

async function testExtensionConcurrencyLimit() {
  const sent = [];
  let dispatches = 0;
  const context = createContext({ chrome: baseChrome() });
  context.__machineBridgeBrowserOperations = {
    boundedRequestTimeout: () => 30_000,
    methodMayMutate: browserOperationHelpers.methodMayMutate,
    responsePayload: browserOperationHelpers.responsePayload,
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
          if (operation === "prepareAction") return pageMutationSuccess({ ok: true, point: { x: 1, y: 2 }, element: { ref: "e1" } });
          if (operation === "action") return pageMutationSuccess({ ok: true, element: { ref: "e1" } });
          throw new Error(`unexpected page operation: ${operation}`);
        },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  const fallback = await api.dispatch("action", { tabId: 7, action: "click", inputMode: "auto", selector: { ref: "e1" }, waitFor: "none" }, { timeoutMs: 30000 });
  assert(fallback.input_mode === "dom" && fallback.trusted_input_fallback === true, "missing trusted module did not fall back to DOM before page preparation");
  assert(fallback.fallback_reason === "trusted_input_unavailable_before_dispatch",
    "pre-prepare trusted-input fallback lost its fixed reason");
  assert(operations.join(",") === "action", "trusted module absence still ran side-effecting page preparation before DOM fallback");

  operations.length = 0;
  context.__machineBridgeDevtoolsInput = {
    async perform() {
      const error = new Error("debugger attach failed");
      Object.defineProperty(error, "safeToFallback", { value: true });
      throw error;
    },
  };
  await expectReject(
    () => api.dispatch("action", { tabId: 7, action: "click", inputMode: "auto", selector: { ref: "e1" }, waitFor: "none" }, { timeoutMs: 30000 }),
    "outcome is unknown",
  );
  assert(operations.join(",") === "prepareAction", "trusted attach failure after page preparation was replayed through DOM");

  operations.length = 0;
  await expectReject(
    () => api.dispatch("action", { tabId: 7, action: "click", inputMode: "trusted", selector: { ref: "e1" }, waitFor: "none" }, { timeoutMs: 30000 }),
    "outcome is unknown",
  );
  assert(operations.join(",") === "prepareAction",
    "explicit trusted attach failure forgot that page preparation may already have produced side effects");

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

async function testPageMutationScriptingSettlementBoundary() {
  {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            invocations += 1;
            if (options.args?.[0] === "action") return pageMutationFailure("element reference is stale; inspect the page again");
            throw new Error(`unexpected page operation: ${options.args?.[0]}`);
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { ref: "stale" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "element reference is stale");
    assert(invocations === 1,
      "structured pre-dispatch page error was retried or incorrectly converted into scripting-dispatch uncertainty");
  }

  {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            invocations += 1;
            return pageMutationFailure("browser action may have been dispatched; the action outcome is unknown because DOM click failed after a side-effecting step. Inspect the page before retrying.");
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "outcome is unknown");
    assert(invocations === 1,
      "structured post-side-effect page uncertainty was retried or downgraded to a definite error");
  }

  {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) throw new Error("page module injection blocked before mutation dispatch");
            invocations += 1;
            return pageMutationSuccess({ ok: true });
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "page module injection blocked before mutation dispatch");
    assert(invocations === 0,
      "mutation invocation started after the fixed page-module setup step failed");
  }

  {
    let invocations = 0;
    let staleCalls = 0;
    const context = createContext({
      __machineBridgePageAutomation: Object.freeze({
        version: 0,
        async action() { staleCalls += 1; return { ok: true }; },
      }),
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            invocations += 1;
            return [{ result: await options.func(...options.args) }];
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "page automation module version mismatch");
    assert(invocations === 1 && staleCalls === 0,
      "page mutation wrapper invoked a stale page automation API before rejecting its version");
  }

  for (const [method, operation, params] of [
    ["action", "action", { tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none" }],
    ["fill_form", "fillForm", { tabId: 7, fields: [{ selector: { id: "field" }, value: "x", action: "fill", sensitive: false }], waitFor: "none" }],
    ["upload_files", "uploadFiles", { tabId: 7, selector: { id: "file" }, files: [{ filename: "a.txt", mime: "text/plain", data: "YQ==" }] }],
  ]) {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] !== operation) throw new Error(`unexpected page operation: ${options.args?.[0]}`);
            invocations += 1;
            throw new Error("scripting response lost after page mutation dispatch");
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch(method, params, { timeoutMs: 30000 }), "page mutation scripting call did not settle");
    assert(invocations === 1, `${method} scripting response loss retried or skipped the page mutation invocation`);
  }

  {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            invocations += 1;
            return [];
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "page mutation settlement response was unavailable");
    assert(invocations === 1,
      "missing page-mutation settlement was retried or treated as a definite pre-dispatch failure");
  }

  for (const settlement of [
    { protocol: "machine_bridge_page_mutation_v1", ok: false, error: ["renderer failure"] },
    { protocol: "machine_bridge_page_mutation_v1", ok: false, error: "" },
    { protocol: "machine_bridge_page_mutation_v1", ok: false, error: "bad\0error" },
    { protocol: "machine_bridge_page_mutation_v1", ok: "false", error: "renderer failure" },
    { protocol: "machine_bridge_page_mutation_v1", ok: 1, result: { ok: true } },
  ]) {
    let invocations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            invocations += 1;
            return [{ result: structuredClone(settlement) }];
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "page mutation settlement was malformed");
    assert(invocations === 1,
      "malformed page-mutation settlement was retried or downgraded to a definite pre-dispatch failure");
  }

  {
    let preparationInvocations = 0;
    let trustedDispatches = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] !== "prepareAction") throw new Error(`unexpected page operation: ${options.args?.[0]}`);
            preparationInvocations += 1;
            throw new Error("scripting response lost after page preparation dispatch");
          },
        },
      }),
      __machineBridgeDevtoolsInput: { async perform() { trustedDispatches += 1; } },
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "trusted", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 }), "page mutation scripting call did not settle");
    assert(preparationInvocations === 1 && trustedDispatches === 0,
      "lost page-preparation response continued to trusted input or replayed preparation");
  }
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
          active.title = "Captured target";
          active.url = "https://example.test/target-after-capture";
          return "data:image/png;base64,AAAA";
        },
      },
      windows: { async update() { focusedWindow = true; } },
    }),
  });
  const api = loadBrowserOperations(context);
  const result = await api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {});
  assert(result.tab_id === 2, "screenshot returned the wrong tab");
  assert(result.tab_metadata_verified === true
    && result.title === "Captured target"
    && result.url === "https://example.test/target-after-capture",
  "screenshot returned pre-capture tab provenance instead of the verified post-capture active-tab observation");
  assert(activations.join(",") === "2,1", "screenshot did not restore the previously active tab");
  assert(focusedWindow === false, "screenshot unnecessarily stole window focus");
}

async function testScreenshotRestoreMutationFailureIsUnknown() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
  ]);
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)).map((tab) => ({ ...tab }));
        },
        async update(id, patch) {
          if (patch.active && id === 1 && tabs.get(2).active) throw new Error("restore denied");
          if (patch.active) {
            for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
            tabs.get(id).active = true;
          }
          return { ...tabs.get(id) };
        },
        async captureVisibleTab() { return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "restoration may have been dispatched; the active-tab outcome is unknown",
  );
  assert(tabs.get(2).active === true, "restore-mutation failure fixture did not leave the target tab active as expected");
}

async function testScreenshotRestoreVerificationFailureIsUnknown() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
  ]);
  const activations = [];
  let restoreApplied = false;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          if (restoreApplied && query.active && query.windowId === 5) throw new Error("restore verification response lost");
          return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)).map((tab) => ({ ...tab }));
        },
        async update(id, patch) {
          if (patch.active) {
            for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
            tabs.get(id).active = true;
            activations.push(id);
            if (id === 1) restoreApplied = true;
          }
          return { ...tabs.get(id) };
        },
        async captureVisibleTab() { return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "restoration may have been dispatched; the active-tab outcome is unknown",
  );
  assert(activations.join(",") === "2,1" && tabs.get(1).active === true,
    "post-restore verification failure did not preserve the completed restoration while reporting uncertainty");
}

async function testScreenshotMovedRestoreBaselineDoesNotTouchOtherWindow() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
    [3, { id: 3, windowId: 9, active: true, title: "Other window", url: "https://example.test/other" }],
  ]);
  const activations = [];
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
        async captureVisibleTab() {
          tabs.get(1).windowId = 9;
          tabs.get(1).active = false;
          return "data:image/png;base64,AAAA";
        },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "could not restore the previous active tab",
  );
  assert(activations.join(",") === "2",
    "screenshot restoration activated a baseline tab after it moved into another window");
  assert(tabs.get(2).active === true && tabs.get(3).active === true && tabs.get(1).active === false,
    "screenshot restoration overwrote active-tab state in the baseline tab's new window");
}

async function testScreenshotRejectsActiveTabChangeBeforeActivation() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
    [3, { id: 3, windowId: 5, active: false, title: "User choice", url: "https://example.test/user" }],
  ]);
  const activations = [];
  let captures = 0;
  let activeQueries = 0;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          if (query.active && query.windowId === 5) {
            activeQueries += 1;
            if (activeQueries === 2) {
              tabs.get(1).active = false;
              tabs.get(3).active = true;
            }
          }
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
        async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "active tab changed before temporary activation",
  );
  assert(activeQueries === 2, "screenshot did not perform the last-hop active-tab revalidation before activation");
  assert(activations.length === 0, "screenshot overwrote a user tab switch that happened before helper activation");
  assert(captures === 0, "screenshot capture ran after the active-tab baseline changed before helper activation");
  assert(tabs.get(3).active === true, "screenshot did not preserve the user's pre-activation tab switch");
}

async function testScreenshotRejectsActiveTabChangeDuringCapture() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
    [3, { id: 3, windowId: 5, active: false, title: "User choice", url: "https://example.test/user" }],
  ]);
  const activations = [];
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
        async captureVisibleTab() {
          for (const tab of tabs.values()) if (tab.windowId === 5) tab.active = false;
          tabs.get(3).active = true;
          return "data:image/png;base64,WRONGTAB";
        },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "active tab changed during capture",
  );
  assert(activations.join(",") === "2", "screenshot race handling overwrote the user's concurrent tab switch while trying to restore the old tab");
  assert(tabs.get(3).active === true, "screenshot race handling did not preserve the user's concurrent active tab");
}

async function testScreenshotActivationFailureIsUnknown() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
  ]);
  const activations = [];
  let captures = 0;
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
          if (id === 2) throw new Error("activation response lost after request");
          return { ...tabs.get(id) };
        },
        async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "temporary tab activation may have been dispatched; the outcome is unknown",
  );
  assert(activations.join(",") === "2,1",
    "ambiguous screenshot activation was retried or failed to run the guarded best-effort restore exactly once");
  assert(captures === 0, "screenshot capture ran after the temporary activation response became ambiguous");
  assert(tabs.get(1).active === true && tabs.get(2).active === false,
    "guarded restoration did not undo a helper-owned activation after the activation response became ambiguous");
}

async function testScreenshotWindowChangeDuringActivationIsUnknown() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
    [3, { id: 3, windowId: 9, active: true, title: "Other window", url: "https://example.test/other" }],
  ]);
  const activations = [];
  let captures = 0;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)).map((tab) => ({ ...tab }));
        },
        async update(id, patch) {
          if (patch.active && id === 2) {
            tabs.get(2).windowId = 9;
            for (const tab of tabs.values()) if (tab.windowId === 9) tab.active = false;
            tabs.get(2).active = true;
            activations.push(id);
          } else if (patch.active) {
            activations.push(id);
            tabs.get(id).active = true;
          }
          return { ...tabs.get(id) };
        },
        async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "outcome is unknown because target window provenance changed",
  );
  assert(captures === 0 && activations.join(",") === "2",
    "cross-window screenshot activation captured or rolled back using a stale restore baseline");
  assert(tabs.get(1).active === true && tabs.get(2).active === true && tabs.get(3).active === false,
    "cross-window activation uncertainty did not preserve the actual post-activation state for inspection");
}

async function testScreenshotPreCaptureVerificationFailureRestoresTab() {
  const tabs = new Map([
    [1, { id: 1, windowId: 5, active: true, title: "Original", url: "https://example.test/original" }],
    [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
  ]);
  const activations = [];
  let activeQueries = 0;
  let captures = 0;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { ...tabs.get(id) }; },
        async query(query) {
          if (query.active && query.windowId === 5) {
            activeQueries += 1;
            if (activeQueries === 3) throw new Error("active query transport failed before capture");
          }
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
        async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(
    () => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, {}),
    "could not verify target tab at capture boundary",
  );
  assert(captures === 0, "capture ran after pre-capture active-tab identity became unverifiable");
  assert(activations.join(",") === "2,1", "resolved temporary activation was not restored from the screenshot finally path");
  assert(tabs.get(1).active === true, "pre-capture verification failure left the temporary target tab active");
}

async function testNavigationMutationApiFailureIsUnknown() {
  for (const action of ["navigate", "reload", "back", "forward"]) {
    let mutationCalls = 0;
    const tabs = {
      async get(id) { return { id, windowId: 1, active: true, title: "Navigation", url: "https://example.test/start" }; },
      async update() { mutationCalls += 1; throw new Error("navigation transport response lost after request"); },
      async reload() { mutationCalls += 1; throw new Error("reload transport response lost after request"); },
      async goBack() { mutationCalls += 1; throw new Error("back transport response lost after request"); },
      async goForward() { mutationCalls += 1; throw new Error("forward transport response lost after request"); },
    };
    const context = createContext({ chrome: baseChrome({ tabs }) });
    const api = loadBrowserOperations(context);
    const params = {
      tabId: 7,
      action,
      waitFor: "none",
      ...(action === "navigate" ? { url: "https://example.test/next" } : {}),
    };
    await expectReject(() => api.dispatch("action", params, { timeoutMs: 30000 }), "outcome is unknown");
    assert(mutationCalls === 1, `${action} mutation API rejection was retried or skipped`);
  }

  let invalidNavigateCalls = 0;
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { id, windowId: 1, active: true, title: "Navigation", url: "https://example.test/start" }; },
        async update() { invalidNavigateCalls += 1; return {}; },
      },
    }),
  });
  const api = loadBrowserOperations(context);
  await expectReject(() => api.dispatch("action", { tabId: 7, action: "navigate", waitFor: "none" }, { timeoutMs: 30000 }), "navigate requires url");
  assert(invalidNavigateCalls === 0, "invalid navigate request crossed the mutation API boundary before validation");
}

async function testHistoryActionRevalidatesExpectedDocumentBeforeMutation() {
  for (const action of ["reload", "back", "forward"]) {
    let chromeMutationCalls = 0;
    let rendererMutationCalls = 0;
    let rendererPayload = null;
    const tabs = {
      async get(id) { return { id, windowId: 1, active: true, title: "History", url: "https://example.test/same" }; },
      async reload() { chromeMutationCalls += 1; },
      async goBack() { chromeMutationCalls += 1; },
      async goForward() { chromeMutationCalls += 1; },
    };
    const scripting = {
      async executeScript(options) {
        if (options.files) return [];
        if (options.args?.[0] === "historyAction") {
          rendererMutationCalls += 1;
          rendererPayload = options.args?.[1];
          return pageMutationSuccess({ dispatched: true });
        }
        throw new Error("unexpected snapshot history mutation script");
      },
    };
    const context = createContext({ chrome: baseChrome({ tabs, scripting }) });
    const api = loadBrowserOperations(context);
    await api.dispatch("action", {
      tabId: 7,
      action,
      waitFor: "none",
      expectedTabUrl: "https://example.test/same",
      expectedDocumentEpoch: "doc-stable",
      expectedHistoryEntryKey: "history-stable",
    }, { timeoutMs: 30000 });
    assert(chromeMutationCalls === 0 && rendererMutationCalls === 1,
      `${action} snapshot-bound history action did not move mutation into the renderer-side last-hop boundary`);
    assert(rendererPayload?.action === action
      && rendererPayload?.expectedTabUrl === "https://example.test/same"
      && rendererPayload?.expectedDocumentEpoch === "doc-stable"
      && rendererPayload?.expectedHistoryEntryKey === "history-stable",
    `${action} renderer-side history mutation lost snapshot authority evidence`);
  }

  for (const message of [
    "snapshot browser tab changed before navigation dispatch; observe again",
    "snapshot history document changed before dispatch; observe again",
    "snapshot history entry changed before dispatch; observe again",
    "snapshot history entry could not be verified before dispatch; observe again",
    "snapshot browser history has no back entry before dispatch; observe again",
    "snapshot browser history has no forward entry before dispatch; observe again",
    "snapshot history mutation API is unavailable before dispatch; observe again",
  ]) {
    let chromeMutationCalls = 0;
    let rendererMutationCalls = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { id, windowId: 1, active: true, title: "History", url: "https://example.test/same" }; },
          async goBack() { chromeMutationCalls += 1; },
        },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] !== "historyAction") throw new Error("unexpected history-entry mutation script");
            rendererMutationCalls += 1;
            return pageMutationFailure(message);
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(
      () => api.dispatch("action", {
        tabId: 7, action: "back", waitFor: "none", expectedTabUrl: "https://example.test/same",
        expectedDocumentEpoch: "doc-stable", expectedHistoryEntryKey: "history-old",
      }, { timeoutMs: 30000 }),
      message,
    );
    assert(chromeMutationCalls === 0 && rendererMutationCalls === 1,
      "renderer-side stale history rejection escaped to the generic chrome.tabs mutation path");
  }

  let lostResponseChromeMutations = 0;
  let lostResponseRendererCalls = 0;
  const lostResponseContext = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { id, windowId: 1, active: true, title: "History", url: "https://example.test/same" }; },
        async goBack() { lostResponseChromeMutations += 1; },
      },
      scripting: {
        async executeScript(options) {
          if (options.files) return [];
          if (options.args?.[0] !== "historyAction") throw new Error("unexpected history mutation script");
          lostResponseRendererCalls += 1;
          throw new Error("renderer navigation destroyed the mutation response");
        },
      },
    }),
  });
  const lostResponseApi = loadBrowserOperations(lostResponseContext);
  await expectReject(
    () => lostResponseApi.dispatch("action", {
      tabId: 7, action: "back", waitFor: "none", expectedTabUrl: "https://example.test/same",
      expectedDocumentEpoch: "doc-stable", expectedHistoryEntryKey: "history-old",
    }, { timeoutMs: 30000 }),
    "browser action may have been dispatched; the action outcome is unknown because the page mutation scripting call did not settle",
  );
  assert(lostResponseChromeMutations === 0 && lostResponseRendererCalls === 1,
    "uncertain renderer-side history dispatch was replayed through chrome.tabs history mutation");

  let navigateTabReads = 0;
  let navigateMutationCalls = 0;
  const navigateContext = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) {
          navigateTabReads += 1;
          return {
            id, windowId: 1, active: true, title: "Navigate",
            url: navigateTabReads === 1 ? "https://example.test/original" : "https://example.test/user-changed",
          };
        },
        async update() { navigateMutationCalls += 1; return {}; },
      },
    }),
  });
  const navigateApi = loadBrowserOperations(navigateContext);
  await expectReject(
    () => navigateApi.dispatch("action", {
      tabId: 7, action: "navigate", url: "https://example.test/destination", waitFor: "none",
      expectedTabUrl: "https://example.test/original",
    }, { timeoutMs: 30000 }),
    "snapshot browser tab changed before navigation dispatch; observe again",
  );
  assert(navigateMutationCalls === 0, "navigate overwrote a user navigation that happened after initial tab resolution");

  let moduleFailureMutationCalls = 0;
  const moduleFailureContext = createContext({
    chrome: baseChrome({
      tabs: {
        async get(id) { return { id, windowId: 1, active: true, title: "History", url: "https://example.test/same" }; },
        async reload() { moduleFailureMutationCalls += 1; },
      },
      scripting: {
        async executeScript(options) {
          if (options.files) throw new Error("page automation module injection unavailable");
          throw new Error("history mutation unexpectedly reached dispatch script");
        },
      },
    }),
  });
  const moduleFailureApi = loadBrowserOperations(moduleFailureContext);
  await expectReject(
    () => moduleFailureApi.dispatch("action", {
      tabId: 7, action: "reload", waitFor: "none", expectedTabUrl: "https://example.test/same", expectedDocumentEpoch: "doc-old",
    }, { timeoutMs: 30000 }),
    "page automation module injection unavailable",
  );
  assert(moduleFailureMutationCalls === 0,
    "snapshot-bound reload crossed a mutation boundary after page automation injection failed before dispatch");
}

async function testPostActionMetadataReadDoesNotRewriteSettlement() {
  {
    let tabReads = 0;
    let navigationCalls = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: true, title: "Before", url: "https://example.test/before", status: "complete" };
            throw new Error("post-navigation tab metadata unavailable");
          },
          async update(id, patch) {
            navigationCalls += 1;
            return { id, windowId: 5, active: true, title: "Before", url: patch.url, status: "loading" };
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    const result = await api.dispatch("action", {
      tabId: 7, action: "navigate", url: "https://example.test/after", waitFor: "none",
    }, { timeoutMs: 30000 });
    assert(navigationCalls === 1, "successful navigation was replayed after post-action metadata became unavailable");
    assert(result.tab_id === 7 && result.tab_metadata_verified === false,
      "successful navigation did not preserve settlement with explicit metadata uncertainty");
    assert(!Object.hasOwn(result, "title") && !Object.hasOwn(result, "url"),
      "successful navigation reused or invented tab provenance after metadata read failure");
  }

  {
    let tabReads = 0;
    let pageActions = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: true, title: "Before", url: "https://example.test/before", status: "complete" };
            throw new Error("post-action tab metadata unavailable");
          },
        },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] === "action") {
              pageActions += 1;
              return pageMutationSuccess({ ok: true, matched: 1 });
            }
            throw new Error(`unexpected page operation: ${options.args?.[0]}`);
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    const result = await api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 });
    assert(pageActions === 1, "successful page action was replayed after post-action metadata became unavailable");
    assert(result.ok === true && result.tab_id === 7 && result.tab_metadata_verified === false,
      "successful page action did not preserve settlement with explicit metadata uncertainty");
    assert(!Object.hasOwn(result, "title") && !Object.hasOwn(result, "url"),
      "successful page action reused or invented tab provenance after metadata read failure");
  }

  for (const [method, operation, params] of [
    ["fill_form", "fillForm", { tabId: 7, frameId: 0, fields: [{ selector: { id: "field" }, value: "x", action: "fill", sensitive: false }], waitFor: "none" }],
    ["upload_files", "uploadFiles", { tabId: 7, frameId: 0, selector: { id: "file" }, files: [{ filename: "a.txt", mime: "text/plain", data: "YQ==" }] }],
  ]) {
    let tabReads = 0;
    let mutations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: true, title: "Before", url: "https://example.test/before", status: "complete" };
            throw new Error(`post-${method} tab metadata unavailable`);
          },
        },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] === operation) {
              mutations += 1;
              return pageMutationSuccess({ ok: true, changed: 1 });
            }
            throw new Error(`unexpected page operation: ${options.args?.[0]}`);
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    const result = await api.dispatch(method, params, { timeoutMs: 30000 });
    assert(mutations === 1, `${method} was replayed after post-action tab metadata became unavailable`);
    assert(result.ok === true && result.tab_id === 7 && result.tab_metadata_verified === false,
      `${method} did not preserve successful settlement with explicit metadata uncertainty`);
    assert(!Object.hasOwn(result, "title") && !Object.hasOwn(result, "url"),
      `${method} reused or invented pre-action tab provenance after metadata read failure`);
  }

  {
    let tabReads = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: true, title: "Before", url: "https://example.test/before", status: "complete" };
            return { id, windowId: 5, active: true, title: "After", url: "https://example.test/after", status: "complete" };
          },
        },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] === "action") return pageMutationSuccess({ ok: true, matched: 1 });
            throw new Error(`unexpected page operation: ${options.args?.[0]}`);
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    const result = await api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none",
    }, { timeoutMs: 30000 });
    assert(result.tab_metadata_verified === true && result.title === "After" && result.url === "https://example.test/after",
      "successful post-action metadata read did not replace pre-action provenance with the verified current tab");
  }
}

async function testTabMutationApiFailuresAreUnknown() {
  {
    let creates = 0;
    const context = createContext({
      chrome: baseChrome({ tabs: { async create() { creates += 1; throw new Error("create response lost"); } } }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("manage_tabs", { action: "new", url: "https://example.test/", active: true }, {}), "outcome is unknown");
    assert(creates === 1, "new-tab mutation API rejection was retried or skipped");
  }

  {
    let tabReads = 0;
    let activations = 0;
    let windowFocuses = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { tabReads += 1; return { id, windowId: 5, active: false, title: "Target", url: "https://example.test/" }; },
          async update() { activations += 1; throw new Error("activation response lost"); },
        },
        windows: { async update() { windowFocuses += 1; return {}; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {}), "outcome is unknown");
    assert(tabReads === 1 && activations === 1 && windowFocuses === 0,
      "tab activation rejection crossed the mutation boundary more than once or continued to window focus");
  }

  {
    let tabReads = 0;
    let activations = 0;
    let windowFocuses = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            return { id, windowId: 5, active: tabReads > 1, title: "Target", url: "https://example.test/" };
          },
          async update(id) { activations += 1; return { id, windowId: 5, active: true, title: "Target", url: "https://example.test/" }; },
        },
        windows: { async update() { windowFocuses += 1; throw new Error("window focus response lost"); } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {}), "outcome is unknown");
    assert(tabReads === 2 && activations === 1 && windowFocuses === 1,
      "partial tab activation was retried, rolled back, or followed by post-focus verification after window-focus uncertainty");
  }

  {
    let removes = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { id, windowId: 5, active: true, title: "Close", url: "https://example.test/" }; },
          async remove() { removes += 1; throw new Error("close response lost"); },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("manage_tabs", { action: "close", tabId: 7 }, {}), "outcome is unknown");
    assert(removes === 1, "tab close mutation API rejection was retried or skipped");
  }

  {
    let tabReads = 0;
    let focusedWindowId = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: false, title: "Before", url: "https://example.test/before" };
            if (tabReads === 2) return { id, windowId: 11, active: true, title: "Moved", url: "https://example.test/moved" };
            return { id, windowId: 11, active: true, title: "Focused", url: "https://example.test/focused" };
          },
          async update(id) { return { id, windowId: 9, active: true, title: "Activated", url: "https://example.test/activated" }; },
        },
        windows: { async update(id) { focusedWindowId = id; return { id, focused: true }; } },
      }),
    });
    const api = loadBrowserOperations(context);
    const result = await api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {});
    assert(result.action === "activate" && result.active === undefined && result.tab_id === 7 && result.window_id === 11
      && result.title === "Focused" && result.url === "https://example.test/focused",
    "successful tab activation did not return final verified target-tab provenance");
    assert(tabReads === 3 && focusedWindowId === 11,
      "successful tab activation focused stale activation-response window provenance instead of the freshly verified current window");
  }

  {
    let tabReads = 0;
    const focusedWindowIds = [];
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: false, title: "Before", url: "https://example.test/before" };
            if (tabReads === 2) return { id, windowId: 9, active: true, title: "Ready", url: "https://example.test/ready" };
            return { id, windowId: 12, active: true, title: "Moved again", url: "https://example.test/moved-again" };
          },
          async update(id) { return { id, windowId: 9, active: true, title: "Activated", url: "https://example.test/activated" }; },
        },
        windows: { async update(id) { focusedWindowIds.push(id); return { id, focused: true }; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(
      () => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {}),
      "activation and window focus completed but the target tab moved windows",
    );
    assert(tabReads === 3 && focusedWindowIds.join(",") === "9",
      "tab activation automatically refocused after the target moved windows during the focus stage");
  }

  {
    let tabReads = 0;
    let windowFocuses = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            tabReads += 1;
            if (tabReads === 1) return { id, windowId: 5, active: false, title: "Before", url: "https://example.test/before" };
            return { id, windowId: 9, active: false, title: "User switched", url: "https://example.test/switched" };
          },
          async update(id) { return { id, windowId: 9, active: true, title: "Activated", url: "https://example.test/activated" }; },
        },
        windows: { async update() { windowFocuses += 1; return {}; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(
      () => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {}),
      "activation completed but the target tab was no longer active before focus",
    );
    assert(tabReads === 2 && windowFocuses === 0,
      "tab activation focused a window after the user changed the active tab before the focus stage");
  }

  {
    let windowFocuses = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { id, windowId: 5, active: false, title: "Target", url: "https://example.test/" }; },
          async update(id) { return { id, active: true, title: "Target", url: "https://example.test/moved" }; },
        },
        windows: { async update() { windowFocuses += 1; return {}; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(
      () => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, {}),
      "activation completed but its current window is unavailable before focus",
    );
    assert(windowFocuses === 0,
      "tab activation guessed a stale window after the activation response omitted current window provenance");
  }
}

async function testBrokerRejectsCoercibleMutationParameters() {
  let creates = 0;
  let updates = 0;
  let captures = 0;
  let pageScripts = 0;
  const tab = { id: 7, windowId: 5, active: true, title: "Fixture", url: "https://example.test/", status: "complete" };
  const context = createContext({
    chrome: baseChrome({
      tabs: {
        async create() { creates += 1; return { ...tab }; },
        async get(id) { return { ...tab, id }; },
        async query() { return [{ ...tab }]; },
        async update(id) { updates += 1; return { ...tab, id }; },
        async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
        async remove() { updates += 1; },
        onUpdated: listener(), onRemoved: listener(),
      },
      windows: { async update() { updates += 1; return {}; } },
      scripting: { async executeScript() { pageScripts += 1; return []; } },
    }),
  });
  const api = loadBrowserOperations(context);
  for (const [params, expected] of [
    [{ action: ["new"], url: "https://example.test/", active: true }, "invalid"],
    [{ action: "new", url: ["https://example.test/"], active: true }, "invalid"],
    [{ action: "new", url: "https://example.test/", active: "false" }, "must be boolean"],
    [{ action: "activate", tabId: "7" }, "invalid"],
    [{ action: "close", tabId: [7] }, "invalid"],
  ]) await expectReject(() => api.dispatch("manage_tabs", params, {}), expected);
  assert(creates === 0 && updates === 0, "coercible tab mutation metadata reached a Chrome tab/window mutation API");

  for (const [params, expected] of [
    [{ tabId: "7", format: "png", quality: 90, allowTabSwitch: true }, "invalid"],
    [{ tabId: 7, format: ["png"], quality: 90, allowTabSwitch: true }, "invalid"],
    [{ tabId: 7, format: "png", quality: "90", allowTabSwitch: true }, "invalid"],
    [{ tabId: 7, format: "png", quality: 90, allowTabSwitch: "false" }, "must be boolean"],
  ]) await expectReject(() => api.dispatch("screenshot", params, {}), expected);
  assert(updates === 0 && captures === 0, "coercible screenshot metadata reached temporary tab activation or capture");

  for (const [params, expected] of [
    [{ tabId: 7, action: "navigate", url: ["https://example.test/next"], waitFor: "none" }, "valid absolute url"],
    [{ tabId: 7, action: "click", frameId: "0", waitFor: "none", inputMode: "auto", elementTimeoutMs: 10000 }, "frame id is invalid"],
    [{ tabId: 7, action: "click", waitFor: ["none"], inputMode: "auto", elementTimeoutMs: 10000 }, "waitFor is invalid"],
    [{ tabId: 7, action: "click", waitFor: "none", inputMode: ["auto"], elementTimeoutMs: 10000 }, "inputMode is invalid"],
    [{ tabId: 7, action: "click", waitFor: "none", inputMode: "auto", elementTimeoutMs: "10000" }, "elementTimeoutMs is invalid"],
    [{ tabId: 7, action: "fill", waitFor: "none", inputMode: "dom", elementTimeoutMs: 10000, value: ["x"] }, "value is invalid"],
    [{ tabId: 7, action: "press", waitFor: "none", inputMode: "auto", elementTimeoutMs: 10000, key: ["Enter"] }, "key is invalid"],
  ]) await expectReject(() => api.dispatch("action", params, { timeoutMs: 30000 }), expected);
  assert(updates === 0 && pageScripts === 0, "coercible browser action metadata reached navigation or renderer mutation preparation");

  for (const [method, params, expected] of [
    ["get_source", { tabId: 7, maxBytes: 4 * 1024 * 1024 + 1, allFrames: false }, "maxBytes is invalid"],
    ["get_source", { tabId: 7, maxBytes: "1024", allFrames: false }, "maxBytes is invalid"],
    ["get_source", { tabId: 7, maxBytes: 1024, allFrames: "false" }, "must be boolean"],
    ["inspect_page", { tabId: 7, maxElements: 1001, allFrames: true, includeValues: false }, "maxElements is invalid"],
    ["inspect_page", { tabId: 7, maxElements: "300", allFrames: true, includeValues: false }, "maxElements is invalid"],
    ["inspect_page", { tabId: 7, maxElements: 300, allFrames: true, includeValues: "false" }, "must be boolean"],
    ["inspect_page", { tabId: 7, maxElements: 300, allFrames: true, includeValues: false, includePrivateHistory: "false" }, "must be boolean"],
    ["wait", { tabId: 7, text: "Ready", timeoutMs: "30000" }, "timeoutMs is invalid"],
    ["wait", { tabId: 7, frameId: "0", text: "Ready", timeoutMs: 30000 }, "frame id is invalid"],
    ["wait", { tabId: 7, selector: { ref: "e1" }, state: ["visible"], timeoutMs: 30000 }, "state is invalid"],
  ]) await expectReject(() => api.dispatch(method, params, {}), expected);
  assert(pageScripts === 0, "coercible or over-budget browser read metadata reached page source/inspection execution");

  const aggregateFormFields = Array.from({ length: 33 }, (_, index) => ({
    selector: { id: `field-${index}` }, action: "fill", value: "a".repeat(128 * 1024), sensitive: false,
  }));
  for (const [params, expected] of [
    [{ tabId: 7, fields: aggregateFormFields, submit: false, waitFor: "none", elementTimeoutMs: 10000 }, "4 MiB aggregate budget"],
    [{ tabId: 7, fields: [{ selector: { id: "x" }, action: "fill", value: "x", sensitive: "false" }], submit: false, waitFor: "none", elementTimeoutMs: 10000 }, "sensitive flag must be boolean"],
    [{ tabId: 7, fields: [{ selector: { id: "x" }, action: ["fill"], value: "x", sensitive: false }], submit: false, waitFor: "none", elementTimeoutMs: 10000 }, "action is invalid"],
    [{ tabId: 7, fields: [{ selector: { id: "x" }, action: "fill", value: "x", sensitive: false }], submit: "false", waitFor: "none", elementTimeoutMs: 10000 }, "must be boolean"],
  ]) await expectReject(() => api.dispatch("fill_form", params, { timeoutMs: 30000 }), expected);
  const oneMiB = Buffer.alloc(1024 * 1024, 0x61).toString("base64");
  const aggregateUploads = Array.from({ length: 6 }, (_, index) => ({ filename: `file-${index}.bin`, mime: "application/octet-stream", data: oneMiB }));
  for (const [params, expected] of [
    [{ tabId: 7, selector: { id: "file" }, files: aggregateUploads, elementTimeoutMs: 10000 }, "5 MiB aggregate budget"],
    [{ tabId: 7, selector: { id: "file" }, files: [{ filename: ["x.bin"], mime: "application/octet-stream", data: "" }], elementTimeoutMs: 10000 }, "filename is invalid"],
    [{ tabId: 7, selector: { id: "file" }, files: [{ filename: "x.bin", mime: ["application/octet-stream"], data: "" }], elementTimeoutMs: 10000 }, "mime is invalid"],
    [{ tabId: 7, selector: { id: "file" }, files: [{ filename: "x.bin", mime: "application/octet-stream", data: ["AAAA"] }], elementTimeoutMs: 10000 }, "data is invalid"],
  ]) await expectReject(() => api.dispatch("upload_files", params, { timeoutMs: 30000 }), expected);
  assert(pageScripts === 0, "malformed or over-budget form/upload payload reached renderer execution");
}

async function testCancellationStopsUnstartedBrowserMutations() {
  {
    const state = { cancelled: false };
    let tabUpdates = 0;
    let windowUpdates = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            state.cancelled = true;
            return { id, windowId: 5, active: false, title: "Target", url: "https://example.test/" };
          },
          async update() { tabUpdates += 1; return {}; },
        },
        windows: { async update() { windowUpdates += 1; return {}; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("manage_tabs", { action: "activate", tabId: 7 }, state), "cancelled");
    assert(tabUpdates === 0 && windowUpdates === 0,
      "tab activation started after cancellation arrived during target-tab preflight");
  }

  {
    const state = { cancelled: false, timeoutMs: 30000 };
    let navigations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            state.cancelled = true;
            return { id, windowId: 5, active: true, title: "Before", url: "https://example.test/before" };
          },
          async update() { navigations += 1; return {}; },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "navigate", url: "https://example.test/after", waitFor: "none",
    }, state), "cancelled");
    assert(navigations === 0, "navigation mutation started after cancellation arrived during target-tab preflight");
  }

  {
    const state = { cancelled: false, timeoutMs: 30000 };
    let trustedDispatches = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; },
        },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] === "prepareAction") {
              state.cancelled = true;
              return pageMutationSuccess({ point: { x: 20, y: 30 } });
            }
            throw new Error(`unexpected page operation: ${options.args?.[0]}`);
          },
        },
      }),
      __machineBridgeDevtoolsInput: {
        async perform() { trustedDispatches += 1; },
      },
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "trusted", selector: { css: "button" }, waitFor: "none",
    }, state), "cancelled");
    assert(trustedDispatches === 0,
      "trusted input started after cancellation arrived during prepareAction preflight");
  }

  {
    const state = { cancelled: false, timeoutMs: 30000 };
    let preparationInvocations = 0;
    let trustedDispatches = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) return [];
            if (options.args?.[0] !== "prepareAction") throw new Error(`unexpected page operation: ${options.args?.[0]}`);
            preparationInvocations += 1;
            return pageMutationSuccess({ point: { x: 20, y: 30 } });
          },
        },
      }),
      __machineBridgeDevtoolsInput: {
        async perform(_tabId, _action, details) {
          state.cancelled = true;
          details.beforeDispatch();
          trustedDispatches += 1;
        },
      },
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("action", {
      tabId: 7, action: "click", inputMode: "trusted", selector: { css: "button" }, waitFor: "none",
    }, state), "outcome is unknown");
    assert(preparationInvocations === 1 && trustedDispatches === 0,
      "trusted page action started Input after cancellation arrived while its debugger session was queued");
  }

  for (const [method, params] of [
    ["fill_form", { tabId: 7, fields: [{ selector: { id: "field" }, value: "changed", action: "fill", sensitive: false }], waitFor: "none" }],
    ["upload_files", { tabId: 7, selector: { id: "file" }, files: [{ filename: "a.txt", mime: "text/plain", data: "YQ==" }] }],
  ]) {
    const state = { cancelled: false, timeoutMs: 30000 };
    let pageMutations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) {
            state.cancelled = true;
            return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" };
          },
        },
        scripting: { async executeScript() { pageMutations += 1; return []; } },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch(method, params, state), "cancelled");
    assert(pageMutations === 0, `${method} started after cancellation arrived during target-tab preflight`);
  }

  for (const [method, params] of [
    ["action", { tabId: 7, action: "click", inputMode: "dom", selector: { css: "button" }, waitFor: "none" }],
    ["fill_form", { tabId: 7, fields: [{ selector: { id: "field" }, value: "changed", action: "fill", sensitive: false }], waitFor: "none" }],
    ["upload_files", { tabId: 7, selector: { id: "file" }, files: [{ filename: "a.txt", mime: "text/plain", data: "YQ==" }] }],
  ]) {
    const state = { cancelled: false, timeoutMs: 30000 };
    let moduleLoads = 0;
    let pageMutations = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: { async get(id) { return { id, windowId: 5, active: true, title: "Page", url: "https://example.test/" }; } },
        scripting: {
          async executeScript(options) {
            if (options.files) {
              moduleLoads += 1;
              state.cancelled = true;
              return [];
            }
            pageMutations += 1;
            return pageMutationSuccess({ ok: true });
          },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch(method, params, state), "cancelled");
    assert(moduleLoads === 1 && pageMutations === 0,
      `${method} page mutation started after cancellation arrived during mutation-free module setup`);
  }

  {
    const state = { cancelled: false };
    let activations = 0;
    let captures = 0;
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { id, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }; },
          async query() {
            state.cancelled = true;
            return [{ id: 1, windowId: 5, active: true, title: "Previous", url: "https://example.test/previous" }];
          },
          async update() { activations += 1; return {}; },
          async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, state), "cancelled");
    assert(activations === 0 && captures === 0,
      "screenshot activation or capture started after cancellation arrived during restore-baseline preflight");
  }

  {
    const state = { cancelled: false };
    let activeId = 1;
    let captures = 0;
    const activations = [];
    const tabs = new Map([
      [1, { id: 1, windowId: 5, active: true, title: "Previous", url: "https://example.test/previous" }],
      [2, { id: 2, windowId: 5, active: false, title: "Target", url: "https://example.test/target" }],
    ]);
    const context = createContext({
      chrome: baseChrome({
        tabs: {
          async get(id) { return { ...tabs.get(id) }; },
          async query() { return [{ ...tabs.get(activeId), active: true }]; },
          async update(id, patch) {
            if (patch.active) {
              activations.push(id);
              tabs.get(activeId).active = false;
              activeId = id;
              tabs.get(activeId).active = true;
              if (id === 2) state.cancelled = true;
            }
            return { ...tabs.get(id) };
          },
          async captureVisibleTab() { captures += 1; return "data:image/png;base64,AAAA"; },
        },
      }),
    });
    const api = loadBrowserOperations(context);
    await expectReject(() => api.dispatch("screenshot", { tabId: 2, format: "png", quality: 90 }, state), "cancelled");
    assert(captures === 0 && activations.join(",") === "2,1" && activeId === 1,
      "screenshot cancellation after temporary activation did not skip capture and restore the previous active tab");
  }
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
  await expectReject(() => navigation, "outcome is unknown");
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
  assert(inspected.frames.length === 64 && inspected.frames_truncated === true, "frame inspection did not enforce the accessible-frame cap");
  assert(inspected.total_elements === 10, "global salience inspection exceeded the aggregate returned-element budget");
  assert(inspected.selection?.strategy === "global_salience"
    && inspected.selection.frames_scanned === 64
    && inspected.selection.per_frame_probe_budget === 1
    && inspected.selection.probed_elements === 64
    && inspected.selection.candidate_truncated === true,
  "global salience inspection lost its bounded cross-frame probe accounting");
  assert(allocatedElements.reduce((sum, value) => sum + value, 0) === 64, "global salience probing did not stay within one bounded candidate per scanned frame");
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
  for (const malformedLimit of ["1024", [1024], 1.5, null, {}]) {
    const boundedMalformed = api.boundedDocumentSource(malformedLimit);
    assert(boundedMalformed.returned_bytes <= 1,
      "coercible DOM source budget expanded the renderer read boundary");
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

function pageMutationSuccess(result) {
  return [{ result: { protocol: "machine_bridge_page_mutation_v1", ok: true, result } }];
}

function pageMutationFailure(error) {
  return [{ result: { protocol: "machine_bridge_page_mutation_v1", ok: false, error } }];
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
