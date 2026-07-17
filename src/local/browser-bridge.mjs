import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createToolAuthorizer } from "./policy.mjs";
import { assertStateMaintenanceAvailable, packageRoot } from "./state.mjs";
import {
  BROWSER_EXTENSION_PROTOCOL, EXPECTED_EXTENSION_VERSION, MAX_BROWSER_MESSAGE_BYTES,
  closeProtocolSocket, normalizeCompatibleExtensionInfo, parseBrowserSocketMessage, parseExtensionHello, safeSocketSend,
} from "./browser-extension-protocol.mjs";
import {
  isAllowedExtensionOrigin, isAllowedLoopbackHost, loadOrCreatePairing,
  pairingHtml, savePairing, securityHeaders, sendJson,
} from "./browser-pairing-store.mjs";
import { clampInt } from "./browser-command.mjs";
import { BrowserOperationService } from "./browser-operation-service.mjs";
import { classifyOperationalError } from "./log.mjs";

const MAX_PORT_ATTEMPTS = 10;
const MAX_PENDING = 32;
const EXTENSION_HANDSHAKE_MS = 3_000;

export class BrowserBridgeManager {
  constructor({ policy, authorizeTool = null, stateRoot = "", runProcess, readResourceText, readResourceBinary, throwIfCancelled = () => {}, logger = null }) {
    this.policy = policy || {};
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.stateRoot = stateRoot ? resolve(stateRoot) : "";
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.readResourceBinary = readResourceBinary;
    this.throwIfCancelled = throwIfCancelled;
    this.logger = logger || { event() {} };
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.pendingExtensionSocket = null;
    this.upstream = null;
    this.runtimeClients = new Set();
    this.proxyRoutes = new Map();
    this.proxyExtensionConnected = false;
    this.extensionInfo = null;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
    this.extensionReloadRequiredFlag = false;
    this.recoveryTimer = null;
    this.stopping = false;
    this.pending = new Map();
    this.startPromise = null;
    this.startGeneration = 0;
    this.port = 0;
    this.token = "";
    this.extensionPath = resolve(packageRoot, "browser-extension");
    this.operationService = new BrowserOperationService({
      authorizeTool: (tool) => this.authorizeTool(tool),
      ensureStarted: (context) => this.ensureStarted(context),
      request: (...args) => this.request(...args),
      bridgeStatus: () => ({
        port: this.port,
        brokerRole: this.server ? "owner" : this.upstream?.readyState === 1 ? "client" : "unavailable",
        extensionConnected: this.extensionConnected(),
        extensionInfo: this.extensionStatusInfo(),
        extensionReloadRequired: this.extensionReloadRequired(),
      }),
      extensionPath: this.extensionPath,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
      runProcess: (...args) => this.runProcess(...args),
      readResourceText: (name) => this.readResourceText(name),
      readResourceBinary: (name) => this.readResourceBinary(name),
    });
  }

  status(context = {}) { return this.operationService.status(context); }

  pair(args = {}, context = {}) { return this.operationService.pair(args, context); }

  listTabs(args = {}, context = {}) { return this.operationService.listTabs(args, context); }

  manageTabs(args = {}, context = {}) { return this.operationService.manageTabs(args, context); }

  wait(args = {}, context = {}) { return this.operationService.wait(args, context); }

  getSource(args = {}, context = {}) { return this.operationService.getSource(args, context); }

  inspectPage(args = {}, context = {}) { return this.operationService.inspectPage(args, context); }

  act(args = {}, context = {}) { return this.operationService.act(args, context); }

  fillForm(args = {}, context = {}) { return this.operationService.fillForm(args, context); }

  uploadFiles(args = {}, context = {}) { return this.operationService.uploadFiles(args, context); }

  screenshot(args = {}, context = {}) { return this.operationService.screenshot(args, context); }

  async request(method, params, timeoutSeconds, context = {}) {
    await this.ensureStarted(context);
    this.throwIfCancelled(context);
    const transport = this.server ? this.socket : this.upstream;
    const extensionConnected = this.extensionConnected();
    if (!transport || transport.readyState !== 1 || !extensionConnected) {
      throw new Error("browser extension is not connected; call pair_browser_extension after loading the packaged extension");
    }
    if (this.pending.size >= MAX_PENDING) throw new Error("too many concurrent browser requests");
    const id = `browser_${randomBytes(18).toString("base64url")}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutMs = timeoutSeconds * 1000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        try { transport.send(JSON.stringify({ type: "cancel", id })); } catch {}
        rejectPromise(new Error(`browser request timed out after ${timeoutSeconds}s`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout, callId: context.callId || "" });
      try {
        const message = JSON.stringify({ type: "request", id, method, params, timeout_ms: timeoutMs });
        if (Buffer.byteLength(message) > MAX_BROWSER_MESSAGE_BYTES) throw new Error("browser request exceeds maximum message size");
        transport.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  async ensureStarted(context = {}) {
    this.throwIfCancelled(context);
    if (this.stateRoot) assertStateMaintenanceAvailable(this.stateRoot);
    this.stopping = false;
    if (this.server || this.upstream?.readyState === 1) return;
    if (!this.startPromise) {
      const generation = ++this.startGeneration;
      this.startPromise = this.start(generation);
    }
    const pending = this.startPromise;
    try { await pending; } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  async start(generation = this.startGeneration) {
    try {
      const pairing = await loadOrCreatePairing(this.stateRoot);
      this.assertStartCurrent(generation);
      this.token = pairing.token;
      for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
        const port = pairing.port + offset;
        try {
          await this.listen(port);
          this.assertStartCurrent(generation);
          if (port !== pairing.port && this.stateRoot) {
            await savePairing(this.stateRoot, { token: this.token, port });
            this.assertStartCurrent(generation);
          }
          return;
        } catch (error) {
          this.assertStartCurrent(generation);
          if (error?.code !== "EADDRINUSE") throw error;
          if (await this.connectProxy(port, generation)) {
            this.assertStartCurrent(generation);
            this.port = port;
            return;
          }
          this.assertStartCurrent(generation);
          if (offset === MAX_PORT_ATTEMPTS - 1) throw error;
        }
      }
    } catch (error) {
      const cancelled = !this.isStartCurrent(generation);
      this.closeBrokerTransports(cancelled ? "browser bridge start cancelled" : "browser bridge start failed");
      if (cancelled) throw new Error("browser bridge start cancelled");
      throw error;
    }
  }

  isStartCurrent(generation) {
    return !this.stopping && generation === this.startGeneration;
  }

  assertStartCurrent(generation) {
    if (!this.isStartCurrent(generation)) throw new Error("browser bridge start cancelled");
  }

  async listen(port) {
    this.port = port;
    const server = createServer((request, response) => this.handleHttp(request, response));
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_MESSAGE_BYTES });
    server.on("upgrade", (request, socket, head) => {
      try {
        const host = String(request.headers.host || "");
        if (!isAllowedLoopbackHost(host, port)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const url = new URL(request.url || "/", `http://${host}`);
        const protocol = String(request.headers["sec-websocket-protocol"] || "");
        const origin = String(request.headers.origin || "");
        let role = "";
        if (url.pathname === "/extension" && protocol === `mbm.${this.token}` && isAllowedExtensionOrigin(origin)) role = "extension";
        if (url.pathname === "/runtime" && protocol === `mbm-runtime.${this.token}` && !origin) role = "runtime";
        if (!role) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.bridgeRole = role;
          wss.emit("connection", ws, request);
        });
      } catch {
        socket.destroy();
      }
    });
    wss.on("connection", (ws) => this.acceptSocket(ws, ws.bridgeRole));
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = (error) => { cleanup(); try { wss.close(); } catch {} try { server.close(); } catch {} rejectPromise(error); };
      const onListening = () => { cleanup(); resolvePromise(); };
      const cleanup = () => { server.off("error", onError); server.off("listening", onListening); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    this.server = server;
    this.wss = wss;
  }

  async connectProxy(port, generation = this.startGeneration) {
    const url = `ws://127.0.0.1:${port}/runtime`;
    return new Promise((resolvePromise) => {
      let settled = false;
      const ws = new WebSocket(url, [`mbm-runtime.${this.token}`], { maxPayload: MAX_BROWSER_MESSAGE_BYTES });
      const timer = setTimeout(() => finish(false), 1500);
      timer.unref?.();
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          try { ws.terminate(); } catch { try { ws.close(); } catch {} }
        }
        resolvePromise(ok);
      };
      ws.on("message", (data) => {
        const parsed = parseBrowserSocketMessage(data);
        if (!parsed.ok) {
          closeProtocolSocket(ws, parsed.code, parsed.reason);
          return;
        }
        const message = parsed.message;
        if (!settled) {
          if (message.type !== "hello" || message.role !== "runtime" || message.protocol !== 1) {
            closeProtocolSocket(ws, 1002, "runtime hello required");
            return;
          }
          if (!this.isStartCurrent(generation)) {
            try { ws.close(1001, "runtime stopped"); } catch {}
            finish(false);
            return;
          }
          this.upstream = ws;
          const claimedExtension = message.extension_connected === true;
          this.proxyExtensionInfo = claimedExtension ? normalizeCompatibleExtensionInfo(message.extension_info) : null;
          this.proxyExtensionConnected = claimedExtension && Boolean(this.proxyExtensionInfo);
          this.proxyExtensionReloadRequired = message.extension_reload_required === true || (claimedExtension && !this.proxyExtensionInfo);
          finish(true);
          return;
        }
        if (!this.handleUpstreamMessage(message)) closeProtocolSocket(ws, 1002, "invalid broker protocol message");
      });
      ws.once("error", () => finish(false));
      ws.once("close", () => {
        if (this.upstream === ws) {
          this.upstream = null;
          this.proxyExtensionConnected = false;
          this.proxyExtensionInfo = null;
          this.proxyExtensionReloadRequired = false;
          this.rejectPending("browser broker disconnected");
          if (settled) this.scheduleBrokerRecovery();
        }
        finish(false);
      });
    });
  }

  acceptSocket(ws, role) {
    if (role === "runtime") {
      this.runtimeClients.add(ws);
      ws.on("message", (data) => this.handleRuntimeClientMessage(ws, data));
      ws.on("close", () => {
        this.runtimeClients.delete(ws);
        for (const [id, route] of this.proxyRoutes) {
          if (route.socket !== ws) continue;
          clearTimeout(route.timeout);
          this.proxyRoutes.delete(id);
          try { this.socket?.send(JSON.stringify({ type: "cancel", id })); } catch {}
        }
      });
      ws.on("error", () => {});
      safeSocketSend(ws, {
        type: "hello", role: "runtime", protocol: 1,
        extension_connected: this.extensionConnected(),
        extension_info: this.extensionStatusInfo(),
        extension_reload_required: this.extensionReloadRequired(),
      });
      return;
    }
    if (this.pendingExtensionSocket && this.pendingExtensionSocket.readyState === 1) {
      this.pendingExtensionSocket.close(4001, "superseded by a newer extension candidate");
    }
    this.pendingExtensionSocket = ws;
    this.broadcastRuntimeStatus(this.extensionConnected());
    ws.extensionReady = false;
    ws.handshakeTimer = setTimeout(() => {
      this.markExtensionReloadRequired();
      closeProtocolSocket(ws, 1002, "extension hello required; reload the extension");
    }, EXTENSION_HANDSHAKE_MS);
    ws.handshakeTimer.unref?.();
    ws.on("message", (data) => this.handleExtensionMessage(ws, data));
    ws.on("close", () => {
      clearTimeout(ws.handshakeTimer);
      if (this.pendingExtensionSocket === ws) {
        this.pendingExtensionSocket = null;
        this.broadcastRuntimeStatus(this.extensionConnected());
        return;
      }
      if (this.socket !== ws) return;
      this.socket = null;
      this.extensionInfo = null;
      this.rejectPending("browser extension disconnected");
      this.rejectProxyRoutes("browser extension disconnected");
      this.broadcastRuntimeStatus(false);
    });
    ws.on("error", () => {});
    safeSocketSend(ws, { type: "hello", role: "extension", protocol: BROWSER_EXTENSION_PROTOCOL });
  }

  handleExtensionMessage(socket, data) {
    if (this.socket !== socket && this.pendingExtensionSocket !== socket) return;
    const parsed = parseBrowserSocketMessage(data);
    if (!parsed.ok) {
      this.markExtensionReloadRequired();
      closeProtocolSocket(socket, parsed.code, parsed.reason);
      return;
    }
    const message = parsed.message;
    if (message.type === "hello") {
      if (socket.extensionReady) {
        this.markExtensionReloadRequired();
        closeProtocolSocket(socket, 1002, "duplicate extension hello");
        return;
      }
      let info;
      try { info = parseExtensionHello(message); }
      catch (error) {
        this.markExtensionReloadRequired();
        closeProtocolSocket(socket, 1002, String(error?.message || error).slice(0, 120));
        return;
      }
      clearTimeout(socket.handshakeTimer);
      if (!safeSocketSend(socket, { type: "hello_ack", role: "extension", protocol: BROWSER_EXTENSION_PROTOCOL })) {
        closeProtocolSocket(socket, 1011, "extension acknowledgement failed");
        return;
      }
      this.extensionReloadRequiredFlag = false;
      socket.extensionReady = true;
      if (this.pendingExtensionSocket === socket) this.pendingExtensionSocket = null;
      const previous = this.socket;
      this.socket = socket;
      this.extensionInfo = info;
      if (previous && previous !== socket) {
        this.rejectPending("browser extension was replaced; retry the browser request");
        this.rejectProxyRoutes("browser extension was replaced; retry the browser request");
        if (previous.readyState === 1) previous.close(4001, "superseded");
      }
      this.broadcastRuntimeStatus(true);
      return;
    }
    if (!socket.extensionReady) {
      this.markExtensionReloadRequired();
      closeProtocolSocket(socket, 1002, "extension hello required; reload the extension");
      return;
    }
    if (message.type === "ping") return;
    if (message.type !== "response" || typeof message.id !== "string") {
      this.markExtensionReloadRequired();
      closeProtocolSocket(socket, 1002, "invalid extension protocol message");
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok === false) pending.reject(new Error(String(message.error || "browser operation failed").slice(0, 2000)));
      else pending.resolve(message.result);
      return;
    }
    const route = this.proxyRoutes.get(message.id);
    if (!route) return;
    clearTimeout(route.timeout);
    this.proxyRoutes.delete(message.id);
    try { route.socket.send(JSON.stringify({ ...message, id: route.id })); } catch {}
  }

  handleRuntimeClientMessage(socket, data) {
    const parsed = parseBrowserSocketMessage(data);
    if (!parsed.ok) {
      closeProtocolSocket(socket, parsed.code, parsed.reason);
      return;
    }
    const message = parsed.message;
    if (message.type === "ping") return;
    if (message.type === "cancel" && typeof message.id === "string") {
      for (const [routedId, route] of this.proxyRoutes) {
        if (route.socket !== socket || route.id !== message.id) continue;
        clearTimeout(route.timeout);
        this.proxyRoutes.delete(routedId);
        try { this.socket?.send(JSON.stringify({ type: "cancel", id: routedId })); } catch {}
      }
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
    if (this.proxyRoutes.size >= MAX_PENDING * 4) {
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
      const route = this.proxyRoutes.get(routedId);
      if (!route) return;
      this.proxyRoutes.delete(routedId);
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser broker request timed out" });
      try { this.socket?.send(JSON.stringify({ type: "cancel", id: routedId })); } catch {}
    }, timeoutMs);
    timeout.unref?.();
    this.proxyRoutes.set(routedId, { socket, id: message.id, timeout });
    try {
      this.socket.send(JSON.stringify({ ...message, id: routedId, timeout_ms: timeoutMs }));
    } catch {
      clearTimeout(timeout);
      this.proxyRoutes.delete(routedId);
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser extension send failed" });
    }
  }

  handleUpstreamMessage(message) {
    if (message.type === "status" && typeof message.extension_connected === "boolean") {
      const claimedExtension = message.extension_connected === true;
      this.proxyExtensionInfo = claimedExtension ? normalizeCompatibleExtensionInfo(message.extension_info) : null;
      this.proxyExtensionConnected = claimedExtension && Boolean(this.proxyExtensionInfo);
      this.proxyExtensionReloadRequired = message.extension_reload_required === true || (claimedExtension && !this.proxyExtensionInfo);
      if (!this.proxyExtensionConnected) this.rejectPending("browser extension disconnected");
      return true;
    }
    if (message.type !== "response" || typeof message.id !== "string") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok === false) pending.reject(new Error(String(message.error || "browser operation failed").slice(0, 2000)));
    else pending.resolve(message.result);
    return true;
  }

  broadcastRuntimeStatus(connected) {
    const message = {
      type: "status", extension_connected: connected,
      extension_info: connected ? this.extensionStatusInfo() : null,
      extension_reload_required: this.extensionReloadRequired(),
    };
    for (const client of this.runtimeClients) safeSocketSend(client, message);
  }

  scheduleBrokerRecovery() {
    if (this.stopping || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.ensureStarted().catch((error) => {
        this.logger.event?.("debug", "browser.broker.recovery_failed", { error_class: classifyOperationalError(error) },
          "browser broker recovery failed; retrying");
        this.scheduleBrokerRecovery();
      });
    }, 250);
    this.recoveryTimer.unref?.();
  }

  handleHttp(request, response) {
    const host = String(request.headers.host || "");
    if (!isAllowedLoopbackHost(host, this.port)) {
      response.writeHead(403, securityHeaders("text/plain; charset=utf-8"));
      response.end("Forbidden\n");
      return;
    }
    const url = new URL(request.url || "/", `http://${host}`);
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/healthz") {
      const extension = this.extensionStatusInfo();
      sendJson(response, {
        ok: true,
        connected: this.extensionConnected(),
        broker: "machine-bridge-browser",
        expected_extension_version: EXPECTED_EXTENSION_VERSION,
        extension_protocol: extension?.protocol || null,
        extension_version: extension?.version || "",
        extension_capabilities: extension?.capabilities || [],
        extension_reload_required: this.extensionReloadRequired(),
        controls_existing_profile: true,
        controls_extension_profile: true,
        machine_bridge_launches_browser: false,
        profile_identity_verifiable: false,
      });
      return;
    }
    if (url.pathname === "/pair") {
      const html = pairingHtml(this.port, this.token);
      response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
      response.end(html);
      return;
    }
    response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
    response.end("Not found\n");
  }

  cancelCall(callId) {
    if (!callId) return;
    const transport = this.server ? this.socket : this.upstream;
    for (const [id, pending] of this.pending) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      try { transport?.send(JSON.stringify({ type: "cancel", id })); } catch {}
      pending.reject(new Error("browser request cancelled; a user-visible action may already have completed"));
    }
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  rejectProxyRoutes(message) {
    for (const [id, route] of this.proxyRoutes) {
      clearTimeout(route.timeout);
      safeSocketSend(route.socket, { type: "response", id: route.id, ok: false, error: message });
      this.proxyRoutes.delete(id);
    }
  }

  stop() {
    this.stopping = true;
    this.startGeneration += 1;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.closeBrokerTransports("browser bridge stopped");
  }

  closeBrokerTransports(message) {
    this.rejectPending(message);
    this.rejectProxyRoutes(message);
    try { this.upstream?.close(1001, "runtime stopped"); } catch {}
    try { this.socket?.close(1001, "runtime stopped"); } catch {}
    try { this.pendingExtensionSocket?.close(1001, "runtime stopped"); } catch {}
    for (const client of this.runtimeClients) try { client.close(1001, "runtime stopped"); } catch {}
    this.upstream = null;
    this.socket = null;
    this.pendingExtensionSocket = null;
    this.extensionInfo = null;
    this.proxyExtensionConnected = false;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
    this.extensionReloadRequiredFlag = false;
    this.runtimeClients.clear();
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.wss = null;
    this.server = null;
  }

  markExtensionReloadRequired() {
    this.extensionReloadRequiredFlag = true;
    this.broadcastRuntimeStatus(this.extensionConnected());
  }

  extensionConnected() {
    return this.server
      ? this.socket?.readyState === 1 && Boolean(this.extensionInfo)
      : this.upstream?.readyState === 1 && this.proxyExtensionConnected && Boolean(this.proxyExtensionInfo);
  }

  extensionStatusInfo() {
    return this.server ? this.extensionInfo : this.proxyExtensionInfo;
  }

  extensionReloadRequired() {
    return this.server
      ? this.extensionReloadRequiredFlag || (this.pendingExtensionSocket?.readyState === 1 && !this.extensionConnected())
      : this.proxyExtensionReloadRequired;
  }

}
