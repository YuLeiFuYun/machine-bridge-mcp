import WebSocket from "ws";
import { classifyOperationalError } from "./log.mjs";
import { proxyAgentForWebSocket } from "./network-proxy.mjs";
import {
  APPLICATION_PROXY_ROUTE_SCOPE, relayOutageFields, relayRecoveryFields, relayStatusSnapshot,
} from "./relay-diagnostics.mjs";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 75_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_OUTAGE_WARN_AFTER_MS = 10_000;
const DEFAULT_OUTAGE_WARN_REPEAT_MS = 60_000;
const DEFAULT_OUTAGE_WARN_MAX_REPEAT_MS = 15 * 60_000;
const MAX_CLOSE_REASON_CHARS = 128;
const MAX_PROTOCOL_ERROR_CODE_CHARS = 64;

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
    this.heartbeatTimer = null;
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
    this.clearTimer("heartbeatTimer", "clearInterval");
    this.clearTimer("connectTimer", "clearTimeout");
    this.clearTimer("handshakeTimer", "clearTimeout");
    this.clearTimer("readinessTimer", "clearTimeout");
    this.clearTimer("reconnectTimer", "clearTimeout");
    this.clearTimer("outageWarnTimer", "clearTimeout");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, "daemon shutdown"); } catch {}
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
    if (!this.ready && value?.type !== "relay_probe_result") return { ok: false, reason: "transport_unavailable" };
    if (!this.sendOnSocket(this.socket, value)) return { ok: false, reason: "send_failed" };
    if (value?.type === "relay_probe_result") this.readinessProbeDelivered = true;
    return { ok: true, reason: "sent" };
  }

  interrupt(category = "relay_transport_error") {
    if (this.closed || !this.socket) return false;
    this.pendingCloseCategory = String(category || "relay_transport_error");
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
    Promise.resolve(this.helloMessage(message)).then((hello) => {
      if (this.socket !== socket || this.closed || this.authenticated) return;
      this.sendOnSocket(socket, hello);
    }).catch((error) => {
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
    this.startHeartbeat();
    this.clearTimer("readinessTimer", "clearTimeout");
    this.readinessTimer = this.scheduler.setTimeout(() => {
      if (this.socket !== socket || this.closed || this.ready) return;
      this.logger.debug?.("remote relay end-to-end readiness probe timed out", { timeout_ms: this.readinessTimeoutMs });
      this.pendingCloseCategory = "relay_readiness_timeout";
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
      this.pendingCloseCategory = reconnectCategory;
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
      this.pendingCloseCategory = "relay_connect_timeout";
      terminateSocket(socket);
    }, this.connectTimeoutMs);
    this.connectTimer?.unref?.();

    socket.on("open", () => {
      this.clearTimer("connectTimer", "clearTimeout");
      if (this.socket !== socket || this.closed) {
        try { socket.close(1000, "stale daemon connection"); } catch {}
        return;
      }
      this.lastInboundAt = this.now();
      this.logger.debug?.("remote relay transport opened; awaiting device challenge");
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.handshakeTimer = this.scheduler.setTimeout(() => {
        if (this.socket !== socket || this.closed || this.ready) return;
        this.logger.debug?.("remote relay authentication acknowledgement timed out", { timeout_ms: this.handshakeTimeoutMs });
        this.pendingCloseCategory = "relay_handshake_timeout";
        terminateSocket(socket);
      }, this.handshakeTimeoutMs);
      this.handshakeTimer?.unref?.();
    });

    socket.on("message", (data) => {
      if (this.socket !== socket || this.closed) return;
      this.lastInboundAt = this.now();
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
      this.clearTimer("connectTimer", "clearTimeout");
      this.clearTimer("heartbeatTimer", "clearInterval");
      this.clearTimer("handshakeTimer", "clearTimeout");
      this.clearTimer("readinessTimer", "clearTimeout");
      const reasonText = sanitizeCloseReason(reason);
      const category = this.pendingCloseCategory || relayCloseCategory(code, reasonText);
      this.pendingCloseCategory = "";
      if (category !== "relay_transport_error") this.lastTransportErrorClass = "";
      const disconnectedAt = this.now();
      const connectedForMs = wasAuthenticated && this.connectedAt > 0 ? Math.max(0, disconnectedAt - this.connectedAt) : 0;
      this.lastDisconnectedAt = disconnectedAt;
      this.lastReadyDurationMs = wasReady && this.lastReadyAt > 0 ? Math.max(0, disconnectedAt - this.lastReadyAt) : 0;
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
        queueMicrotask(() => {
          try { this.onSuperseded(); } catch (error) {
            this.logger.error?.("daemon superseded callback failed", { error_class: classifyOperationalError(error) });
          }
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
      this.pendingCloseCategory = "relay_transport_error";
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
    this.socket = null;
    this.clearTimer("connectTimer", "clearTimeout");
    this.clearTimer("heartbeatTimer", "clearInterval");
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
    queueMicrotask(() => {
      try { this.onFatal(error); } catch (callbackError) {
        this.logger.error?.("relay fatal callback failed", { error_class: classifyOperationalError(callbackError) });
      }
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
      this.pendingCloseCategory = "relay_transport_error";
      this.logger.debug?.("remote relay send failed", { error_class: this.lastTransportErrorClass });
      terminateSocket(socket);
      return false;
    }
  }

  startHeartbeat() {
    this.clearTimer("heartbeatTimer", "clearInterval");
    this.heartbeatTimer = this.scheduler.setInterval(() => {
      const socket = this.socket;
      if (this.closed || !this.authenticated || !this.isSocketOpen(socket)) return;
      const silentForMs = Math.max(0, this.now() - this.lastInboundAt);
      if (silentForMs >= this.heartbeatTimeoutMs) {
        this.logger.debug?.("remote relay heartbeat timed out", { silent_for_ms: silentForMs });
        this.pendingCloseCategory = "relay_heartbeat_timeout";
        terminateSocket(socket);
        return;
      }
      this.sendOnSocket(socket, { type: "heartbeat", ts: this.now() });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer?.unref?.();
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
    const action = outageMs >= 5 * 60_000
      ? " If this persists, check internet access and the deployed Worker."
      : "";
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

export function relayServerErrorReconnectCategory(errorCode, state = {}) {
  const code = sanitizeProtocolErrorCode(errorCode);
  const authenticated = state?.authenticated === true;
  const ready = state?.ready === true;
  if (code === "daemon_hello_timeout" && !authenticated) return "relay_handshake_timeout";
  if (code === "daemon_ready_timeout" && authenticated && !ready) return "relay_readiness_timeout";
  if (code === "daemon_transport_error") return "relay_transport_error";
  if (code === "daemon_liveness_timeout") return "relay_heartbeat_timeout";
  return "";
}

export function relayCloseCategory(code, reason = "") {
  const numeric = Number(code);
  const reasonText = String(reason || "");
  if (isSupersededClose(numeric, reasonText)) return "superseded";
  if (numeric === 1008 && reasonText === "daemon hello timeout") return "relay_handshake_timeout";
  if (numeric === 1008 && reasonText === "daemon ready timeout") return "relay_readiness_timeout";
  if ([1008, 1012].includes(numeric) && ["daemon pong failed", "daemon send failed"].includes(reasonText)) return "relay_transport_error";
  if ([1008, 1012].includes(numeric) && reasonText === "daemon liveness timeout") return "relay_heartbeat_timeout";
  if (numeric === 1008 && ["stale daemon candidate", "expired daemon candidate"].includes(reasonText)) return "relay_restarting_or_unavailable";
  if (numeric === 1008 && ["daemon hello required", "missing daemon attachment", "invalid daemon candidate timestamp"].includes(reasonText)) return "relay_protocol_error";
  if (numeric === 1000) return "normal_close";
  if (numeric === 1001 || numeric === 1012 || numeric === 1013) return "relay_restarting_or_unavailable";
  if (numeric === 1006) return "connection_interrupted";
  if (numeric === 1002) return "relay_protocol_error";
  if (numeric === 1007) return "invalid_transport_payload";
  if (numeric === 1008) return "relay_policy_rejected";
  if (numeric === 1009) return "message_too_large";
  if (numeric === 1011) return "relay_internal_error";
  return "unexpected_close";
}

function relayFatalMessage(category) {
  if (category === "relay_protocol_mismatch") {
    return "remote relay identity or version does not match this daemon; upgrade and redeploy both components";
  }
  if (category === "relay_protocol_error") {
    return "remote relay protocol error; upgrade and redeploy both components, then restart the daemon";
  }
  if (category === "relay_proxy_configuration") {
    return "remote relay proxy configuration is invalid; check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY";
  }
  return "remote relay rejected the daemon connection; verify credentials or redeploy the Worker";
}

function relayCloseUserCause(category) {
  const causes = {
    connection_interrupted: "connection interrupted",
    relay_restarting_or_unavailable: "relay restarting or temporarily unavailable",
    relay_policy_rejected: "relay rejected the connection",
    relay_internal_error: "relay internal error",
    relay_protocol_mismatch: "relay identity or version mismatch",
    relay_authentication_failed: "relay authentication failed",
    relay_connect_timeout: "relay connection attempt timed out",
    relay_handshake_timeout: "relay authentication acknowledgement timed out",
    relay_readiness_timeout: "end-to-end relay readiness verification timed out",
    relay_heartbeat_timeout: "relay stopped responding",
    relay_transport_error: "relay transport error",
    relay_protocol_error: "relay protocol error",
    relay_proxy_configuration: "relay proxy configuration invalid",
    invalid_transport_payload: "invalid transport payload",
    message_too_large: "message exceeded the relay limit",
    normal_close: "connection closed",
    unexpected_close: "unexpected connection close",
    superseded: "connection superseded",
  };
  return causes[String(category || "")] || "connection interrupted";
}

export function welcomeMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_welcome";
  if (message.type !== "welcome") return "unexpected_welcome_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_welcome";
  return "";
}

export function acknowledgementMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_acknowledgement";
  if (message.type !== "hello_ack") return "unexpected_acknowledgement_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_acknowledgement";
  return "";
}

export function readinessMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_readiness_acknowledgement";
  if (message.type !== "ready_ack") return "unexpected_readiness_acknowledgement_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_readiness_acknowledgement";
  return "";
}

export function isRelayReadyContext(relayContext = {}, relay = null) {
  if (relayContext?.ready === true) return true;
  if (relayContext?.ready === false) return false;
  return Number(relayContext?.sessionId) > 0 && relay?.status?.()?.ready === true;
}

export function isSupersededClose(code, reason) {
  return Number(code) === 1012 && String(reason || "") === "replaced by verified daemon";
}

export function reconnectDelay(attempt, random = Math.random) {
  const safeAttempt = Math.max(0, Number.isFinite(Number(attempt)) ? Number(attempt) : 0);
  const base = Math.min(1000 * (2 ** Math.min(safeAttempt, 4)), 15_000);
  return base + Math.floor(random() * 500);
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
  } catch {}
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

function sanitizeProtocolErrorCode(value) {
  const code = String(value || "unknown_error").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_PROTOCOL_ERROR_CODE_CHARS);
  return code || "unknown_error";
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
