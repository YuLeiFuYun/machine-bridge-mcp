import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { replaceFileSync } from "./atomic-fs.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { ownerOnlyFile, packageRoot } from "./state.mjs";

const DEFAULT_PORT = 39393;
const MAX_PORT_ATTEMPTS = 10;
const MAX_BROWSER_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FORM_FIELDS = 200;
const MAX_FIELD_VALUE_CHARS = 128 * 1024;
const MAX_FORM_VALUE_BYTES = 4 * 1024 * 1024;
const PAIRING_FILE = "browser-bridge.json";
const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

export class BrowserBridgeManager {
  constructor({ policy, stateRoot = "", runProcess, readResourceText, readResourceBinary, throwIfCancelled = () => {} }) {
    this.policy = policy || {};
    this.stateRoot = stateRoot ? resolve(stateRoot) : "";
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.readResourceBinary = readResourceBinary;
    this.throwIfCancelled = throwIfCancelled;
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.upstream = null;
    this.runtimeClients = new Set();
    this.proxyRoutes = new Map();
    this.proxyExtensionConnected = false;
    this.recoveryTimer = null;
    this.stopping = false;
    this.pending = new Map();
    this.startPromise = null;
    this.port = 0;
    this.token = "";
    this.extensionPath = resolve(packageRoot, "browser-extension");
  }

  async status(context = {}) {
    await this.ensureStarted(context);
    return {
      available: true,
      connected: this.server ? this.socket?.readyState === 1 : this.proxyExtensionConnected,
      broker_role: this.server ? "owner" : this.upstream?.readyState === 1 ? "client" : "unavailable",
      endpoint: `ws://127.0.0.1:${this.port}/extension`,
      pairing_url: `http://127.0.0.1:${this.port}/pair`,
      extension_path: this.extensionPath,
      supported_browsers: ["Chrome", "Chromium", "Microsoft Edge", "Brave", "Vivaldi", "other Chromium browsers with Manifest V3"],
      controls_existing_profile: true,
      uses_existing_tabs_and_login_state: true,
      source_access: true,
      complex_form_fill: true,
      screenshots: true,
      restricted_pages: ["browser-internal pages", "extension stores", "some PDF/plugin viewers", "pages blocked by enterprise policy"],
      security: {
        loopback_only: true,
        bearer_pairing_token: true,
        arbitrary_extension_code_from_mcp: false,
        resource_values_returned_to_model: false,
      },
    };
  }

  async pair(args = {}, context = {}) {
    this.assertFull("pair_browser_extension");
    const status = await this.status(context);
    if (args.open !== false) {
      const command = process.platform === "darwin"
        ? { cmd: "open", argv: [status.pairing_url] }
        : process.platform === "win32"
          ? { cmd: "cmd.exe", argv: ["/d", "/s", "/c", "start", "", status.pairing_url] }
          : { cmd: "xdg-open", argv: [status.pairing_url] };
      await this.runProcess(command.cmd, command.argv, 30_000, false, 128 * 1024, context);
    }
    return {
      ...status,
      opened_pairing_page: args.open !== false,
      setup_steps: [
        "Open the browser extensions page and enable developer mode.",
        "Load the unpacked extension from extension_path once.",
        "Open pairing_url; the installed extension stores the loopback endpoint and token locally.",
      ],
    };
  }

  async listTabs(args = {}, context = {}) {
    const response = await this.request("list_tabs", {
      currentWindow: args.current_window === true,
      includePinned: args.include_pinned !== false,
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return response;
  }

  async getSource(args = {}, context = {}) {
    const response = await this.request("get_source", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      allFrames: args.all_frames === true,
      maxBytes: clampInt(args.max_bytes, 1024 * 1024, 1, MAX_SOURCE_BYTES),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return response;
  }

  async inspectPage(args = {}, context = {}) {
    return this.request("inspect_page", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      allFrames: args.all_frames !== false,
      maxElements: clampInt(args.max_elements, 300, 1, 1000),
      includeValues: args.include_values === true,
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async act(args = {}, context = {}) {
    this.assertFull("browser_action");
    const action = normalizeBrowserAction(args.action);
    const rawUrl = optionalString(args.url, "url", 32768);
    const payload = {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      action,
      selector: normalizeBrowserSelector(args.selector, action),
      url: action === "navigate" ? validateNavigationUrl(rawUrl) : "",
      value: null,
      key: optionalString(args.key, "key", 100),
      waitFor: normalizeWait(args.wait_for),
    };
    if (action !== "navigate" && rawUrl) throw new Error("url is only valid for navigate");
    if (action !== "press" && payload.key) throw new Error("key is only valid for press");
    if (args.value !== undefined) payload.value = boundedValue(args.value, "value");
    if (args.value_resource !== undefined) {
      if (payload.value !== null) throw new Error("value and value_resource are mutually exclusive");
      payload.value = boundedValue(await this.readResourceText(validateResource(args.value_resource)), "value_resource");
    }
    if (payload.value !== null && !["fill", "select", "press"].includes(action)) throw new Error(`value is not valid for browser action '${action}'`);
    const response = await this.request("action", payload, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return {
      ...response,
      value_source: args.value_resource !== undefined ? "local-resource" : payload.value === null ? "none" : "mcp-argument",
      value_exposed: false,
    };
  }

  async fillForm(args = {}, context = {}) {
    this.assertFull("browser_fill_form");
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error("fields must be a non-empty array");
    if (args.fields.length > MAX_FORM_FIELDS) throw new Error(`fields contains more than ${MAX_FORM_FIELDS} entries`);
    const fields = [];
    let totalValueBytes = 0;
    for (let index = 0; index < args.fields.length; index += 1) {
      const input = args.fields[index];
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`fields[${index}] must be an object`);
      const allowed = new Set(["selector", "value", "value_resource", "action", "sensitive"]);
      for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown fields[${index}] property: ${key}`);
      let value = input.value === undefined ? null : boundedValue(input.value, `fields[${index}].value`);
      if (input.value_resource !== undefined) {
        if (value !== null) throw new Error(`fields[${index}] value and value_resource are mutually exclusive`);
        value = boundedValue(await this.readResourceText(validateResource(input.value_resource)), `fields[${index}].value_resource`);
      }
      if (value !== null) {
        totalValueBytes += Buffer.byteLength(value);
        if (totalValueBytes > MAX_FORM_VALUE_BYTES) throw new Error("form field values exceed 4 MiB total");
      }
      const action = input.action === undefined ? "fill" : normalizeFormAction(input.action);
      if (value === null && !["check", "uncheck", "click"].includes(action)) throw new Error(`fields[${index}] requires value or value_resource`);
      fields.push({
        selector: normalizeBrowserSelector(input.selector, action),
        value,
        action,
        sensitive: input.sensitive === true || input.value_resource !== undefined,
      });
    }
    return this.request("fill_form", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      fields,
      submit: args.submit === true,
      submitSelector: args.submit_selector ? normalizeBrowserSelector(args.submit_selector, "click") : null,
      waitFor: normalizeWait(args.wait_for),
    }, clampInt(args.timeout_seconds, 60, 1, 180), context);
  }

  async uploadFiles(args = {}, context = {}) {
    this.assertFull("browser_upload_files");
    if (!Array.isArray(args.resources) || !args.resources.length || args.resources.length > 8) throw new Error("resources must contain 1 to 8 registered resource names");
    const filenames = optionalStringArray(args.filenames, "filenames", 8, 255);
    const mimeTypes = optionalStringArray(args.mime_types, "mime_types", 8, 200);
    if (filenames.length > args.resources.length || mimeTypes.length > args.resources.length) throw new Error("filenames and mime_types cannot contain more entries than resources");
    const files = [];
    let total = 0;
    for (const raw of args.resources) {
      const name = validateResource(raw);
      const resource = this.readResourceBinary(name);
      total += resource.buffer.length;
      if (total > 5 * 1024 * 1024) throw new Error("browser upload resources exceed 5 MiB total");
      files.push({
        filename: String(args.filenames?.[files.length] || resource.path.split(/[\\/]/).pop() || name).slice(0, 255),
        mime: String(args.mime_types?.[files.length] || "application/octet-stream").slice(0, 200),
        data: resource.buffer.toString("base64"),
      });
    }
    const result = await this.request("upload_files", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      selector: normalizeBrowserSelector(args.selector, "fill"),
      files,
    }, clampInt(args.timeout_seconds, 60, 1, 180), context);
    return { ...result, resource_names: args.resources.map(String), resource_contents_exposed: false };
  }

  async screenshot(args = {}, context = {}) {
    const result = await this.request("screenshot", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      format: args.format === "jpeg" ? "jpeg" : "png",
      quality: clampInt(args.quality, 90, 1, 100),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    const data = String(result.data || "");
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) throw new Error("browser extension returned an invalid screenshot");
    return {
      $mcp: {
        content: [{ type: "image", data: match[2], mimeType: match[1] }],
        structuredContent: {
          tab_id: result.tab_id,
          url: result.url,
          title: result.title,
          mime_type: match[1],
        },
      },
    };
  }

  async request(method, params, timeoutSeconds, context = {}) {
    this.assertFull(method);
    await this.ensureStarted(context);
    this.throwIfCancelled(context);
    const transport = this.server ? this.socket : this.upstream;
    const extensionConnected = this.server ? this.socket?.readyState === 1 : this.proxyExtensionConnected;
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
    this.stopping = false;
    if (this.server || this.upstream?.readyState === 1) return;
    if (!this.startPromise) this.startPromise = this.start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  async start() {
    const pairing = await loadOrCreatePairing(this.stateRoot);
    this.token = pairing.token;
    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      const port = pairing.port + offset;
      try {
        await this.listen(port);
        if (port !== pairing.port && this.stateRoot) await savePairing(this.stateRoot, { token: this.token, port });
        return;
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        if (await this.connectProxy(port)) {
          this.port = port;
          return;
        }
        if (offset === MAX_PORT_ATTEMPTS - 1) throw error;
      }
    }
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
        if (url.pathname === "/extension" && protocol === `mbm.${this.token}` && origin.startsWith("chrome-extension://")) role = "extension";
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

  async connectProxy(port) {
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
        if (!ok) try { ws.close(); } catch {}
        resolvePromise(ok);
      };
      ws.on("message", (data) => {
        let message;
        try { message = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
        if (!settled && message?.type === "hello" && message?.role === "runtime") {
          this.upstream = ws;
          this.proxyExtensionConnected = message.extension_connected === true;
          finish(true);
          return;
        }
        this.handleUpstreamMessage(message);
      });
      ws.once("error", () => finish(false));
      ws.once("close", () => {
        if (this.upstream === ws) {
          this.upstream = null;
          this.proxyExtensionConnected = false;
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
      safeSocketSend(ws, { type: "hello", role: "runtime", protocol: 1, extension_connected: this.socket?.readyState === 1 });
      return;
    }
    if (this.socket && this.socket.readyState === 1) this.socket.close(4001, "superseded");
    this.socket = ws;
    ws.on("message", (data) => this.handleExtensionMessage(data));
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.rejectPending("browser extension disconnected");
      for (const [id, route] of this.proxyRoutes) {
        clearTimeout(route.timeout);
        try { route.socket.send(JSON.stringify({ type: "response", id: route.id, ok: false, error: "browser extension disconnected" })); } catch {}
        this.proxyRoutes.delete(id);
      }
      this.broadcastRuntimeStatus(false);
    });
    ws.on("error", () => {});
    safeSocketSend(ws, { type: "hello", role: "extension", protocol: 1 });
    this.broadcastRuntimeStatus(true);
  }

  handleExtensionMessage(data) {
    if (Buffer.byteLength(data) > MAX_BROWSER_MESSAGE_BYTES) return;
    let message;
    try { message = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
    if (!message || message.type !== "response" || typeof message.id !== "string") return;
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
    if (Buffer.byteLength(data) > MAX_BROWSER_MESSAGE_BYTES) return;
    let message;
    try { message = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
    if (message?.type === "ping") return;
    if (message?.type === "cancel" && typeof message.id === "string") {
      for (const [routedId, route] of this.proxyRoutes) {
        if (route.socket !== socket || route.id !== message.id) continue;
        clearTimeout(route.timeout);
        this.proxyRoutes.delete(routedId);
        try { this.socket?.send(JSON.stringify({ type: "cancel", id: routedId })); } catch {}
      }
      return;
    }
    if (!message || message.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
    if (!this.socket || this.socket.readyState !== 1) {
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
      try { this.socket?.send(JSON.stringify({ type: "cancel", id: routedId })); } catch {}
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser broker request timed out" });
    }, timeoutMs);
    timeout.unref?.();
    this.proxyRoutes.set(routedId, { socket, id: message.id, timeout });
    try {
      this.socket.send(JSON.stringify({ ...message, id: routedId }));
    } catch {
      clearTimeout(timeout);
      this.proxyRoutes.delete(routedId);
      safeSocketSend(socket, { type: "response", id: message.id, ok: false, error: "browser extension send failed" });
    }
  }

  handleUpstreamMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "status") {
      this.proxyExtensionConnected = message.extension_connected === true;
      if (!this.proxyExtensionConnected) this.rejectPending("browser extension disconnected");
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok === false) pending.reject(new Error(String(message.error || "browser operation failed").slice(0, 2000)));
    else pending.resolve(message.result);
  }

  broadcastRuntimeStatus(connected) {
    const message = { type: "status", extension_connected: connected };
    for (const client of this.runtimeClients) safeSocketSend(client, message);
  }

  scheduleBrokerRecovery() {
    if (this.stopping || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.ensureStarted().catch(() => this.scheduleBrokerRecovery());
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
      sendJson(response, { ok: true, connected: this.socket?.readyState === 1, broker: "machine-bridge-browser" });
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

  stop() {
    this.stopping = true;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.rejectPending("browser bridge stopped");
    try { this.upstream?.close(1001, "runtime stopped"); } catch {}
    try { this.socket?.close(1001, "runtime stopped"); } catch {}
    for (const client of this.runtimeClients) try { client.close(1001, "runtime stopped"); } catch {}
    this.upstream = null;
    this.socket = null;
    this.runtimeClients.clear();
    for (const route of this.proxyRoutes.values()) clearTimeout(route.timeout);
    this.proxyRoutes.clear();
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.wss = null;
    this.server = null;
  }

  assertFull(tool) {
    if (this.policy.profile !== "full" || this.policy.execMode !== "shell" || this.policy.unrestrictedPaths !== true) {
      throw new Error(`${tool} requires the canonical full profile`);
    }
  }
}

async function loadOrCreatePairing(stateRoot) {
  if (!stateRoot) return { token: randomBytes(32).toString("base64url"), port: DEFAULT_PORT };
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const file = join(stateRoot, PAIRING_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (existsSync(file)) {
      ownerOnlyFile(file);
      let parsed;
      try { parsed = JSON.parse(readBoundedRegularFileSync(file, 64 * 1024).toString("utf8")); } catch { throw new Error("browser pairing state is not valid bounded JSON"); }
      if (!/^[A-Za-z0-9_-]{32,100}$/.test(parsed.token) || !Number.isInteger(parsed.port) || parsed.port < 1024 || parsed.port > 65535) {
        throw new Error("browser pairing state is invalid");
      }
      return parsed;
    }
    const value = { token: randomBytes(32).toString("base64url"), port: DEFAULT_PORT };
    let fd;
    try {
      fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      ownerOnlyFile(file);
      return value;
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("browser pairing state could not be initialized");
}

async function savePairing(stateRoot, value) {
  const file = join(stateRoot, PAIRING_FILE);
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    replaceFileSync(temp, file);
    ownerOnlyFile(file);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function pairingHtml(port, token) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="machine-bridge-browser-pair" content="1"><meta name="machine-bridge-browser-port" content="${port}"><meta name="machine-bridge-browser-token" content="${token}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Machine Bridge browser pairing</title></head><body><h1>Machine Bridge browser pairing</h1><p>The installed extension reads pairing material from this loopback-only page and stores it in browser-local extension storage. It is not sent to any website.</p><p id="status">Waiting for the Machine Bridge extension.</p></body></html>`;
}

function isAllowedLoopbackHost(host, port) {
  const normalized = String(host || "").toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || normalized === `[::1]:${port}`;
}

function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function safeSocketSend(socket, value) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(typeof value === "string" ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function sendJson(response, value) {
  response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}

function normalizeBrowserAction(value) {
  const action = String(value || "").trim();
  if (!["navigate", "click", "fill", "select", "check", "uncheck", "focus", "press", "submit", "reload", "back", "forward"].includes(action)) {
    throw new Error("unsupported browser action");
  }
  return action;
}

function normalizeFormAction(value) {
  const action = String(value || "").trim();
  if (!["fill", "select", "check", "uncheck", "click"].includes(action)) throw new Error("unsupported form field action");
  return action;
}

function normalizeBrowserSelector(value, action) {
  if (["navigate", "reload", "back", "forward"].includes(action)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object");
  const allowed = new Set(["css", "id", "name", "label", "text", "role", "placeholder", "index"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown selector field: ${key}`);
  const output = {};
  for (const key of ["css", "id", "name", "label", "text", "role", "placeholder"]) {
    if (value[key] !== undefined) output[key] = optionalString(value[key], `selector.${key}`, 2000);
  }
  if (value.index !== undefined) output.index = optionalInteger(value.index, "selector.index", 0, 10000);
  if (!Object.keys(output).length) throw new Error("selector requires at least one field");
  return output;
}

function validateNavigationUrl(value) {
  if (!value) throw new Error("navigate requires url");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("url must be an absolute URL"); }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error("url protocol must be http, https, or file");
  return parsed.href;
}

function optionalStringArray(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0") || !item.length || item.length > maxLength) throw new Error(`${label}[${index}] must be a non-empty string of at most ${maxLength} characters`);
    return item;
  });
}

function normalizeWait(value) {
  if (value === undefined || value === null || value === "") return "none";
  const wait = String(value);
  if (!["none", "domcontentloaded", "complete"].includes(wait)) throw new Error("wait_for must be none, domcontentloaded, or complete");
  return wait;
}

function boundedValue(value, label) {
  const string = String(value);
  if (string.includes("\0") || string.length > MAX_FIELD_VALUE_CHARS) throw new Error(`${label} exceeds the maximum length or contains a NUL byte`);
  return string;
}

function validateResource(value) {
  const name = String(value || "").trim();
  if (!RESOURCE_NAME.test(name)) throw new Error("value_resource is invalid");
  return name;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  return value;
}

function optionalInteger(value, label, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return number;
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return number;
}
