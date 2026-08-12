import { randomBytes } from "node:crypto";
import { browserMethodMayMutate, clampInt } from "./browser-command.mjs";
import { closeProtocolSocket, parseBrowserSocketMessage, safeSocketSend } from "./browser-extension-protocol.mjs";

export class BrowserBrokerRoutes {
  constructor({ maximum, getExtensionSocket, extensionConnected, extensionStatusInfo, extensionReloadRequired }) {
    this.maximum = maximum;
    this.getExtensionSocket = getExtensionSocket;
    this.extensionConnected = extensionConnected;
    this.extensionStatusInfo = extensionStatusInfo;
    this.extensionReloadRequired = extensionReloadRequired;
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
    const message = parsed.message;
    if (message.type === "ping") return;
    if (message.type === "cancel" && typeof message.id === "string") {
      this.cancelClientRequest(socket, message.id);
      return;
    }
    if (message.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") {
      closeProtocolSocket(socket, 1002, "invalid runtime protocol message");
      return;
    }
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
      const cancellationRequested = this.sendExtension({ type: "cancel", id: routedId });
      const error = browserMethodMayMutate(route.method)
        ? `browser broker request timed out after dispatch; ${cancellationRequested ? "cancellation requested but effect settlement is pending" : "cancellation delivery failed and effect settlement is unknown"}; inspect browser state before retrying`
        : "browser broker request timed out";
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error });
    }, timeoutMs);
    timeout.unref?.();
    this.routes.set(routedId, { socket, id: message.id, method: message.method, timeout });
    if (this.sendExtension({ ...message, id: routedId, timeout_ms: timeoutMs })) return;
    clearTimeout(timeout);
    this.routes.delete(routedId);
    safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser extension send failed" });
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
    safeSocketSend(route.socket, { ...message, id: route.id });
    return true;
  }

  broadcastStatus(connected) {
    const message = {
      type: "status",
      extension_connected: connected,
      extension_info: connected ? this.extensionStatusInfo() : null,
      extension_reload_required: this.extensionReloadRequired(),
    };
    for (const client of this.clients) safeSocketSend(client, message);
  }

  rejectAll(message) {
    for (const [id, route] of this.routes) {
      clearTimeout(route.timeout);
      const error = browserMethodMayMutate(route.method)
        ? "browser connection changed after request dispatch; outcome is unknown; inspect browser state before retrying"
        : message;
      safeSocketSend(route.socket, { type: "response", id: route.id, ok: false, error });
      this.routes.delete(id);
    }
  }

  close(message) {
    this.rejectAll(message);
    for (const client of this.clients) {
      try { client.close(1001, "runtime stopped"); }
      catch { /* Runtime shutdown is idempotent and the client may already be closed. */ }
    }
    this.clients.clear();
  }

  sendExtension(message) {
    const socket = this.getExtensionSocket();
    if (!socket || socket.readyState !== 1) return false;
    return safeSocketSend(socket, message);
  }
}
