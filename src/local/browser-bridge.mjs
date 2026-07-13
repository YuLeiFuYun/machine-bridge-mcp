import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { assertStateMaintenanceAvailable, ownerOnlyFile, packageRoot } from "./state.mjs";
import {
  clampInt, normalizeBrowserAction, normalizeBrowserSelector, normalizeBrowserWait, normalizeFormAction,
  normalizeInputMode, normalizeNavigationWait, normalizeTabCommand, optionalInteger, optionalString,
  validateNavigationUrl,
} from "./browser-command.mjs";

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
const BROWSER_EXTENSION_PROTOCOL = 2;
const EXTENSION_HANDSHAKE_MS = 3_000;
const REQUIRED_EXTENSION_CAPABILITIES = Object.freeze([
  "semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits",
]);

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
    this.pendingExtensionSocket = null;
    this.upstream = null;
    this.runtimeClients = new Set();
    this.proxyRoutes = new Map();
    this.proxyExtensionConnected = false;
    this.extensionInfo = null;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
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
      connected: this.extensionConnected(),
      broker_role: this.server ? "owner" : this.upstream?.readyState === 1 ? "client" : "unavailable",
      endpoint: `ws://127.0.0.1:${this.port}/extension`,
      pairing_url: `http://127.0.0.1:${this.port}/pair`,
      extension_path: this.extensionPath,
      extension_protocol: this.extensionStatusInfo()?.protocol || null,
      extension_version: this.extensionStatusInfo()?.version || "",
      extension_capabilities: this.extensionStatusInfo()?.capabilities || [],
      extension_reload_required: this.extensionReloadRequired(),
      supported_browsers: ["Chrome", "Chromium", "Microsoft Edge", "Brave", "Vivaldi", "other Chromium browsers with Manifest V3"],
      controls_existing_profile: true,
      uses_existing_tabs_and_login_state: true,
      source_access: true,
      semantic_snapshot_refs: true,
      actionability_waits: true,
      trusted_input: true,
      input_modes: ["auto", "trusted", "dom"],
      complex_form_fill: true,
      tab_management: true,
      explicit_waits: true,
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

  async manageTabs(args = {}, context = {}) {
    return this.request("manage_tabs", normalizeTabCommand(args), clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async wait(args = {}, context = {}) {
    const params = normalizeBrowserWait(args);
    const conditionTimeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    return this.request("wait", params, conditionTimeoutSeconds + 5, context);
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
      waitFor: normalizeNavigationWait(args.wait_for),
      inputMode: normalizeInputMode(args.input_mode),
      elementTimeoutMs: clampInt(args.element_timeout_seconds, 10, 1, 60) * 1000,
    };
    if (action !== "navigate" && rawUrl) throw new Error("url is only valid for navigate");
    if (action !== "press" && payload.key) throw new Error("key is only valid for press");
    if (payload.inputMode === "trusted" && !["click", "double_click", "hover", "press", "type_text"].includes(action)) {
      throw new Error("input_mode=trusted supports click, double_click, hover, press, and type_text only");
    }
    if (args.value !== undefined) payload.value = boundedValue(args.value, "value");
    if (args.value_resource !== undefined) {
      if (payload.value !== null) throw new Error("value and value_resource are mutually exclusive");
      payload.value = boundedValue(await this.readResourceText(validateResource(args.value_resource)), "value_resource");
    }
    if (payload.value !== null && !["fill", "select", "press", "type_text"].includes(action)) throw new Error(`value is not valid for browser action '${action}'`);
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
      waitFor: normalizeNavigationWait(args.wait_for),
      elementTimeoutMs: clampInt(args.element_timeout_seconds, 10, 1, 60) * 1000,
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
      const suppliedFilename = filenames[files.length];
      const derivedFilename = resource.path.split(/[\\/]/).pop() || name;
      files.push({
        filename: normalizeUploadFilename(suppliedFilename || derivedFilename, { derived: !suppliedFilename }),
        mime: normalizeMimeType(mimeTypes[files.length] || "application/octet-stream"),
        data: resource.buffer.toString("base64"),
      });
    }
    const result = await this.request("upload_files", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      selector: normalizeBrowserSelector(args.selector, "fill"),
      files,
      elementTimeoutMs: clampInt(args.element_timeout_seconds, 10, 1, 60) * 1000,
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
          if (message.type !== "hello" || message.role !== "runtime") {
            closeProtocolSocket(ws, 1002, "runtime hello required");
            return;
          }
          this.upstream = ws;
          this.proxyExtensionInfo = message.extension_connected === true ? normalizeExtensionInfo(message.extension_info) : null;
          this.proxyExtensionConnected = message.extension_connected === true && Boolean(this.proxyExtensionInfo);
          this.proxyExtensionReloadRequired = message.extension_reload_required === true;
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
    ws.handshakeTimer = setTimeout(() => closeProtocolSocket(ws, 1002, "extension hello required; reload the extension"), EXTENSION_HANDSHAKE_MS);
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
      for (const [id, route] of this.proxyRoutes) {
        clearTimeout(route.timeout);
        try { route.socket.send(JSON.stringify({ type: "response", id: route.id, ok: false, error: "browser extension disconnected" })); } catch {}
        this.proxyRoutes.delete(id);
      }
      this.broadcastRuntimeStatus(false);
    });
    ws.on("error", () => {});
    safeSocketSend(ws, { type: "hello", role: "extension", protocol: BROWSER_EXTENSION_PROTOCOL });
  }

  handleExtensionMessage(socket, data) {
    if (this.socket !== socket && this.pendingExtensionSocket !== socket) return;
    const parsed = parseBrowserSocketMessage(data);
    if (!parsed.ok) {
      closeProtocolSocket(socket, parsed.code, parsed.reason);
      return;
    }
    const message = parsed.message;
    if (message.type === "hello") {
      if (socket.extensionReady) {
        closeProtocolSocket(socket, 1002, "duplicate extension hello");
        return;
      }
      let info;
      try { info = parseExtensionHello(message); }
      catch (error) {
        closeProtocolSocket(socket, 1002, String(error?.message || error).slice(0, 120));
        return;
      }
      clearTimeout(socket.handshakeTimer);
      socket.extensionReady = true;
      if (this.pendingExtensionSocket === socket) this.pendingExtensionSocket = null;
      const previous = this.socket;
      this.socket = socket;
      this.extensionInfo = info;
      if (previous && previous !== socket && previous.readyState === 1) previous.close(4001, "superseded");
      this.broadcastRuntimeStatus(true);
      return;
    }
    if (!socket.extensionReady) {
      closeProtocolSocket(socket, 1002, "extension hello required; reload the extension");
      return;
    }
    if (message.type === "ping") return;
    if (message.type !== "response" || typeof message.id !== "string") {
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
      this.proxyExtensionInfo = message.extension_connected ? normalizeExtensionInfo(message.extension_info) : null;
      this.proxyExtensionConnected = message.extension_connected && Boolean(this.proxyExtensionInfo);
      this.proxyExtensionReloadRequired = message.extension_reload_required === true;
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
      sendJson(response, { ok: true, connected: this.extensionConnected(), broker: "machine-bridge-browser" });
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
    try { this.pendingExtensionSocket?.close(1001, "runtime stopped"); } catch {}
    for (const client of this.runtimeClients) try { client.close(1001, "runtime stopped"); } catch {}
    this.upstream = null;
    this.socket = null;
    this.pendingExtensionSocket = null;
    this.extensionInfo = null;
    this.proxyExtensionConnected = false;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
    this.runtimeClients.clear();
    for (const route of this.proxyRoutes.values()) clearTimeout(route.timeout);
    this.proxyRoutes.clear();
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.wss = null;
    this.server = null;
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
      ? this.pendingExtensionSocket?.readyState === 1 && !this.extensionConnected()
      : this.proxyExtensionReloadRequired;
  }

  assertFull(tool) {
    if (this.policy.profile !== "full" || this.policy.execMode !== "shell" || this.policy.unrestrictedPaths !== true) {
      throw new Error(`${tool} requires the canonical full profile`);
    }
  }
}

function parseExtensionHello(message) {
  if (message.role !== "extension" || message.protocol !== BROWSER_EXTENSION_PROTOCOL) {
    throw new Error(`extension protocol mismatch; expected ${BROWSER_EXTENSION_PROTOCOL}; reload the extension`);
  }
  const info = normalizeExtensionInfo(message);
  if (!info) throw new Error("invalid extension hello; reload the extension");
  const missing = REQUIRED_EXTENSION_CAPABILITIES.filter((capability) => !info.capabilities.includes(capability));
  if (missing.length) throw new Error(`extension capability mismatch; reload the extension (${missing.join(",")})`);
  return info;
}

function normalizeExtensionInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const protocol = Number(value.protocol);
  const version = typeof value.version === "string" && value.version.length <= 100 ? value.version : "";
  const capabilities = Array.isArray(value.capabilities)
    ? [...new Set(value.capabilities.filter((entry) => typeof entry === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(entry)))].slice(0, 32)
    : [];
  if (!Number.isInteger(protocol) || protocol < 1 || !version) return null;
  return { protocol, version, capabilities };
}

async function loadOrCreatePairing(stateRoot) {
  if (!stateRoot) return { token: randomBytes(32).toString("base64url"), port: DEFAULT_PORT };
  assertStateMaintenanceAvailable(stateRoot);
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
    try {
      createExclusiveFileSync(file, `${JSON.stringify(value, null, 2)}
`, { mode: 0o600 });
      ownerOnlyFile(file);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("browser pairing state could not be initialized");
}

async function savePairing(stateRoot, value) {
  assertStateMaintenanceAvailable(stateRoot);
  const file = join(stateRoot, PAIRING_FILE);
  replaceFileAtomicallySync(file, `${JSON.stringify(value, null, 2)}
`, { mode: 0o600 });
  ownerOnlyFile(file);
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

function parseBrowserSocketMessage(data) {
  if (Buffer.byteLength(data) > MAX_BROWSER_MESSAGE_BYTES) return { ok: false, code: 1009, reason: "message too large" };
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data)); }
  catch { return { ok: false, code: 1007, reason: "invalid UTF-8" }; }
  let message;
  try { message = JSON.parse(text); }
  catch { return { ok: false, code: 1007, reason: "invalid JSON" }; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, code: 1002, reason: "invalid protocol message" };
  return { ok: true, message };
}

function closeProtocolSocket(socket, code, reason) {
  try { socket.close(code, reason); } catch {}
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

function normalizeUploadFilename(value, { derived = false } = {}) {
  let name = String(value || "");
  if (derived) name = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim();
  if (!name || name === "." || name === ".." || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  return name;
}

function normalizeMimeType(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 200) {
    throw new Error("mime_types entries must be valid media types");
  }
  return mime;
}

function optionalStringArray(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0") || !item.length || item.length > maxLength) throw new Error(`${label}[${index}] must be a non-empty string of at most ${maxLength} characters`);
    return item;
  });
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
