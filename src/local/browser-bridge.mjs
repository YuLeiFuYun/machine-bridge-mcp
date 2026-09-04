import { resolve } from "node:path";
import { WebSocket } from "ws";
import { createToolAuthorizer } from "./policy.mjs";
import { assertStateMaintenanceAvailable } from "./state.mjs";
import { packageRoot } from "./package-identity.mjs";
import {
  BROWSER_EXTENSION_PROTOCOL, EXPECTED_EXTENSION_VERSION, MAX_BROWSER_MESSAGE_BYTES,
  closeProtocolSocket, normalizeCompatibleExtensionInfo, parseBrowserSocketMessage, parseExtensionHello, safeSocketSend,
} from "./browser-extension-protocol.mjs";
import { loadOrCreatePairing, savePairing } from "./browser-pairing-store.mjs";
import { BrowserOperationService } from "./browser-operation-service.mjs";
import { classifyOperationalError } from "./log.mjs";
import { BrowserRequestRegistry } from "./browser-request-registry.mjs";
import { handleBrowserBridgeHttp } from "./browser-bridge-http.mjs";
import { BrowserBrokerRoutes } from "./browser-broker-routes.mjs";
import { startBrowserBrokerServer } from "./browser-broker-server.mjs";
import { EXPECTED_EXTENSION_ID } from "./browser-extension-identity.mjs";
import { BROKER_AUTH_REQUEST_HEADER, BROKER_AUTH_REQUEST_VALUE, createBrokerAuthChallenge, createBrokerClientProtocol, createBrokerInitProof, parseBrokerAuthResponse, verifyBrokerServerProof } from "./browser-broker-auth.mjs";
import { startBrowserPairingLaunch } from "./browser-pairing-launch.mjs";
import { browserExtensionPathForRuntime } from "./browser-extension-path.mjs";

const MAX_PORT_ATTEMPTS = 10;
const MAX_PENDING = 32;
const EXTENSION_HANDSHAKE_MS = 3_000;

export class BrowserBridgeManager {
  constructor({ policy, authorizeTool = null, stateRoot = "", runProcess, readResourceText, readResourceBinary, throwIfCancelled = () => {}, logger = null, startBrokerServer = startBrowserBrokerServer }) {
    this.policy = policy || {};
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.stateRoot = stateRoot ? resolve(stateRoot) : "";
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.readResourceBinary = readResourceBinary;
    this.throwIfCancelled = throwIfCancelled;
    this.logger = logger || { event() {} };
    this.startBrokerServer = startBrokerServer;
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.pendingExtensionSocket = null;
    this.upstream = null;
    this.proxyExtensionConnected = false;
    this.extensionInfo = null;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
    this.extensionConnectionGeneration = 0;
    this.proxyExtensionConnectionGeneration = 0;
    this.extensionReloadRequiredFlag = false;
    this.recoveryTimer = null;
    this.stopping = false;
    this.requestRegistry = new BrowserRequestRegistry({ maximum: MAX_PENDING });
    this.pending = this.requestRegistry.pending;
    this.brokerRoutes = new BrowserBrokerRoutes({
      maximum: MAX_PENDING * 4,
      getExtensionSocket: () => this.socket,
      extensionConnected: () => this.extensionConnected(),
      extensionStatusInfo: () => this.extensionStatusInfo(),
      extensionReloadRequired: () => this.extensionReloadRequired(),
      extensionGeneration: () => this.extensionConnectionGeneration,
    });
    this.startPromise = null;
    this.startGeneration = 0;
    this.port = 0;
    this.extensionToken = "";
    this.runtimeToken = "";
    this.extensionPath = browserExtensionPathForRuntime({ stateRoot: this.stateRoot, packageDirectory: packageRoot });
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
        extensionGeneration: this.server ? this.extensionConnectionGeneration : this.proxyExtensionConnectionGeneration,
        ...this.brokerRoutes.snapshot(),
      }),
      createPairingLaunch: (port) => startBrowserPairingLaunch({ brokerPort: port, extensionToken: this.extensionToken }),
      extensionPath: this.extensionPath,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
      expectedExtensionId: EXPECTED_EXTENSION_ID,
      runProcess: (...args) => this.runProcess(...args),
      readResourceText: (name) => this.readResourceText(name),
      readResourceBinary: (name) => this.readResourceBinary(name),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
      logger: this.logger,
    });
  }

  brokerDiagnostics() { return this.brokerRoutes.snapshot(); }

  status(context = {}) { return this.operationService.status(context); }

  pair(args = {}, context = {}) { return this.operationService.pair(args, context); }

  listTabs(args = {}, context = {}) { return this.operationService.listTabs(args, context); }

  manageTabs(args = {}, context = {}) { return this.operationService.manageTabs(args, context); }

  wait(args = {}, context = {}) { return this.operationService.wait(args, context); }

  getSource(args = {}, context = {}) { return this.operationService.getSource(args, context); }

  inspectPage(args = {}, context = {}) { return this.operationService.inspectPage(args, context); }

  observeComputer(args = {}, context = {}) { return this.operationService.observeComputer(args, context); }

  documentState(args = {}, context = {}) { return this.operationService.documentState(args, context); }

  pointAction(args = {}, context = {}) { return this.operationService.pointAction(args, context); }

  backendNodeAction(args = {}, context = {}) { return this.operationService.backendNodeAction(args, context); }

  act(args = {}, context = {}) { return this.operationService.act(args, context); }

  fillForm(args = {}, context = {}) { return this.operationService.fillForm(args, context); }

  uploadFiles(args = {}, context = {}) { return this.operationService.uploadFiles(args, context); }

  screenshot(args = {}, context = {}) { return this.operationService.screenshot(args, context); }

  async request(method, params, timeoutSeconds, context = {}) {
    await this.ensureStarted(context);
    this.throwIfCancelled(context);
    const transport = this.server ? this.socket : this.upstream;
    if (!transport || transport.readyState !== 1 || !this.extensionConnected()) {
      throw new Error("browser extension is not connected; call pair_browser_extension after loading the packaged extension");
    }
    return this.requestRegistry.request({
      transport,
      method,
      params,
      timeoutSeconds,
      callId: context.callId || "",
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
    this.throwIfCancelled(context);
  }

  async start(generation = this.startGeneration) {
    try {
      const pairing = await loadOrCreatePairing(this.stateRoot);
      this.assertStartCurrent(generation);
      this.extensionToken = pairing.extensionToken;
      this.runtimeToken = pairing.runtimeToken;
      for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
        const port = pairing.port + offset;
        try {
          await this.listen(port);
          this.assertStartCurrent(generation);
          if (this.stateRoot && (port !== pairing.port || pairing.migrationPending)) {
            await savePairing(this.stateRoot, { schemaVersion: pairing.schemaVersion, pairingAuthVersion: pairing.pairingAuthVersion, extensionToken: this.extensionToken, runtimeToken: this.runtimeToken, port, migrationPending: false });
            this.assertStartCurrent(generation);
          }
          return;
        } catch (error) {
          this.assertStartCurrent(generation);
          if (error?.code !== "EADDRINUSE") throw error;
          const proxy = await this.connectProxy(port, generation);
          if (proxy.connected) {
            this.assertStartCurrent(generation);
            this.port = port;
            if (this.stateRoot && pairing.migrationPending) {
              await savePairing(this.stateRoot, { schemaVersion: pairing.schemaVersion, pairingAuthVersion: pairing.pairingAuthVersion, extensionToken: this.extensionToken, runtimeToken: this.runtimeToken, port, migrationPending: false });
              this.assertStartCurrent(generation);
            }
            return;
          }
          this.assertStartCurrent(generation);
          if (proxy.authenticated) {
            throw new Error("browser broker accepted runtime authentication but did not complete its handshake; refusing a second broker owner");
          }
          if (pairing.migrationPending && offset === 0) {
            throw new Error("previous browser broker occupies the migrated pairing port; restart the prior Machine Bridge runtime before browser broker migration can complete");
          }
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
    const { server, wss } = await this.startBrokerServer({
      port,
      extensionToken: this.extensionToken,
      runtimeToken: this.runtimeToken,
      maxPayload: MAX_BROWSER_MESSAGE_BYTES,
      onHttp: (request, response) => this.handleHttp(request, response),
      onSocket: (socket, role) => this.acceptSocket(socket, role),
    });
    this.server = server;
    this.wss = wss;
  }

  async connectProxy(port, generation = this.startGeneration) {
    const clientChallenge = createBrokerAuthChallenge();
    const initProof = createBrokerInitProof(this.runtimeToken, "runtime", clientChallenge);
    const authUrl = `http://127.0.0.1:${port}/runtime-auth?challenge=${encodeURIComponent(clientChallenge)}&init=${encodeURIComponent(initProof)}`;
    let authResponse;
    try {
      authResponse = await fetch(authUrl, { method: "GET", redirect: "error", cache: "no-store", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE }, signal: AbortSignal.timeout(750) });
    } catch { return { connected: false, authenticated: false }; }
    if (authResponse.status !== 204) return { connected: false, authenticated: false };
    const challenge = parseBrokerAuthResponse(authResponse.headers);
    if (!challenge || !verifyBrokerServerProof(this.runtimeToken, "runtime", clientChallenge, challenge.serverNonce, challenge.serverProof)) {
      return { connected: false, authenticated: false };
    }
    this.assertStartCurrent(generation);
    const protocol = createBrokerClientProtocol(this.runtimeToken, "runtime", clientChallenge, challenge.serverNonce);
    const url = `ws://127.0.0.1:${port}/runtime`;
    return new Promise((resolvePromise) => {
      let settled = false;
      const authenticated = true;
      const ws = new WebSocket(url, [protocol], { maxPayload: MAX_BROWSER_MESSAGE_BYTES });
      const timer = setTimeout(() => finish(false), 1500);
      timer.unref?.();
      const finish = (connected) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!connected) {
          try { ws.terminate(); }
          catch {
            try { ws.close(); }
            catch { /* Rejected bridge ownership is already settled even if the peer closed concurrently. */ }
          }
        }
        resolvePromise({ connected, authenticated });
      };
      ws.on("message", (data) => {
        const parsed = parseBrowserSocketMessage(data);
        if (!parsed.ok) { closeProtocolSocket(ws, parsed.code, parsed.reason); return; }
        const message = parsed.message;
        if (!settled) {
          if (message.type !== "hello" || message.role !== "runtime" || message.protocol !== 1) {
            closeProtocolSocket(ws, 1002, "runtime hello required");
            return;
          }
          if (!this.isStartCurrent(generation)) {
            try { ws.close(1001, "runtime stopped"); }
            catch { /* Runtime shutdown may race an already-closed extension socket. */ }
            finish(false);
            return;
          }
          this.upstream = ws;
          const claimedExtension = message.extension_connected === true;
          this.proxyExtensionInfo = claimedExtension ? normalizeCompatibleExtensionInfo(message.extension_info) : null;
          this.proxyExtensionConnected = claimedExtension && Boolean(this.proxyExtensionInfo);
          this.proxyExtensionReloadRequired = message.extension_reload_required === true || (claimedExtension && !this.proxyExtensionInfo);
          this.proxyExtensionConnectionGeneration = this.proxyExtensionConnected ? runtimeExtensionGeneration(message.extension_generation) : 0;
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
          this.proxyExtensionConnectionGeneration = 0;
          this.rejectPending("browser broker disconnected");
          if (settled) this.scheduleBrokerRecovery();
        }
        finish(false);
      });
    });
  }

  acceptSocket(ws, role) {
    if (role === "runtime") {
      this.brokerRoutes.acceptClient(ws);
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
      if (!safeSocketSend(socket, {
        type: "hello_ack", role: "extension", protocol: BROWSER_EXTENSION_PROTOCOL, pong_watchdog: true,
      })) {
        closeProtocolSocket(socket, 1011, "extension acknowledgement failed");
        return;
      }
      this.extensionReloadRequiredFlag = false;
      socket.extensionReady = true;
      if (this.pendingExtensionSocket === socket) this.pendingExtensionSocket = null;
      const previous = this.socket;
      this.socket = socket;
      this.extensionInfo = info;
      this.extensionConnectionGeneration = nextExtensionGeneration(this.extensionConnectionGeneration);
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
    if (message.type === "ping") {
      const seq = Number.isSafeInteger(message.seq) && message.seq > 0 ? message.seq : undefined;
      if (!safeSocketSend(socket, { type: "pong", ...(seq ? { seq } : {}) })) {
        closeProtocolSocket(socket, 1011, "extension pong delivery failed");
      }
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") {
      this.markExtensionReloadRequired();
      closeProtocolSocket(socket, 1002, "invalid extension protocol message");
      return;
    }
    if (this.requestRegistry.settle(message)) return;
    this.brokerRoutes.settleExtensionResponse(message);
  }

  handleRuntimeClientMessage(socket, data) {
    return this.brokerRoutes.handleClientMessage(socket, data);
  }

  handleUpstreamMessage(message) {
    if (message.type === "status" && typeof message.extension_connected === "boolean") {
      const claimedExtension = message.extension_connected === true;
      this.proxyExtensionInfo = claimedExtension ? normalizeCompatibleExtensionInfo(message.extension_info) : null;
      this.proxyExtensionConnected = claimedExtension && Boolean(this.proxyExtensionInfo);
      this.proxyExtensionReloadRequired = message.extension_reload_required === true || (claimedExtension && !this.proxyExtensionInfo);
      this.proxyExtensionConnectionGeneration = this.proxyExtensionConnected ? runtimeExtensionGeneration(message.extension_generation) : 0;
      if (!this.proxyExtensionConnected) this.rejectPending("browser extension disconnected");
      return true;
    }
    if (message.type !== "response" || typeof message.id !== "string") return false;
    this.requestRegistry.settle(message);
    return true;
  }

  broadcastRuntimeStatus(connected) {
    this.brokerRoutes.broadcastStatus(connected);
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
    return handleBrowserBridgeHttp(request, response, {
      port: this.port,
      extensionConnected: () => this.extensionConnected(),
      extensionStatusInfo: () => this.extensionStatusInfo(),
      extensionReloadRequired: () => this.extensionReloadRequired(),
    });
  }

  cancelCall(callId, reason = null) {
    const transport = this.server ? this.socket : this.upstream;
    this.requestRegistry.cancelCall(callId, transport, reason);
  }

  rejectPending(message) {
    this.requestRegistry.rejectAll(message);
  }

  rejectProxyRoutes(message) {
    this.brokerRoutes.rejectAll(message);
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
    try { this.upstream?.close(1001, "runtime stopped"); }
    catch { /* Runtime shutdown is idempotent and the upstream may already be closed. */ }
    try { this.socket?.close(1001, "runtime stopped"); }
    catch { /* Runtime shutdown is idempotent and the client socket may already be closed. */ }
    try { this.pendingExtensionSocket?.close(1001, "runtime stopped"); }
    catch { /* Runtime shutdown is idempotent and the pending extension socket may already be closed. */ }
    this.brokerRoutes.close(message);
    this.upstream = null;
    this.socket = null;
    this.pendingExtensionSocket = null;
    this.extensionInfo = null;
    this.proxyExtensionConnected = false;
    this.proxyExtensionInfo = null;
    this.proxyExtensionReloadRequired = false;
    this.proxyExtensionConnectionGeneration = 0;
    this.extensionReloadRequiredFlag = false;
    try { this.wss?.close(); }
    catch { /* Listener shutdown may race a prior close; ownership state is already terminal. */ }
    try { this.server?.close(); }
    catch { /* Listener shutdown may race a prior close; ownership state is already terminal. */ }
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

function nextExtensionGeneration(value) {
  return Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER ? value + 1 : 1;
}

function runtimeExtensionGeneration(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
