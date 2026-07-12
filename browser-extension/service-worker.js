let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let keepaliveTimer = null;
const MAX_RESULT_BYTES = 7 * 1024 * 1024;
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
  if (tab?.id && /^http:\/\/127\.0\.0\.1:\d+\/pair(?:$|[?#])/.test(String(tab.url || ""))) {
    await confirmRepairFromTab(tab);
    return;
  }
  const current = await chrome.storage.local.get(["endpoint"]);
  const pairUrl = pairingUrlFromEndpoint(current.endpoint) || "http://127.0.0.1:39393/pair";
  await chrome.tabs.create({ url: pairUrl });
}

function pairingUrlFromEndpoint(endpoint) {
  const match = /^ws:\/\/127\.0\.0\.1:(\d+)\/extension$/.exec(String(endpoint || ""));
  return match ? `http://127.0.0.1:${match[1]}/pair` : "";
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
  try { ignoreOptionalPromise(chrome.action.setBadgeText({ text: badge })); } catch {}
  try { ignoreOptionalPromise(chrome.action.setTitle({ title })); } catch {}
}

function ignoreOptionalPromise(value) {
  if (value && typeof value.catch === "function") value.catch(() => {});
}

async function pairConfiguration(rawEndpoint, rawToken, { replace, senderUrl }) {
  const endpoint = String(rawEndpoint || "");
  const token = String(rawToken || "");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/pair(?:$|[?#])/.test(String(senderUrl || ""))) return { ok: false, error: "invalid_pairing_page" };
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/extension$/.test(endpoint) || !/^[A-Za-z0-9_-]{32,100}$/.test(token)) return { ok: false, error: "invalid_pairing_material" };
  const current = await chrome.storage.local.get(["endpoint", "token"]);
  const alreadyPaired = Boolean(current.endpoint && current.token);
  if (alreadyPaired && !replace && (current.endpoint !== endpoint || current.token !== token)) {
    return { ok: false, requires_manual_repair: true };
  }
  await chrome.storage.local.set({ endpoint, token });
  setConnectionState("connecting");
  connect(endpoint, token);
  return { ok: true, replaced: alreadyPaired && (current.endpoint !== endpoint || current.token !== token) };
}

async function confirmRepairFromTab(tab) {
  if (!tab?.id || !/^http:\/\/127\.0\.0\.1:\d+\/pair(?:$|[?#])/.test(String(tab.url || ""))) return;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        endpoint: `ws://127.0.0.1:${document.querySelector('meta[name="machine-bridge-browser-port"]')?.content || ""}/extension`,
        token: document.querySelector('meta[name="machine-bridge-browser-token"]')?.content || "",
      }),
    });
    const paired = await pairConfiguration(result?.result?.endpoint, result?.result?.token, { replace: true, senderUrl: tab.url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (ok) => {
        const status = document.getElementById("status");
        if (status) status.textContent = ok ? "Paired. You may close this tab." : "Pairing failed.";
      },
      args: [paired.ok === true],
    });
  } catch {}
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
    connect(value.endpoint, value.token);
  } else {
    setConnectionState("unconfigured");
  }
}

function connect(endpoint, token) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    try { socket.close(); } catch {}
  }
  const ws = new WebSocket(endpoint, [`mbm.${token}`]);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) {
      try { ws.close(); } catch {}
      return;
    }
    reconnectAttempt = 0;
    setConnectionState("connected");
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => { if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 20000);
  };
  ws.onmessage = (event) => void handleMessage(ws, event.data);
  ws.onerror = () => {};
  ws.onclose = () => {
    if (socket !== ws) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    socket = null;
    setConnectionState("disconnected");
    scheduleReconnect(endpoint, token);
  };
}

function scheduleReconnect(endpoint, token) {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(() => connect(endpoint, token), delay);
}

async function handleMessage(ws, raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message?.type === "cancel" && typeof message.id === "string") {
    const state = activeRequests.get(message.id);
    if (state) state.cancelled = true;
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
  const state = { cancelled: false };
  activeRequests.set(message.id, state);
  try {
    throwIfCancelled(state);
    const result = await dispatch(message.method, message.params || {});
    throwIfCancelled(state);
    sendResponse(ws, message.id, true, result);
  } catch (error) {
    if (!state.cancelled) sendResponse(ws, message.id, false, null, String(error?.message || error).slice(0, 2000));
  } finally {
    activeRequests.delete(message.id);
  }
}

function throwIfCancelled(state) {
  if (state.cancelled) throw new Error("browser request cancelled");
}

function sendResponse(ws, id, ok, result, error = "") {
  if (ws.readyState !== WebSocket.OPEN) return;
  let payload = JSON.stringify({ type: "response", id, ok, ...(ok ? { result } : { error }) });
  if (new TextEncoder().encode(payload).byteLength > MAX_RESULT_BYTES) {
    payload = JSON.stringify({ type: "response", id, ok: false, error: "browser result exceeds maximum size" });
  }
  try { ws.send(payload); } catch {}
}

async function dispatch(method, params) {
  if (method === "list_tabs") return listTabs(params);
  if (method === "get_source") return getSource(params);
  if (method === "inspect_page") return inspectPage(params);
  if (method === "action") return browserAction(params);
  if (method === "fill_form") return fillForm(params);
  if (method === "upload_files") return uploadFiles(params);
  if (method === "screenshot") return screenshot(params);
  throw new Error(`unknown browser method: ${method}`);
}

async function listTabs(params) {
  const query = params.currentWindow ? { currentWindow: true } : {};
  const tabs = await chrome.tabs.query(query);
  return {
    tabs: tabs
      .filter((tab) => params.includePinned !== false || !tab.pinned)
      .map((tab) => ({
        id: tab.id,
        window_id: tab.windowId,
        active: tab.active,
        pinned: tab.pinned,
        audible: tab.audible,
        discarded: tab.discarded,
        status: tab.status,
        title: tab.title || "",
        url: tab.url || "",
      })),
  };
}

function scriptTarget(tabId, frameId, allFrames) {
  if (Number.isInteger(frameId)) return { tabId, frameIds: [frameId] };
  if (allFrames) return { tabId, allFrames: true };
  return { tabId };
}

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active browser tab");
  return tab;
}

async function getSource(params) {
  const tab = await resolveTab(params.tabId);
  assertPageTab(tab);
  const maxBytes = Number(params.maxBytes) || 1024 * 1024;
  const executions = await chrome.scripting.executeScript({
    target: scriptTarget(tab.id, params.frameId, params.allFrames === true),
    func: (limit) => {
      const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : "";
      const source = `${doctype}${document.documentElement?.outerHTML || ""}`;
      const encoder = new TextEncoder();
      const bytes = encoder.encode(source);
      if (bytes.byteLength <= limit) return { source, bytes: bytes.byteLength, truncated: false, url: location.href };
      const decoder = new TextDecoder();
      return { source: decoder.decode(bytes.slice(0, limit)), bytes: bytes.byteLength, truncated: true, url: location.href };
    },
    args: [maxBytes],
  });
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", frames: executions.map((item) => ({ frame_id: item.frameId, ...item.result })) };
}

async function inspectPage(params) {
  const tab = await resolveTab(params.tabId);
  assertPageTab(tab);
  const executions = await executePageAutomation(
    scriptTarget(tab.id, params.frameId, params.allFrames === true),
    "inspect",
    { maxElements: Number(params.maxElements) || 300, includeValues: params.includeValues === true },
  );
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", frames: executions.map((item) => ({ frame_id: item.frameId, ...item.result })) };
}

async function browserAction(params) {
  const tab = await resolveTab(params.tabId);
  if (params.action === "navigate") {
    if (!params.url) throw new Error("navigate requires url");
    const waiter = beginTabWait(tab.id, params.waitFor);
    try {
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      await waiter.promise;
      return publicTab(await chrome.tabs.get(updated.id));
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }
  if (params.action === "reload") {
    const waiter = beginTabWait(tab.id, params.waitFor);
    try {
      await chrome.tabs.reload(tab.id);
      await waiter.promise;
      return publicTab(await chrome.tabs.get(tab.id));
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }
  if (params.action === "back" || params.action === "forward") {
    const waiter = beginTabWait(tab.id, params.waitFor);
    try {
      if (params.action === "back") await chrome.tabs.goBack(tab.id);
      else await chrome.tabs.goForward(tab.id);
      await waiter.promise;
      return publicTab(await chrome.tabs.get(tab.id));
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }
  assertPageTab(tab);
  const waiter = beginTabWait(tab.id, params.waitFor);
  let execution;
  try {
    [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "action", params);
    await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", ...execution.result };
}

async function fillForm(params) {
  const tab = await resolveTab(params.tabId);
  assertPageTab(tab);
  const waiter = beginTabWait(tab.id, params.waitFor);
  let execution;
  try {
    [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "fillForm", params);
    await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", ...execution.result };
}

async function uploadFiles(params) {
  const tab = await resolveTab(params.tabId);
  assertPageTab(tab);
  const [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "uploadFiles", params);
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", ...execution.result };
}

async function screenshot(params) {
  const tab = await resolveTab(params.tabId);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const data = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: params.format === "jpeg" ? "jpeg" : "png",
    quality: Number(params.quality) || 90,
  });
  return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", data };
}

function publicTab(tab) {
  return { tab_id: tab.id, window_id: tab.windowId, title: tab.title || "", url: tab.url || "", status: tab.status || "" };
}

function assertPageTab(tab) {
  const url = String(tab.url || "");
  if (!/^(https?|file):/i.test(url)) throw new Error("this page cannot be scripted by a browser extension");
}

function beginTabWait(tabId, mode) {
  if (!mode || mode === "none") return { promise: Promise.resolve(), cancel() {} };
  let settled = false;
  let navigationStarted = false;
  let pollTimer = null;
  let timeout = null;
  let resolveWait;
  let rejectWait;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveWait = resolvePromise;
    rejectWait = rejectPromise;
  });
  const cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(pollTimer);
    chrome.tabs.onUpdated.removeListener(listener);
  };
  const settle = (error = null) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectWait(error); else resolveWait();
  };
  const pollReadyState = async () => {
    if (settled || !navigationStarted || mode !== "domcontentloaded") return;
    try {
      const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState });
      if (["interactive", "complete"].includes(execution?.result)) {
        settle();
        return;
      }
    } catch {}
    pollTimer = setTimeout(pollReadyState, 100);
  };
  const listener = (updatedId, changeInfo, tab) => {
    if (updatedId !== tabId || settled) return;
    if (changeInfo.status === "loading" || typeof changeInfo.url === "string") navigationStarted = true;
    if (!navigationStarted) return;
    if (mode === "complete" && (changeInfo.status === "complete" || (typeof changeInfo.url === "string" && tab.status === "complete"))) settle();
    if (mode === "domcontentloaded") void pollReadyState();
  };
  chrome.tabs.onUpdated.addListener(listener);
  timeout = setTimeout(() => settle(new Error("browser navigation wait timed out")), 30000);
  return { promise, cancel: () => settle() };
}

function executePageAutomation(target, method, params) {
  return chrome.scripting.executeScript({ target, files: ["page-automation.js"] })
    .then(() => chrome.scripting.executeScript({
      target,
      func: (operation, payload) => {
        const api = globalThis.__machineBridgePageAutomation;
        if (!api || typeof api[operation] !== "function") throw new Error("page automation module is unavailable");
        return api[operation](payload);
      },
      args: [method, params],
    }));
}
