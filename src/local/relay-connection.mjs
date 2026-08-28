import WebSocket from "ws";
import { performance } from "node:perf_hooks";
import { classifyOperationalError } from "./log.mjs";
import { proxyAgentForWebSocket } from "./network-proxy.mjs";
import { RelayLiveness } from "./relay-liveness.mjs";
import { relayLivenessActions } from "./relay-liveness-actions.mjs";
import { RelayConnectTiming } from "./relay-connect-timing.mjs";
import { RelayTransportErrorState } from "./relay-transport-error-state.mjs";
import {
  boundedPositiveInteger, classifyRelayTransportError, formatAttempts, formatDuration, normalizeWorkerUrl, redactUrl,
  relayHttpStatusFromError, sanitizeCloseReason, terminateSocket, tracedTlsConnection,
} from "./relay-connection-support.mjs";
import {
  APPLICATION_PROXY_ROUTE_SCOPE, preferredRelayCloseCategory, recordRecoveredOutage, relayOutageFields,
  relayRecoveryFields, relayStatusSnapshot,
} from "./relay-diagnostics.mjs";
import {
  acknowledgementMismatch, isSupersededClose, readinessMismatch, reconnectDelay, relayCloseCategory, relayCloseUserCause,
  relayConnectionId, relayFatalMessage, relayOutageUserAction, relayServerErrorReconnectCategory, sanitizeProtocolErrorCode, welcomeMismatch,
} from "./relay-connection-classification.mjs";
export {
  acknowledgementMismatch, isRelayReadyContext, isSupersededClose, readinessMismatch, reconnectDelay, relayCloseCategory,
  relayOutageUserAction, relayServerErrorReconnectCategory, welcomeMismatch,
} from "./relay-connection-classification.mjs";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_OUTAGE_WARN_AFTER_MS = 10_000;
const DEFAULT_OUTAGE_WARN_REPEAT_MS = 60_000;
const DEFAULT_OUTAGE_WARN_MAX_REPEAT_MS = 15 * 60_000;
const DEFAULT_SCHEDULER = Object.freeze({
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (timer) => clearInterval(timer),
});

export class RelayConnection {
  constructor(options = {}) {
    this.workerUrl = normalizeWorkerUrl(options.workerUrl);
    this.logger = options.logger || console;
    this.helloMessage = typeof options.helloMessage === "function" ? options.helloMessage : () => ({ type: "hello" });
    this.connectionHeaders = typeof options.connectionHeaders === "function" ? options.connectionHeaders : () => ({});
    this.expectedServer = String(options.expectedServer || "");
    this.expectedVersion = String(options.expectedVersion || "");
    this.onMessage = typeof options.onMessage === "function" ? options.onMessage : () => {};
    this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : () => {};
    this.onReady = typeof options.onReady === "function" ? options.onReady : () => {};
    this.onDegraded = typeof options.onDegraded === "function" ? options.onDegraded : () => {};
    this.onRecovered = typeof options.onRecovered === "function" ? options.onRecovered : () => {};
    this.onSuperseded = typeof options.onSuperseded === "function" ? options.onSuperseded : () => {};
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.WebSocketClass = options.WebSocketClass || WebSocket;
    this.scheduler = options.scheduler || DEFAULT_SCHEDULER;
    this.now = typeof options.now === "function" ? options.now : () => performance.now();
    this.wallNow = typeof options.wallNow === "function" ? options.wallNow : Date.now;
    this.reconnectDelay = typeof options.reconnectDelay === "function" ? options.reconnectDelay : reconnectDelay;
    this.proxyAgentForUrl = typeof options.proxyAgentForUrl === "function" ? options.proxyAgentForUrl : proxyAgentForWebSocket;
    this.networkRoute = "unresolved";
    this.networkRouteScope = APPLICATION_PROXY_ROUTE_SCOPE;
    this.maxPayload = boundedPositiveInteger(options.maxPayload, 8 * 1024 * 1024);
    this.connectTimeoutMs = boundedPositiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.handshakeTimeoutMs = boundedPositiveInteger(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.readinessTimeoutMs = boundedPositiveInteger(options.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS);
    this.outageWarnAfterMs = boundedPositiveInteger(options.outageWarnAfterMs, DEFAULT_OUTAGE_WARN_AFTER_MS);
    this.outageWarnRepeatMs = boundedPositiveInteger(options.outageWarnRepeatMs, DEFAULT_OUTAGE_WARN_REPEAT_MS);
    this.outageWarnMaxRepeatMs = Math.max(
      this.outageWarnRepeatMs,
      boundedPositiveInteger(options.outageWarnMaxRepeatMs, DEFAULT_OUTAGE_WARN_MAX_REPEAT_MS),
    );

    this.closed = true;
    this.socket = null;
    this.authenticated = false;
    this.ready = false;
    this.readinessProbeDelivered = false;
    this.hasConnected = false;
    this.connectedAt = 0;
    this.lastReadyInboundSilenceMs = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.handshakeTimer = null;
    this.readinessTimer = null;
    this.outageWarnTimer = null;
    this.outageStartedAt = 0;
    this.outageStartedWallAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.outageWarningCount = 0;
    this.lastOutageWarnAt = 0;
    this.outageCount = 0;
    this.recentOutages = [];
    this.lastCloseCategory = "connection_interrupted";
    this.lastCloseCode = 0;
    this.transportError = new RelayTransportErrorState();
    this.lastDisconnectedAt = 0;
    this.lastReadyAt = 0;
    this.lastReadyWallAt = 0;
    this.lastReadyDurationMs = 0;
    this.lastReconnectDelayMs = 0;
    this.nextReconnectAt = 0;
    this.nextReconnectWallAt = 0;
    this.connectTiming = new RelayConnectTiming(this.now);
    this.pendingCloseCategory = "";
    this.connectedOnce = null;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.sessionGeneration = 0;
    this.activeSessionId = 0;
    this.workerConnectionId = "";
    this.lastDisconnectedWorkerConnectionId = "";
    this.liveness = new RelayLiveness({
      ...options,
      scheduler: this.scheduler,
      now: this.now,
      wallNow: this.wallNow,
      logger: this.logger,
      currentSocket: () => this.socket,
      isActive: () => !this.closed && this.authenticated && this.isSocketOpen(this.socket),
      isApplicationActive: () => !this.closed && this.ready && this.isSocketOpen(this.socket),
      sendApplicationHeartbeat: (_now, socket, onDispatched) =>
        this.sendOnSocket(socket, { type: "heartbeat", ts: this.wallNow() }, onDispatched),
      ...relayLivenessActions(this),
    });
  }

  status() {
    return relayStatusSnapshot(this, this.now());
  }

  currentSessionId() {
    return this.authenticated ? this.activeSessionId : 0;
  }

  takeoverConnectionId() {
    return this.lastDisconnectedWorkerConnectionId;
  }

  start() {
    if (!this.closed && this.connectedOnce) return this.connectedOnce;
    this.closed = false;
    this.connectedOnce = new Promise((resolvePromise, rejectPromise) => {
      this.connectedOnceResolve = resolvePromise;
      this.connectedOnceReject = rejectPromise;
    });
    this.connect();
    return this.connectedOnce;
  }

  stop() {
    const settlePendingStart = this.connectedOnceResolve;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.closed = true;
    this.authenticated = false;
    this.ready = false;
    this.readinessProbeDelivered = false;
    this.activeSessionId = 0;
    this.workerConnectionId = "";
    this.lastDisconnectedWorkerConnectionId = "";
    this.liveness.stop();
    this.clearTimer("connectTimer", "clearTimeout");
    this.clearTimer("handshakeTimer", "clearTimeout");
    this.clearTimer("readinessTimer", "clearTimeout");
    this.clearTimer("reconnectTimer", "clearTimeout");
    this.clearTimer("outageWarnTimer", "clearTimeout");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, "daemon shutdown"); }
      catch { /* Relay shutdown state is already authoritative and the transport may have closed concurrently. */ }
    }
    this.resetOutage();
    this.reconnectAttempt = 0;
    settlePendingStart?.(false);
  }

  send(value) {
    if (!this.ready || !this.isSocketOpen(this.socket)) return false;
    return this.sendOnSocket(this.socket, value);
  }

  sendForSession(value, expectedSessionId) {
    const sessionId = Number(expectedSessionId) || 0;
    if (!sessionId || sessionId !== this.activeSessionId) return { ok: false, reason: "session_ended" };
    if (!this.authenticated || !this.isSocketOpen(this.socket)) return { ok: false, reason: "transport_unavailable" };
    const preReadyControl = ["relay_probe_result", "resume_calls_ack", "authority_revoke_ack"].includes(String(value?.type || ""));
    if (!this.ready && !preReadyControl) return { ok: false, reason: "transport_unavailable" };
    if (!this.sendOnSocket(this.socket, value)) return { ok: false, reason: "send_failed" };
    if (value?.type === "relay_probe_result") this.readinessProbeDelivered = true;
    return { ok: true, reason: "sent" };
  }

  observeApplicationPong(relayContext = {}) {
    const sessionId = Number(relayContext?.sessionId) || 0;
    if (relayContext?.transport && relayContext.transport !== "websocket") return false;
    if (!sessionId || sessionId !== this.activeSessionId || !this.ready || !this.isSocketOpen(this.socket)) return false;
    this.liveness.observeApplicationPong();
    return true;
  }

  interrupt(category = "relay_transport_error") {
    if (this.closed || !this.socket) return false;
    this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, category);
    terminateSocket(this.socket);
    return true;
  }

  observeWelcome(message = {}) {
    const socket = this.socket;
    if (this.closed || this.authenticated || !this.isSocketOpen(socket)) return false;
    const mismatch = welcomeMismatch(message, this.expectedServer, this.expectedVersion);
    if (mismatch) {
      this.logger.debug?.("remote relay welcome rejected", { reason: mismatch });
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    this.workerConnectionId = relayConnectionId(message.connection_id);
    this.logger.debug?.("remote relay welcome received");
    Promise.resolve(this.helloMessage(message, this.status())).then((hello) => {
      if (this.socket !== socket || this.closed || this.authenticated) return;
      this.sendOnSocket(socket, hello);
    }).catch((error) => {
      if (this.socket !== socket || this.closed || this.authenticated) return;
      this.logger.debug?.("could not create daemon authentication proof", { error_class: classifyOperationalError(error) });
      this.failPermanently(error?.code === "device_session_expired"
        ? "relay_device_session_expired" : "relay_authentication_failed");
    });
    return true;
  }
  acknowledge(message = {}) {
    const socket = this.socket;
    if (this.closed || this.authenticated || !this.isSocketOpen(socket)) return false;
    const mismatch = acknowledgementMismatch(message, this.expectedServer, this.expectedVersion);
    if (mismatch) {
      this.logger.debug?.("remote relay acknowledgement rejected", { reason: mismatch });
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    this.authenticated = true;
    this.readinessProbeDelivered = false;
    this.sessionGeneration += 1;
    this.activeSessionId = this.sessionGeneration;
    this.clearTimer("handshakeTimer", "clearTimeout");
    this.connectedAt = this.now();
    this.liveness.start();
    this.clearTimer("readinessTimer", "clearTimeout");
    this.readinessTimer = this.scheduler.setTimeout(() => {
      if (this.socket !== socket || this.closed || this.ready) return;
      this.logger.debug?.("remote relay end-to-end readiness probe timed out", { timeout_ms: this.readinessTimeoutMs });
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_readiness_timeout");
      this.connectTiming.captureFailure();
      terminateSocket(socket);
    }, this.readinessTimeoutMs);
    this.readinessTimer?.unref?.();
    return true;
  }

  confirmReady(message = {}) {
    const socket = this.socket;
    if (this.closed || !this.authenticated || this.ready || !this.isSocketOpen(socket)) return false;
    const mismatch = readinessMismatch(message, this.expectedServer, this.expectedVersion);
    if (!mismatch && !this.readinessProbeDelivered) {
      this.logger.debug?.("remote relay declared readiness before the end-to-end probe result was delivered");
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    if (mismatch) {
      this.logger.debug?.("remote relay readiness acknowledgement rejected", { reason: mismatch });
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    this.ready = true;
    this.clearTimer("readinessTimer", "clearTimeout");
    this.reconnectAttempt = 0;
    this.lastReadyAt = this.now();
    this.lastReadyWallAt = this.wallNow();
    this.nextReconnectAt = 0;
    this.nextReconnectWallAt = 0;
    this.lastReconnectDelayMs = 0;

    const recoveredOutage = this.outageStartedAt > 0;
    const outageMs = recoveredOutage ? Math.max(0, this.now() - this.outageStartedAt) : 0;
    if (!this.hasConnected) {
      this.logger.info?.("remote relay connected and end-to-end result delivery verified");
    } else if (recoveredOutage) {
      if (this.outageNoticeEmitted) {
        const recoveryFields = relayRecoveryFields(this, outageMs);
        this.logger.warn?.(`remote relay WebSocket restored after ${formatDuration(outageMs)} (${formatAttempts(this.outageAttempts)})`, recoveryFields);
        this.logger.debug?.("remote relay WebSocket outage recovery details", recoveryFields);
      } else {
        this.logger.debug?.("remote relay WebSocket recovered after a brief interruption", {
          outage_ms: outageMs,
          attempts: this.outageAttempts,
        });
      }
    }
    if (recoveredOutage) recordRecoveredOutage(this, outageMs);

    const reconnected = this.hasConnected;
    this.hasConnected = true;
    this.resetOutage();
    try { this.onReady({ reconnected, sessionId: this.activeSessionId }); } catch (error) {
      this.logger.error?.("relay ready callback failed", { error_class: classifyOperationalError(error) });
    }
    if (this.connectedOnceResolve) {
      this.connectedOnceResolve(true);
      this.connectedOnceResolve = null;
      this.connectedOnceReject = null;
    }
    return true;
  }

  handleServerError(message = {}) {
    const errorCode = sanitizeProtocolErrorCode(message?.error);
    const reconnectCategory = relayServerErrorReconnectCategory(errorCode, {
      authenticated: this.authenticated,
      ready: this.ready,
    });
    this.logger.debug?.(
      reconnectCategory ? "remote relay requested connection recovery" : "remote relay reported a protocol error",
      { error_code: errorCode, reconnect_category: reconnectCategory || "none" },
    );
    if (reconnectCategory) {
      const socket = this.socket;
      if (this.closed || !socket) return true;
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, reconnectCategory);
      terminateSocket(socket);
      return true;
    }
    this.failPermanently("relay_protocol_error");
    return true;
  }

  connect() {
    if (this.closed || this.socket) return;
    const wsUrl = `${this.workerUrl.replace(/^http/i, "ws")}/daemon/ws`;
    this.connectTiming.begin();
    this.logger.debug?.("connecting to remote relay", { endpoint: redactUrl(wsUrl), attempt: this.reconnectAttempt + 1 });
    let socket;
    try {
      const proxy = this.proxyAgentForUrl(wsUrl);
      const headers = this.connectionHeaders();
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("relay connection headers are invalid");
      this.networkRoute = proxy?.agent ? "application-http-proxy" : "system-network-stack";
      this.connectTiming.observe(proxy?.agent ? "proxy_connecting" : "tcp_connecting");
      socket = new this.WebSocketClass(wsUrl, {
        headers,
        maxPayload: this.maxPayload,
        perMessageDeflate: false,
        ...(proxy?.agent ? { agent: proxy.agent } : {}),
        ...(!proxy?.agent && this.WebSocketClass === WebSocket ? {
          createConnection: tracedTlsConnection((stage) => this.connectTiming.observe(stage)),
        } : {}),
      });
      this.logger.debug?.("remote relay network route selected", { route: this.networkRoute });
    } catch (error) {
      if (error?.code === "device_session_expired") {
        this.failPermanently("relay_device_session_expired");
        return;
      }
      if (error?.code === "relay_proxy_configuration") {
        this.networkRoute = "invalid-application-proxy-configuration";
        this.failPermanently("relay_proxy_configuration");
        return;
      }
      const errorClass = this.transportError.record(classifyRelayTransportError(error), { error });
      this.lastCloseCode = 0;
      this.lastDisconnectedAt = this.wallNow();
      this.connectTiming.captureFailure();
      this.logger.debug?.("remote relay connection could not be created", { error_class: errorClass });
      this.scheduleReconnect("connection_interrupted");
      return;
    }
    this.socket = socket;
    this.clearTimer("connectTimer", "clearTimeout");
    this.connectTimer = this.scheduler.setTimeout(() => {
      if (this.socket !== socket || this.closed || this.isSocketOpen(socket)) return;
      this.logger.debug?.("remote relay transport connection timed out", { timeout_ms: this.connectTimeoutMs });
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_connect_timeout");
      this.connectTiming.captureFailure();
      terminateSocket(socket);
    }, this.connectTimeoutMs);
    this.connectTimer?.unref?.();

    socket.on("open", () => {
      this.clearTimer("connectTimer", "clearTimeout");
      if (this.socket !== socket || this.closed) {
        try { socket.close(1000, "stale daemon connection"); }
        catch { /* Stale transport ownership has already been rejected; concurrent close is harmless. */ }
        return;
      }
      this.logger.debug?.("remote relay transport opened; awaiting device challenge");
      this.connectTiming.observe("websocket_open");
      this.connectTiming.finish();
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.handshakeTimer = this.scheduler.setTimeout(() => {
        if (this.socket !== socket || this.closed || this.ready) return;
        this.logger.debug?.("remote relay authentication acknowledgement timed out", { timeout_ms: this.handshakeTimeoutMs });
        this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_handshake_timeout");
        this.connectTiming.captureFailure();
        terminateSocket(socket);
      }, this.handshakeTimeoutMs);
      this.handshakeTimer?.unref?.();
    });

    socket.on("message", (data) => {
      if (this.socket !== socket || this.closed) return;
      this.liveness.observeApplicationInbound();
      // Bind results to the generation that received this message.
      const relayContext = {
        sessionId: this.activeSessionId,
        authenticated: this.authenticated === true,
        ready: this.ready === true,
        transport: "websocket",
      };
      try {
        const outcome = this.onMessage(data, relayContext);
        if (outcome && typeof outcome.catch === "function") {
          outcome.catch((error) => this.logger.error?.("daemon message handler failed", { error_class: classifyOperationalError(error) }));
        }
      } catch (error) {
        this.logger.error?.("daemon message handler failed", { error_class: classifyOperationalError(error) });
      }
    });

    socket.on("pong", () => {
      if (this.socket !== socket || this.closed) return;
      this.liveness.observeInbound();
    });

    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      const wasReady = this.ready;
      const wasAuthenticated = this.authenticated;
      const disconnectedWorkerConnectionId = this.workerConnectionId;
      const readyInboundSilenceMs = this.liveness.silenceMs(this.now());
      this.socket = null;
      this.authenticated = false;
      this.ready = false;
      this.readinessProbeDelivered = false;
      this.activeSessionId = 0;
      this.workerConnectionId = "";
      if (wasReady && disconnectedWorkerConnectionId) this.lastDisconnectedWorkerConnectionId = disconnectedWorkerConnectionId;
      this.liveness.stop();
      this.clearTimer("connectTimer", "clearTimeout");
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.clearTimer("readinessTimer", "clearTimeout");
      const reasonText = sanitizeCloseReason(reason);
      const category = this.pendingCloseCategory || relayCloseCategory(code, reasonText);
      this.pendingCloseCategory = "";
      if (category !== "relay_transport_error") {
        this.transportError.clear();
      }
      const disconnectedAt = this.now();
      const connectedForMs = wasAuthenticated && this.connectedAt > 0 ? Math.max(0, disconnectedAt - this.connectedAt) : 0;
      if (wasReady) this.lastReadyInboundSilenceMs = readyInboundSilenceMs;
      this.lastDisconnectedAt = this.wallNow();
      if (wasReady && this.lastReadyAt > 0) this.lastReadyDurationMs = Math.max(0, disconnectedAt - this.lastReadyAt);
      this.lastCloseCode = Number(code) || 0;
      this.logger.debug?.("remote relay transport closed", {
        close_code: this.lastCloseCode,
        close_reason: reasonText || "<none>",
        category,
        ready: wasReady,
        connected_for_ms: connectedForMs,
      });

      if (category === "relay_policy_rejected") {
        this.failPermanently("relay_authentication_failed", { socketAlreadyClosed: true, wasReady });
        return;
      }

      if (wasReady) {
        try { this.onDisconnect(); } catch (error) {
          this.logger.error?.("relay disconnect callback failed", { error_class: classifyOperationalError(error) });
        }
      }

      if (isSupersededClose(code, reasonText)) {
        this.closed = true;
        this.clearTimer("reconnectTimer", "clearTimeout");
        this.clearTimer("outageWarnTimer", "clearTimeout");
        this.logger.warn?.("daemon connection was replaced by a newer verified instance");
        queueMicrotask(async () => {
          try {
            await this.onSuperseded();
          } catch (error) { this.logger.error?.("daemon superseded callback failed", { error_class: classifyOperationalError(error) }); }
        });
        return;
      }

      if (this.closed) return;
      this.scheduleReconnect(category);
    });

    socket.on("error", (error) => {
      if (this.socket !== socket || this.closed) return;
      const errorClass = this.transportError.record(classifyRelayTransportError(error), { error, ready: this.ready, authenticated: this.authenticated });
      const httpStatus = relayHttpStatusFromError(error);
      if (httpStatus) this.connectTiming.rejectHttp(httpStatus);
      if (!this.ready) this.connectTiming.captureFailure();
      this.logger.debug?.("remote relay transport error", { error_class: errorClass });
      if (errorClass === "authentication_failed") {
        this.failPermanently("relay_authentication_failed");
        return;
      }
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_transport_error");
      terminateSocket(socket);
    });
  }

  failPermanently(category, { socketAlreadyClosed = false, wasReady = this.ready } = {}) {
    if (this.closed) return;
    const socket = this.socket;
    this.closed = true;
    this.authenticated = false;
    this.ready = false;
    this.readinessProbeDelivered = false;
    this.activeSessionId = 0;
    this.liveness.stop();
    this.socket = null;
    this.clearTimer("connectTimer", "clearTimeout");
    this.clearTimer("handshakeTimer", "clearTimeout");
    this.clearTimer("readinessTimer", "clearTimeout");
    this.clearTimer("reconnectTimer", "clearTimeout");
    this.clearTimer("outageWarnTimer", "clearTimeout");
    if (wasReady) {
      try { this.onDisconnect(); } catch (error) {
        this.logger.error?.("relay disconnect callback failed", { error_class: classifyOperationalError(error) });
      }
    }
    if (!socketAlreadyClosed) terminateSocket(socket);
    const message = relayFatalMessage(category);
    const error = new Error(message);
    error.code = category;
    const reject = this.connectedOnceReject;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.resetOutage();
    if (!this.hasConnected && reject) {
      reject(error);
      return;
    }
    this.logger.error?.(message);
    this.logger.debug?.("remote relay fatal details", { category, cause: relayCloseUserCause(category) });
    queueMicrotask(async () => {
      try {
        await this.onFatal(error);
      } catch (callbackError) { this.logger.error?.("relay fatal callback failed", { error_class: classifyOperationalError(callbackError) }); }
    });
  }

  scheduleReconnect(category) {
    if (this.closed || this.reconnectTimer) return;
    this.recordOutage(category);
    const delay = this.reconnectDelay(this.reconnectAttempt++, Math.random, this.connectTiming.durationMs, this.connectTimeoutMs);
    this.lastReconnectDelayMs = delay;
    this.nextReconnectAt = this.now() + delay;
    this.nextReconnectWallAt = this.wallNow() + delay;
    this.scheduleOutageWarning();
    this.logger.debug?.("scheduling daemon reconnect", {
      delay_ms: delay,
      next_reconnect_at: new Date(this.nextReconnectWallAt).toISOString(),
      attempt: this.outageAttempts,
      close_category: this.lastCloseCategory,
      network_route: this.networkRoute,
      network_route_scope: this.networkRouteScope,
    });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = 0;
      this.nextReconnectWallAt = 0;
      this.connect();
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  sendOnSocket(socket, value, onWritten = null) {
    if (!this.isSocketOpen(socket)) return false;
    try {
      const callback = typeof onWritten === "function" ? (error) => {
        if (this.socket !== socket || this.closed) return;
        if (error) this.recordSendFailure(error, socket);
        try { onWritten(error || null, this.now()); }
        catch (observerError) {
          this.logger.error?.("relay send completion observer failed", { error_class: classifyOperationalError(observerError) });
        }
      } : undefined;
      socket.send(JSON.stringify(value), callback);
      return true;
    } catch (error) {
      this.recordSendFailure(error, socket);
      return false;
    }
  }

  recordSendFailure(error, socket) {
    const errorClass = this.transportError.record(classifyRelayTransportError(error),
      { error, ready: this.ready, authenticated: this.authenticated });
    this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_transport_error");
    this.logger.debug?.("remote relay send failed", { error_class: errorClass });
    terminateSocket(socket);
  }

  recordOutage(category) {
    const now = this.now();
    if (this.outageStartedAt === 0) {
      this.outageStartedAt = now;
      this.outageStartedWallAt = this.wallNow();
      this.outageCount += 1;
      this.outageAttempts = 0;
      this.outageNoticeEmitted = false;
      this.lastOutageWarnAt = 0;
    }
    this.outageAttempts += 1;
    this.lastCloseCategory = category;
  }

  scheduleOutageWarning() {
    if (this.outageWarnTimer || this.outageStartedAt === 0 || this.closed || this.ready) return;
    const dueAt = this.outageNoticeEmitted
      ? this.lastOutageWarnAt + this.nextOutageWarningDelay()
      : this.outageStartedAt + this.outageWarnAfterMs;
    const delay = Math.max(0, dueAt - this.now());
    this.outageWarnTimer = this.scheduler.setTimeout(() => {
      this.outageWarnTimer = null;
      if (this.closed || this.ready || this.outageStartedAt === 0) return;
      this.emitOutageWarning();
      this.scheduleOutageWarning();
    }, delay);
    this.outageWarnTimer?.unref?.();
  }

  nextOutageWarningDelay() {
    const exponent = Math.max(0, Math.min(this.outageWarningCount - 1, 20));
    return Math.min(this.outageWarnRepeatMs * (2 ** exponent), this.outageWarnMaxRepeatMs);
  }

  emitOutageWarning() {
    const outageMs = Math.max(0, this.now() - this.outageStartedAt);
    this.outageNoticeEmitted = true;
    this.outageWarningCount += 1;
    this.lastOutageWarnAt = this.now();
    const cause = relayCloseUserCause(this.lastCloseCategory);
    const action = relayOutageUserAction(this.lastCloseCategory, outageMs);
    const outageFields = relayOutageFields(this, this.now(), cause);
    this.logger.warn?.(`remote relay WebSocket unavailable for ${formatDuration(outageMs)}; reconnecting automatically (${formatAttempts(this.outageAttempts)}; ${cause}).${action}`, outageFields);
    this.logger.debug?.("remote relay WebSocket outage details", outageFields);
  }

  resetOutage() {
    this.clearTimer("outageWarnTimer", "clearTimeout");
    this.outageStartedAt = 0;
    this.outageStartedWallAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.outageWarningCount = 0;
    this.lastOutageWarnAt = 0;
    this.nextReconnectAt = 0;
    this.nextReconnectWallAt = 0;
    this.pendingCloseCategory = "";
  }

  clearTimer(property, method) {
    const timer = this[property];
    if (!timer) return;
    this.scheduler[method](timer);
    this[property] = null;
  }

  isSocketOpen(socket) {
    return Boolean(socket && socket.readyState === this.WebSocketClass.OPEN);
  }

}
