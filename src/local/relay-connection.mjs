import WebSocket from "ws";
import { classifyOperationalError } from "./log.mjs";
import { proxyAgentForWebSocket } from "./network-proxy.mjs";
import { RelayHeartbeatMonitor } from "./relay-heartbeat.mjs";
import {
  APPLICATION_PROXY_ROUTE_SCOPE, preferredRelayCloseCategory, relayOutageFields, relayRecoveryFields, relayStatusSnapshot,
} from "./relay-diagnostics.mjs";
import {
  acknowledgementMismatch, isSupersededClose, readinessMismatch, reconnectDelay, relayCloseCategory, relayCloseUserCause,
  relayFatalMessage, relayOutageUserAction, relayServerErrorReconnectCategory, sanitizeProtocolErrorCode, welcomeMismatch,
} from "./relay-connection-classification.mjs";
export {
  acknowledgementMismatch, isRelayReadyContext, isSupersededClose, readinessMismatch, reconnectDelay, relayCloseCategory,
  relayOutageUserAction, relayServerErrorReconnectCategory, welcomeMismatch,
} from "./relay-connection-classification.mjs";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 75_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_OUTAGE_WARN_AFTER_MS = 10_000;
const DEFAULT_OUTAGE_WARN_REPEAT_MS = 60_000;
const DEFAULT_OUTAGE_WARN_MAX_REPEAT_MS = 15 * 60_000;
const MAX_CLOSE_REASON_CHARS = 128;
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
    this.onSuperseded = typeof options.onSuperseded === "function" ? options.onSuperseded : () => {};
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.WebSocketClass = options.WebSocketClass || WebSocket;
    this.scheduler = options.scheduler || DEFAULT_SCHEDULER;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.reconnectDelay = typeof options.reconnectDelay === "function" ? options.reconnectDelay : reconnectDelay;
    this.proxyAgentForUrl = typeof options.proxyAgentForUrl === "function" ? options.proxyAgentForUrl : proxyAgentForWebSocket;
    this.networkRoute = "unresolved";
    this.networkRouteScope = APPLICATION_PROXY_ROUTE_SCOPE;
    this.maxPayload = boundedPositiveInteger(options.maxPayload, 8 * 1024 * 1024);
    this.heartbeatIntervalMs = boundedPositiveInteger(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimeoutMs = boundedPositiveInteger(options.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS);
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
    this.lastInboundAt = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.handshakeTimer = null;
    this.readinessTimer = null;
    this.outageWarnTimer = null;
    this.outageStartedAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.outageWarningCount = 0;
    this.lastOutageWarnAt = 0;
    this.outageCount = 0;
    this.lastCloseCategory = "connection_interrupted";
    this.lastCloseCode = 0;
    this.lastTransportErrorClass = "";
    this.lastDisconnectedAt = 0;
    this.lastReadyAt = 0;
    this.lastReadyDurationMs = 0;
    this.lastReconnectDelayMs = 0;
    this.nextReconnectAt = 0;
    this.pendingCloseCategory = "";
    this.connectedOnce = null;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.sessionGeneration = 0;
    this.activeSessionId = 0;
    this.heartbeat = new RelayHeartbeatMonitor({
      intervalMs: this.heartbeatIntervalMs,
      timeoutMs: this.heartbeatTimeoutMs,
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs,
      scheduler: this.scheduler,
      now: this.now,
      logger: this.logger,
      isActive: () => !this.closed && this.authenticated && this.isSocketOpen(this.socket),
      lastInboundAt: () => this.lastInboundAt,
      sendHeartbeat: (now) => this.sendOnSocket(this.socket, { type: "heartbeat", ts: now }),
      onTimeout: ({ silentForMs, eventLoopLagMs }) => {
        const socket = this.socket;
        if (!socket) return;
        this.logger.debug?.("remote relay heartbeat timed out", {
          silent_for_ms: silentForMs,
          event_loop_lag_ms: eventLoopLagMs,
        });
        this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_heartbeat_timeout");
        terminateSocket(socket);
      },
    });
  }

  status() {
    return relayStatusSnapshot(this, this.now());
  }

  currentSessionId() {
    return this.authenticated ? this.activeSessionId : 0;
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
    this.closed = true;
    this.authenticated = false;
    this.ready = false;
    this.readinessProbeDelivered = false;
    this.activeSessionId = 0;
    this.heartbeat.stop();
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
  }

  send(value) {
    if (!this.ready || !this.isSocketOpen(this.socket)) return false;
    return this.sendOnSocket(this.socket, value);
  }

  sendForSession(value, expectedSessionId) {
    const sessionId = Number(expectedSessionId) || 0;
    if (!sessionId || sessionId !== this.activeSessionId) return { ok: false, reason: "session_ended" };
    if (!this.authenticated || !this.isSocketOpen(this.socket)) return { ok: false, reason: "transport_unavailable" };
    const preReadyControl = value?.type === "relay_probe_result" || value?.type === "authority_revoke_ack";
    if (!this.ready && !preReadyControl) return { ok: false, reason: "transport_unavailable" };
    if (!this.sendOnSocket(this.socket, value)) return { ok: false, reason: "send_failed" };
    if (value?.type === "relay_probe_result") this.readinessProbeDelivered = true;
    return { ok: true, reason: "sent" };
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
    this.logger.debug?.("remote relay welcome received");
    Promise.resolve(this.helloMessage(message, this.status())).then((hello) => {
      if (this.socket !== socket || this.closed || this.authenticated) return;
      this.sendOnSocket(socket, hello);
    }).catch((error) => {
      if (this.socket !== socket || this.closed || this.authenticated) return;
      this.logger.debug?.("could not create daemon authentication proof", { error_class: classifyOperationalError(error) });
      this.failPermanently("relay_authentication_failed");
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
    this.lastInboundAt = this.connectedAt;
    this.heartbeat.start();
    this.clearTimer("readinessTimer", "clearTimeout");
    this.readinessTimer = this.scheduler.setTimeout(() => {
      if (this.socket !== socket || this.closed || this.ready) return;
      this.logger.debug?.("remote relay end-to-end readiness probe timed out", { timeout_ms: this.readinessTimeoutMs });
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_readiness_timeout");
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
    this.nextReconnectAt = 0;
    this.lastReconnectDelayMs = 0;

    if (!this.hasConnected) {
      this.logger.info?.("remote relay connected and end-to-end result delivery verified");
    } else if (this.outageStartedAt > 0) {
      const outageMs = Math.max(0, this.now() - this.outageStartedAt);
      if (this.outageNoticeEmitted) {
        const recoveryFields = relayRecoveryFields(this, outageMs);
        this.logger.warn?.(`remote relay connection restored after ${formatDuration(outageMs)} (${formatAttempts(this.outageAttempts)})`, recoveryFields);
        this.logger.debug?.("remote relay outage recovery details", recoveryFields);
      } else {
        this.logger.debug?.("remote relay connection recovered after a brief interruption", {
          outage_ms: outageMs,
          attempts: this.outageAttempts,
        });
      }
    }

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
    this.logger.debug?.("connecting to remote relay", { endpoint: redactUrl(wsUrl), attempt: this.reconnectAttempt + 1 });
    let socket;
    try {
      const proxy = this.proxyAgentForUrl(wsUrl);
      const headers = this.connectionHeaders();
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("relay connection headers are invalid");
      this.networkRoute = proxy?.agent ? "application-http-proxy" : "system-network-stack";
      socket = new this.WebSocketClass(wsUrl, {
        headers,
        maxPayload: this.maxPayload,
        ...(proxy?.agent ? { agent: proxy.agent } : {}),
      });
      this.logger.debug?.("remote relay network route selected", { route: this.networkRoute });
    } catch (error) {
      if (error?.code === "relay_proxy_configuration") {
        this.networkRoute = "invalid-application-proxy-configuration";
        this.failPermanently("relay_proxy_configuration");
        return;
      }
      this.lastTransportErrorClass = classifyRelayTransportError(error);
      this.lastCloseCode = 0;
      this.lastDisconnectedAt = this.now();
      this.logger.debug?.("remote relay connection could not be created", { error_class: this.lastTransportErrorClass });
      this.scheduleReconnect("connection_interrupted");
      return;
    }
    this.socket = socket;
    this.clearTimer("connectTimer", "clearTimeout");
    this.connectTimer = this.scheduler.setTimeout(() => {
      if (this.socket !== socket || this.closed || this.isSocketOpen(socket)) return;
      this.logger.debug?.("remote relay transport connection timed out", { timeout_ms: this.connectTimeoutMs });
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_connect_timeout");
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
      this.lastInboundAt = this.now();
      this.logger.debug?.("remote relay transport opened; awaiting device challenge");
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.handshakeTimer = this.scheduler.setTimeout(() => {
        if (this.socket !== socket || this.closed || this.ready) return;
        this.logger.debug?.("remote relay authentication acknowledgement timed out", { timeout_ms: this.handshakeTimeoutMs });
        this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_handshake_timeout");
        terminateSocket(socket);
      }, this.handshakeTimeoutMs);
      this.handshakeTimer?.unref?.();
    });

    socket.on("message", (data) => {
      if (this.socket !== socket || this.closed) return;
      this.lastInboundAt = this.now();
      this.heartbeat.observeInbound();
      // Bind results to the generation that received this message.
      const relayContext = {
        sessionId: this.activeSessionId,
        authenticated: this.authenticated === true,
        ready: this.ready === true,
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

    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      const wasReady = this.ready;
      const wasAuthenticated = this.authenticated;
      this.socket = null;
      this.authenticated = false;
      this.ready = false;
      this.readinessProbeDelivered = false;
      this.activeSessionId = 0;
      this.heartbeat.stop();
      this.clearTimer("connectTimer", "clearTimeout");
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.clearTimer("readinessTimer", "clearTimeout");
      const reasonText = sanitizeCloseReason(reason);
      const category = this.pendingCloseCategory || relayCloseCategory(code, reasonText);
      this.pendingCloseCategory = "";
      if (category !== "relay_transport_error") this.lastTransportErrorClass = "";
      const disconnectedAt = this.now();
      const connectedForMs = wasAuthenticated && this.connectedAt > 0 ? Math.max(0, disconnectedAt - this.connectedAt) : 0;
      this.lastDisconnectedAt = disconnectedAt;
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
      this.lastTransportErrorClass = classifyRelayTransportError(error);
      this.logger.debug?.("remote relay transport error", { error_class: this.lastTransportErrorClass });
      if (this.lastTransportErrorClass === "authentication_failed") {
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
    this.heartbeat.stop();
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
    const delay = this.reconnectDelay(this.reconnectAttempt++);
    this.lastReconnectDelayMs = delay;
    this.nextReconnectAt = this.now() + delay;
    this.scheduleOutageWarning();
    this.logger.debug?.("scheduling daemon reconnect", {
      delay_ms: delay,
      next_reconnect_at: new Date(this.nextReconnectAt).toISOString(),
      attempt: this.outageAttempts,
      close_category: this.lastCloseCategory,
      network_route: this.networkRoute,
      network_route_scope: this.networkRouteScope,
    });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = 0;
      this.connect();
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  sendOnSocket(socket, value) {
    if (!this.isSocketOpen(socket)) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch (error) {
      this.lastTransportErrorClass = classifyRelayTransportError(error);
      this.pendingCloseCategory = preferredRelayCloseCategory(this.pendingCloseCategory, "relay_transport_error");
      this.logger.debug?.("remote relay send failed", { error_class: this.lastTransportErrorClass });
      terminateSocket(socket);
      return false;
    }
  }

  recordOutage(category) {
    const now = this.now();
    if (this.outageStartedAt === 0) {
      this.outageStartedAt = now;
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
    this.logger.warn?.(`remote relay unavailable for ${formatDuration(outageMs)}; reconnecting automatically (${formatAttempts(this.outageAttempts)}; ${cause}).${action}`, outageFields);
    this.logger.debug?.("remote relay outage details", outageFields);
  }

  resetOutage() {
    this.clearTimer("outageWarnTimer", "clearTimeout");
    this.outageStartedAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.outageWarningCount = 0;
    this.lastOutageWarnAt = 0;
    this.nextReconnectAt = 0;
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

function normalizeWorkerUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("invalid Worker URL"); }
  if (url.protocol !== "https:") throw new Error("Worker URL must use HTTPS");
  if (url.username || url.password) throw new Error("Worker URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Worker URL must be an origin without a path, query, or fragment");
  return url.origin;
}

function sanitizeCloseReason(value) {
  let text;
  try { text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""); } catch { text = ""; }
  return text.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CLOSE_REASON_CHARS);
}

function terminateSocket(socket) {
  try {
    if (typeof socket?.terminate === "function") socket.terminate();
    else socket?.close?.();
  } catch { /* Callers classify the relay generation as failed independently of transport-close success. */ }
}

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<relay-url>";
  }
}

function classifyRelayTransportError(error) {
  const directStatus = Number(error?.statusCode ?? error?.response?.statusCode);
  if (directStatus === 401 || directStatus === 403) return "authentication_failed";
  const match = /^Unexpected server response: (\d{3})$/.exec(String(error?.message || ""));
  if (match && [401, 403].includes(Number(match[1]))) return "authentication_failed";
  return classifyOperationalError(error);
}

function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function formatAttempts(value) {
  const attempts = Math.max(1, Math.floor(Number(value) || 1));
  return `${attempts} reconnect attempt${attempts === 1 ? "" : "s"}`;
}

function formatDuration(milliseconds) {
  let seconds = Math.max(1, Math.round(Number(milliseconds) / 1000));
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts = [];
  for (const [label, size] of units) {
    if (seconds < size && parts.length === 0) continue;
    const amount = Math.floor(seconds / size);
    if (amount > 0) {
      parts.push(`${amount} ${label}${amount === 1 ? "" : "s"}`);
      seconds -= amount * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "1 second";
}
