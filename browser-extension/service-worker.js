importScripts("browser-error-boundary.js", "broker-auth.js", "pairing-bootstrap.js", "devtools-session.js", "devtools-input.js", "devtools-observation.js", "browser-operations.js");
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let connectGeneration = 0;
let authenticating = false;
const MAX_RESULT_BYTES = 7 * 1024 * 1024;
const BROWSER_EXTENSION_PROTOCOL = 3;
const HANDSHAKE_TIMEOUT_MS = 3000;
const MAX_ACTIVE_REQUESTS = 32;
const activeRequests = new Map();
chrome.runtime.onInstalled.addListener(() => { ensureReconnectAlarm(); void connectFromStorage(); });
chrome.runtime.onStartup.addListener(() => { ensureReconnectAlarm(); void connectFromStorage(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "machine-bridge-reconnect") void connectFromStorage();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "machine_bridge_internal_delay") {
    if (sender?.id !== chrome.runtime.id) return false;
    const delayMs = message.delay_ms;
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 250) {
      sendResponse({ ok: false });
      return false;
    }
    setTimeout(() => sendResponse({ ok: true }), delayMs);
    return true;
  }
  if (message?.type !== "pair_bootstrap") return false;
  pairFromBootstrap(message.port, message.grant, { replace: false })
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true;
});
chrome.action.onClicked.addListener((tab) => void handleActionClick(tab));
async function handleActionClick(tab) {
  const pairingPage = tab?.id ? browserBrokerAuth().parsePairingPage(tab.url) : null;
  if (pairingPage) {
    try {
      const material = await chrome.tabs.sendMessage(tab.id, { type: "machine_bridge_pairing_material" });
      if (material?.grant && Number.isInteger(Number(material.port))) {
        const paired = await pairFromBootstrap(material.port, material.grant, { replace: true });
        await setPairingPageStatus(tab.id, paired.ok === true ? "Paired. You may close this tab." : "Pairing failed.");
        return;
      }
    } catch {
      // A token-free or stale pairing tab has no isolated bootstrap material; fall through to the explicit re-pair instruction.
    }
    await setPairingPageStatus(tab.id, "Pairing grant unavailable. Run pair_browser_extension with opening enabled again.")
      .catch(() => { /* The stale pairing tab may already be gone; status decoration is best-effort. */ });
    return;
  }
  const current = await chrome.storage.local.get(["endpoint"]);
  const pairUrl = browserBrokerAuth().pairingUrlFromEndpoint(current.endpoint) || "http://127.0.0.1:39393/pair";
  await chrome.tabs.create({ url: pairUrl });
}

function setConnectionState(state) {
  const badge = state === "connected" ? "ON" : state === "connecting" ? "..." : state === "unconfigured" ? "?" : "!";
  const title = state === "connected"
    ? "Machine Bridge Browser: connected"
    : state === "connecting"
      ? "Machine Bridge Browser: connecting"
      : state === "unconfigured"
        ? "Machine Bridge Browser: click to open pairing"
        : "Machine Bridge Browser: disconnected; click to open pairing";
  ignoreBrowserApiCall(() => chrome.action.setBadgeText({ text: badge }));
  ignoreBrowserApiCall(() => chrome.action.setTitle({ title }));
}

function ignoreBrowserApiCall(operation) {
  try {
    const value = operation();
    if (value && typeof value.catch === "function") value.catch(() => { /* Browser UI decoration is optional. */ });
  } catch {
    // Browser UI decoration is optional and must not disrupt broker connectivity.
  }
}

function closeSocketQuietly(ws, code, reason) {
  try {
    ws?.close(code, reason);
  } catch {
    // The socket may already be closed; reconnect state remains authoritative.
  }
}

function sendSocketQuietly(ws, payload) {
  try {
    ws.send(payload);
    return true;
  } catch {
    // A response cannot be recovered after the broker socket closes.
    return false;
  }
}

async function pairFromBootstrap(port, grant, { replace }) {
  const bootstrap = browserPairingBootstrap();
  const candidate = await bootstrap.bootstrapPairing(port, grant);
  return pairConfiguration(candidate.endpoint, candidate.token, { replace });
}

async function pairConfiguration(rawEndpoint, rawToken, { replace }) {
  const endpoint = String(rawEndpoint || "");
  const token = String(rawToken || "");
  const brokerEndpoint = browserBrokerAuth().parseBrokerEndpoint(endpoint);
  if (!brokerEndpoint || !/^[A-Za-z0-9_-]{32,100}$/.test(token)) return { ok: false, error: "invalid_pairing_material" };
  const current = await chrome.storage.local.get(["endpoint", "token"]);
  const alreadyPaired = Boolean(current.endpoint && current.token);
  const samePairing = current.endpoint === endpoint && current.token === token;
  if (alreadyPaired && samePairing
      && socket?.bridgeReady === true
      && socket.readyState === WebSocket.OPEN
      && socket.machineBridgeEndpoint === endpoint
      && socket.machineBridgeToken === token) {
    return { ok: true, replaced: false, already_connected: true };
  }
  if (alreadyPaired && !replace && !samePairing) return { ok: false, requires_manual_repair: true };
  setConnectionState("connecting");
  try {
    const connectedSocket = await connect(endpoint, token, { reconnect: false });
    await chrome.storage.local.set({ endpoint, token });
    connectedSocket.reconnectEnabled = true;
    if (connectedSocket.readyState !== WebSocket.OPEN || connectedSocket.bridgeReady !== true) {
      void connect(endpoint, token).catch(() => { /* The reconnect state machine owns subsequent retries. */ });
    }
    return { ok: true, replaced: alreadyPaired && !samePairing };
  } catch (error) {
    if (current.endpoint && current.token) {
      void connect(current.endpoint, current.token).catch(() => { /* Preserve the primary pairing error; prior-pair recovery is best-effort. */ });
    }
    throw error;
  }
}

function setPairingPageStatus(tabId, text) {
  return chrome.tabs.sendMessage(tabId, { type: "machine_bridge_pairing_status", text });
}

function browserPairingBootstrap() {
  const bootstrap = globalThis.__machineBridgePairingBootstrap;
  if (!bootstrap || typeof bootstrap.bootstrapPairing !== "function") throw new Error("browser pairing bootstrap module is unavailable");
  return bootstrap;
}

ensureReconnectAlarm();
void connectFromStorage();

function ensureReconnectAlarm() {
  chrome.alarms.create("machine-bridge-reconnect", { periodInMinutes: 1 });
}

async function connectFromStorage() {
  if (authenticating || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  const value = await chrome.storage.local.get(["endpoint", "token"]);
  if (value.endpoint && value.token) {
    setConnectionState("connecting");
    void connect(value.endpoint, value.token).catch(() => { /* Connection close/retry state is reflected by the socket lifecycle. */ });
  } else {
    setConnectionState("unconfigured");
  }
}

async function connect(endpoint, token, { reconnect = true } = {}) {
  const generation = ++connectGeneration;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.reconnectEnabled = false;
    clearInterval(socket.keepaliveTimer);
    socket.keepaliveTimer = null;
    cancelRequestsForSocket(socket);
    closeSocketQuietly(socket);
    socket = null;
  }
  authenticating = true;
  setConnectionState("connecting");
  let protocol;
  try { protocol = await extensionBrokerProtocol(endpoint, token); }
  finally { if (generation === connectGeneration) authenticating = false; }
  if (generation !== connectGeneration) throw new Error("browser connection was superseded");
  const ws = new WebSocket(endpoint, [protocol]);
  socket = ws;
  ws.bridgeReady = false;
  ws.serverHelloSeen = false;
  ws.machineBridgeEndpoint = endpoint;
  ws.machineBridgeToken = token;
  ws.reconnectEnabled = reconnect;
  ws.keepaliveTimer = null;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error); else resolvePromise(ws);
    };
    ws.onopen = () => {
      if (socket !== ws) {
        closeSocketQuietly(ws);
        settle(new Error("browser connection was superseded"));
        return;
      }
      ws.handshakeTimer = setTimeout(() => {
        closeSocketQuietly(ws, 1002, "browser broker handshake timed out");
      }, HANDSHAKE_TIMEOUT_MS);
    };
    ws.onmessage = (event) => void handleMessage(ws, event.data, () => settle());
    ws.onerror = () => { /* WebSocket close owns failure settlement and reconnect classification. */ };
    ws.onclose = () => {
      clearTimeout(ws.handshakeTimer);
      clearInterval(ws.keepaliveTimer);
      ws.keepaliveTimer = null;
      cancelRequestsForSocket(ws);
      if (!ws.bridgeReady) settle(new Error("browser broker handshake failed"));
      if (socket !== ws) return;
      socket = null;
      setConnectionState("disconnected");
      if (ws.reconnectEnabled) scheduleReconnect(endpoint, token);
    };
  });
}

function browserBrokerAuth() {
  const auth = globalThis.__machineBridgeBrokerAuth;
  if (!auth || typeof auth.extensionProtocol !== "function") throw new Error("browser broker authentication module is unavailable");
  return auth;
}

function extensionBrokerProtocol(endpoint, token) { return browserBrokerAuth().extensionProtocol(endpoint, token); }

function scheduleReconnect(endpoint, token) {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(() => {
    void connect(endpoint, token).catch(() => { /* A failed attempt schedules or awaits the next reconnect trigger. */ });
  }, delay);
}

async function handleMessage(ws, raw, onReady = () => {}) {
  let message;
  try { message = JSON.parse(String(raw)); } catch {
    closeSocketQuietly(ws, 1007, "invalid broker JSON");
    return;
  }
  if (message?.type === "hello") {
    if (ws.serverHelloSeen || message.role !== "extension" || message.protocol !== BROWSER_EXTENSION_PROTOCOL) {
      closeSocketQuietly(ws, 1002, "browser broker protocol mismatch");
      return;
    }
    ws.serverHelloSeen = true;
    const manifest = chrome.runtime.getManifest();
    const helloSent = sendSocketQuietly(ws, JSON.stringify({
      type: "hello",
      role: "extension",
      protocol: BROWSER_EXTENSION_PROTOCOL,
      version: manifest.version_name || manifest.version,
      extension_id: chrome.runtime.id,
      capabilities: ["semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits",
        "cdp_accessibility_snapshot", "cdp_surface_screenshot", "computer_observation_v1", "backend_node_trusted_input"],
    }));
    if (!helloSent) closeSocketQuietly(ws, 1011, "browser extension hello failed");
    return;
  }
  if (message?.type === "hello_ack") {
    if (ws.bridgeReady || !ws.serverHelloSeen || message.role !== "extension" || message.protocol !== BROWSER_EXTENSION_PROTOCOL) {
      closeSocketQuietly(ws, 1002, "invalid browser broker acknowledgement");
      return;
    }
    clearTimeout(ws.handshakeTimer);
    ws.bridgeReady = true;
    reconnectAttempt = 0;
    setConnectionState("connected");
    clearInterval(ws.keepaliveTimer);
    ws.keepaliveTimer = setInterval(() => {
      if (socket === ws && ws.bridgeReady && ws.readyState === WebSocket.OPEN
          && !sendSocketQuietly(ws, JSON.stringify({ type: "ping" }))) {
        closeSocketQuietly(ws, 1011, "browser extension keepalive failed");
      }
    }, 20000);
    onReady();
    return;
  }
  if (!ws.bridgeReady) {
    closeSocketQuietly(ws, 1002, "browser broker acknowledgement required");
    return;
  }
  if (message?.type === "cancel" && typeof message.id === "string") {
    const state = activeRequests.get(message.id);
    if (state) state.cancelled = true;
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
  if (activeRequests.has(message.id)) {
    closeSocketQuietly(ws, 1002, "duplicate browser request id");
    return;
  }
  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
    if (!sendResponse(ws, message.id, false, null, "too many concurrent browser requests")) {
      closeSocketQuietly(ws, 1011, "browser overload response delivery failed");
    }
    return;
  }
  const state = { cancelled: false, timeoutMs: browserOperations().boundedRequestTimeout(message.timeout_ms), socket: ws };
  activeRequests.set(message.id, state);
  try {
    throwIfCancelled(state);
    const result = await dispatch(message.method, message.params || {}, state);
    throwIfCancelled(state);
    if (!sendResponse(ws, message.id, true, result, "", message.method)) {
      closeSocketQuietly(ws, 1011, "browser response delivery failed");
    }
  } catch (error) {
    if (!state.cancelled && !sendResponse(ws, message.id, false, null, globalThis.__machineBridgeBrowserErrorBoundary.publicError(error))) {
      closeSocketQuietly(ws, 1011, "browser error delivery failed");
    }
  } finally {
    activeRequests.delete(message.id);
  }
}

function cancelRequestsForSocket(closedSocket) {
  for (const state of activeRequests.values()) {
    if (state.socket === closedSocket) state.cancelled = true;
  }
}

function throwIfCancelled(state) {
  if (state.cancelled) throw new Error("browser request cancelled");
}

function sendResponse(ws, id, ok, result, error = "", method = "") {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const payload = browserOperations().responsePayload({ id, ok, result, error, method, maxBytes: MAX_RESULT_BYTES });
  return sendSocketQuietly(ws, payload);
}

function browserOperations() {
  const api = globalThis.__machineBridgeBrowserOperations;
  if (!api || typeof api.dispatch !== "function" || typeof api.methodMayMutate !== "function" || typeof api.responsePayload !== "function") {
    throw new Error("browser operations module is unavailable");
  }
  return api;
}

function dispatch(method, params, state) {
  return browserOperations().dispatch(method, params, state);
}
