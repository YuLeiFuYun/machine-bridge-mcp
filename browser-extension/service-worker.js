importScripts("browser-error-boundary.js", "devtools-input.js", "browser-operations.js");
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
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
  if (message?.type !== "pair") return false;
  pairConfiguration(message.endpoint, message.token, { replace: false, senderUrl: sender.url || "" })
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true;
});
chrome.action.onClicked.addListener((tab) => void handleActionClick(tab));
async function handleActionClick(tab) {
  if (tab?.id && parsePairingPage(tab.url)) {
    await confirmRepairFromTab(tab);
    return;
  }
  const current = await chrome.storage.local.get(["endpoint"]);
  const pairUrl = pairingUrlFromEndpoint(current.endpoint) || "http://127.0.0.1:39393/pair";
  await chrome.tabs.create({ url: pairUrl });
}
function pairingUrlFromEndpoint(endpoint) {
  const parsed = parseBrokerEndpoint(endpoint);
  return parsed ? `http://127.0.0.1:${parsed.port}/pair` : "";
}
function parsePairingPage(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return null; }
  const port = Number(parsed.port);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/pair"
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return parsed;
}

function parseBrokerEndpoint(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return null; }
  const port = Number(parsed.port);
  if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/extension"
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return parsed;
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
    if (value && typeof value.catch === "function") value.catch(() => {});
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

async function pairConfiguration(rawEndpoint, rawToken, { replace, senderUrl }) {
  const endpoint = String(rawEndpoint || "");
  const token = String(rawToken || "");
  const pairingPage = parsePairingPage(senderUrl);
  const brokerEndpoint = parseBrokerEndpoint(endpoint);
  if (!pairingPage) return { ok: false, error: "invalid_pairing_page" };
  if (!brokerEndpoint || pairingPage.port !== brokerEndpoint.port || !/^[A-Za-z0-9_-]{32,100}$/.test(token)) return { ok: false, error: "invalid_pairing_material" };
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
  if (alreadyPaired && !replace && (current.endpoint !== endpoint || current.token !== token)) {
    return { ok: false, requires_manual_repair: true };
  }
  setConnectionState("connecting");
  try {
    const connectedSocket = await connect(endpoint, token, { reconnect: false });
    await chrome.storage.local.set({ endpoint, token });
    connectedSocket.reconnectEnabled = true;
    if (connectedSocket.readyState !== WebSocket.OPEN || connectedSocket.bridgeReady !== true) void connect(endpoint, token).catch(() => {});
    return { ok: true, replaced: alreadyPaired && (current.endpoint !== endpoint || current.token !== token) };
  } catch (error) {
    if (current.endpoint && current.token) void connect(current.endpoint, current.token).catch(() => {});
    throw error;
  }
}

async function confirmRepairFromTab(tab) {
  if (!tab?.id || !parsePairingPage(tab.url)) return;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        endpoint: `ws://127.0.0.1:${document.querySelector('meta[name="machine-bridge-browser-port"]')?.content || ""}/extension`,
        token: document.querySelector('meta[name="machine-bridge-browser-token"]')?.content || "",
      }),
    });
    const paired = await pairConfiguration(result?.result?.endpoint, result?.result?.token, { replace: true, senderUrl: tab.url });
    await setPairingPageStatus(
      tab.id,
      paired.ok === true ? "Paired. You may close this tab." : "Pairing failed.",
    );
  } catch {
    ignoreBrowserApiCall(() => setPairingPageStatus(
      tab.id,
      "Pairing failed. Reload this page and confirm that the expected extension build is loaded.",
    ));
  }
}

function setPairingPageStatus(tabId, text) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (value) => {
      const status = document.getElementById("status");
      if (status) status.textContent = value;
    },
    args: [text],
  });
}

ensureReconnectAlarm();
void connectFromStorage();

function ensureReconnectAlarm() {
  chrome.alarms.create("machine-bridge-reconnect", { periodInMinutes: 1 });
}

async function connectFromStorage() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const value = await chrome.storage.local.get(["endpoint", "token"]);
  if (value.endpoint && value.token) {
    setConnectionState("connecting");
    void connect(value.endpoint, value.token).catch(() => {});
  } else {
    setConnectionState("unconfigured");
  }
}

function connect(endpoint, token, { reconnect = true } = {}) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.reconnectEnabled = false;
    clearInterval(socket.keepaliveTimer);
    socket.keepaliveTimer = null;
    cancelRequestsForSocket(socket);
    closeSocketQuietly(socket);
  }
  const ws = new WebSocket(endpoint, [`mbm.${token}`]);
  socket = ws;
  ws.bridgeReady = false;
  ws.serverHelloSeen = false;
  ws.machineBridgeEndpoint = endpoint;
  ws.machineBridgeToken = token;
  ws.reconnectEnabled = reconnect;
  ws.keepaliveTimer = null;
  setConnectionState("connecting");
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
    ws.onerror = () => {};
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

function scheduleReconnect(endpoint, token) {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(() => { void connect(endpoint, token).catch(() => {}); }, delay);
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
      capabilities: [
        "semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits",
      ],
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
    if (!sendResponse(ws, message.id, true, result)) {
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

function sendResponse(ws, id, ok, result, error = "") {
  if (ws.readyState !== WebSocket.OPEN) return false;
  let payload = JSON.stringify({ type: "response", id, ok, ...(ok ? { result } : { error }) });
  if (new TextEncoder().encode(payload).byteLength > MAX_RESULT_BYTES) {
    payload = JSON.stringify({ type: "response", id, ok: false, error: "browser result exceeds maximum size" });
  }
  return sendSocketQuietly(ws, payload);
}

function browserOperations() {
  const api = globalThis.__machineBridgeBrowserOperations;
  if (!api || typeof api.dispatch !== "function") throw new Error("browser operations module is unavailable");
  return api;
}

function dispatch(method, params, state) {
  return browserOperations().dispatch(method, params, state);
}
