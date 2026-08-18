import { randomBytes } from "node:crypto";
import { clampInt } from "./browser-command.mjs";
import { browserPostDispatchTransportFailure, closeProtocolSocket, normalizeRuntimeBrowserRequest, parseBrowserSocketMessage, safeSocketSend } from "./browser-extension-protocol.mjs";
export class BrowserBrokerRoutes {
  constructor({ maximum, getExtensionSocket, extensionConnected, extensionStatusInfo, extensionReloadRequired, extensionGeneration = () => 0 }) {
    this.maximum = maximum;
    this.getExtensionSocket = getExtensionSocket;
    this.extensionConnected = extensionConnected;
    this.extensionStatusInfo = extensionStatusInfo;
    this.extensionReloadRequired = extensionReloadRequired; this.extensionGeneration = extensionGeneration;
    this.clients = new Set();
    this.routes = new Map();
  }
  snapshot() {
    return Object.freeze({ runtime_clients: this.clients.size, routed_requests: this.routes.size });
  }
  acceptClient(socket) {
    this.clients.add(socket);
    socket.on("message", (data) => this.handleClientMessage(socket, data));
    socket.on("close", () => this.removeClient(socket));
    socket.on("error", () => {});
    safeSocketSend(socket, {
      type: "hello",
      role: "runtime",
      protocol: 1,
      extension_connected: this.extensionConnected(),
      extension_info: this.extensionStatusInfo(),
      extension_reload_required: this.extensionReloadRequired(),
      extension_generation: this.extensionGeneration(),
    });
  }

  removeClient(socket) {
    this.clients.delete(socket);
    for (const [id, route] of this.routes) {
      if (route.socket !== socket) continue;
      clearTimeout(route.timeout);
      this.routes.delete(id);
      this.sendExtension({ type: "cancel", id });
    }
  }

  handleClientMessage(socket, data) {
    const parsed = parseBrowserSocketMessage(data);
    if (!parsed.ok) {
      closeProtocolSocket(socket, parsed.code, parsed.reason);
      return;
    }
    const incoming = parsed.message;
    if (incoming.type === "ping") return;
    if (incoming.type === "cancel" && typeof incoming.id === "string") {
      this.cancelClientRequest(socket, incoming.id);
      return;
    }
    const message = normalizeRuntimeBrowserRequest(incoming);
    if (!message) { closeProtocolSocket(socket, 1002, "invalid runtime protocol message"); return; }
    if (!this.extensionConnected()) {
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser extension is not connected" });
      return;
    }
    if (this.routes.size >= this.maximum) {
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser broker is busy" });
      return;
    }
    const routedId = `proxy_${randomBytes(18).toString("base64url")}`;
    let timeoutMs;
    try { timeoutMs = clampInt(message.timeout_ms, 30_000, 1_000, 185_000); }
    catch {
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "invalid browser request timeout" });
      return;
    }
    const timeout = setTimeout(() => {
      const route = this.routes.get(routedId);
      if (!route) return;
      this.routes.delete(routedId);
      safeSocketSend(socket, {
        type: "response", id: message.id, ok: false,
        error: postDispatchRouteFailure(route, "browser broker request timed out"),
      });
      this.sendExtension({ type: "cancel", id: routedId });
    }, timeoutMs);
    timeout.unref?.();
    const route = { socket, id: message.id, timeout, method: message.method, dispatchAttempted: false };
    this.routes.set(routedId, route);
    const send = this.sendExtensionRequest({ ...message, id: routedId, timeout_ms: timeoutMs });
    route.dispatchAttempted = send.attempted;
    if (send.ok) return;
    clearTimeout(timeout);
    this.routes.delete(routedId);
    safeSocketSend(socket, {
      type: "response", id: message.id, ok: false,
      error: postDispatchRouteFailure(route, "browser extension send failed"),
    });
  }

  cancelClientRequest(socket, requestId) {
    for (const [routedId, route] of this.routes) {
      if (route.socket !== socket || route.id !== requestId) continue;
      clearTimeout(route.timeout);
      this.routes.delete(routedId);
      this.sendExtension({ type: "cancel", id: routedId });
    }
  }

  settleExtensionResponse(message) {
    const route = this.routes.get(message.id);
    if (!route) return false;
    clearTimeout(route.timeout);
    this.routes.delete(message.id);
    if (message.ok === true && message.result && typeof message.result === "object" && !Array.isArray(message.result)) {
      safeSocketSend(route.socket, { type: "response", id: route.id, ok: true, result: message.result });
    } else if (message.ok === false && typeof message.error === "string" && message.error && !message.error.includes("\0") && message.error.length <= 2000) {
      safeSocketSend(route.socket, { type: "response", id: route.id, ok: false, error: message.error });
    } else {
      safeSocketSend(route.socket, {
        type: "response", id: route.id, ok: false,
        error: postDispatchRouteFailure(route, "browser extension response was malformed"),
      });
    }
    return true;
  }

  broadcastStatus(connected) {
    const message = {
      type: "status",
      extension_connected: connected,
      extension_info: connected ? this.extensionStatusInfo() : null,
      extension_reload_required: this.extensionReloadRequired(),
      extension_generation: connected ? this.extensionGeneration() : 0,
    };
    for (const client of this.clients) safeSocketSend(client, message);
  }

  rejectAll(message) {
    for (const [id, route] of this.routes) {
      clearTimeout(route.timeout);
      safeSocketSend(route.socket, {
        type: "response", id: route.id, ok: false,
        error: postDispatchRouteFailure(route, message),
      });
      this.routes.delete(id);
    }
  }

  close(message) {
    this.rejectAll(message);
    for (const client of this.clients) {
      try { client.close(1001, "runtime stopped"); }
      catch { /* Runtime shutdown is already authoritative; a concurrently closed broker client needs no retry. */ }
    }
    this.clients.clear();
  }

  sendExtension(message) {
    const socket = this.getExtensionSocket();
    if (!socket || socket.readyState !== 1) return false;
    return safeSocketSend(socket, message);
  }

  sendExtensionRequest(message) {
    const socket = this.getExtensionSocket();
    if (!socket || socket.readyState !== 1) return { ok: false, attempted: false };
    let payload;
    try { payload = JSON.stringify(message); }
    catch { return { ok: false, attempted: false }; }
    try {
      socket.send(payload);
      return { ok: true, attempted: true };
    } catch {
      return { ok: false, attempted: true };
    }
  }
}

function postDispatchRouteFailure(route, fallback) {
  return route?.dispatchAttempted
    ? browserPostDispatchTransportFailure(route.method, fallback)
    : String(fallback || "browser transport failed");
}
