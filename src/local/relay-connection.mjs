import WebSocket from "ws";
import { classifyOperationalError } from "./log.mjs";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 75_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_OUTAGE_WARN_AFTER_MS = 10_000;
const DEFAULT_OUTAGE_WARN_REPEAT_MS = 60_000;
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
    if (typeof options.secret !== "string" || options.secret.length < 16) throw new Error("daemon secret is missing or too short");
    this.secret = options.secret;
    this.logger = options.logger || console;
    this.helloMessage = typeof options.helloMessage === "function" ? options.helloMessage : () => ({ type: "hello" });
    this.expectedServer = String(options.expectedServer || "");
    this.expectedVersion = String(options.expectedVersion || "");
    this.onMessage = typeof options.onMessage === "function" ? options.onMessage : () => {};
    this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : () => {};
    this.onSuperseded = typeof options.onSuperseded === "function" ? options.onSuperseded : () => {};
    this.onFatal = typeof options.onFatal === "function" ? options.onFatal : () => {};
    this.WebSocketClass = options.WebSocketClass || WebSocket;
    this.scheduler = options.scheduler || DEFAULT_SCHEDULER;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.reconnectDelay = typeof options.reconnectDelay === "function" ? options.reconnectDelay : reconnectDelay;
    this.maxPayload = boundedPositiveInteger(options.maxPayload, 8 * 1024 * 1024);
    this.heartbeatIntervalMs = boundedPositiveInteger(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimeoutMs = boundedPositiveInteger(options.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS);
    this.handshakeTimeoutMs = boundedPositiveInteger(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.outageWarnAfterMs = boundedPositiveInteger(options.outageWarnAfterMs, DEFAULT_OUTAGE_WARN_AFTER_MS);
    this.outageWarnRepeatMs = boundedPositiveInteger(options.outageWarnRepeatMs, DEFAULT_OUTAGE_WARN_REPEAT_MS);

    this.closed = true;
    this.socket = null;
    this.ready = false;
    this.hasConnected = false;
    this.connectedAt = 0;
    this.lastInboundAt = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.handshakeTimer = null;
    this.outageWarnTimer = null;
    this.outageStartedAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.lastOutageWarnAt = 0;
    this.lastCloseCategory = "connection_interrupted";
    this.lastTransportErrorClass = "";
    this.pendingCloseCategory = "";
    this.connectedOnce = null;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
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
    this.ready = false;
    this.clearTimer("heartbeatTimer", "clearInterval");
    this.clearTimer("handshakeTimer", "clearTimeout");
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

  observeWelcome(message = {}) {
    const socket = this.socket;
    if (this.closed || this.ready || !this.isSocketOpen(socket)) return false;
    const mismatch = welcomeMismatch(message, this.expectedServer, this.expectedVersion);
    if (mismatch) {
      this.logger.debug?.("remote relay welcome rejected", { reason: mismatch });
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    this.logger.debug?.("remote relay welcome received");
    return true;
  }

  acknowledge(message = {}) {
    const socket = this.socket;
    if (this.closed || this.ready || !this.isSocketOpen(socket)) return false;
    const mismatch = acknowledgementMismatch(message, this.expectedServer, this.expectedVersion);
    if (mismatch) {
      this.logger.debug?.("remote relay acknowledgement rejected", { reason: mismatch });
      this.failPermanently("relay_protocol_mismatch");
      return false;
    }
    this.ready = true;
    this.clearTimer("handshakeTimer", "clearTimeout");
    this.connectedAt = this.now();
    this.lastInboundAt = this.connectedAt;
    this.reconnectAttempt = 0;
    this.startHeartbeat();

    if (!this.hasConnected) {
      this.logger.info?.("remote relay connected");
    } else if (this.outageStartedAt > 0) {
      const outageMs = Math.max(0, this.connectedAt - this.outageStartedAt);
      if (this.outageNoticeEmitted) {
        this.logger.info?.("remote relay connection restored", {
          outage_seconds: roundSeconds(outageMs),
          attempts: this.outageAttempts,
        });
      } else {
        this.logger.debug?.("remote relay connection recovered after a brief interruption", {
          outage_ms: outageMs,
          attempts: this.outageAttempts,
        });
      }
    }

    this.hasConnected = true;
    this.resetOutage();
    if (this.connectedOnceResolve) {
      this.connectedOnceResolve(true);
      this.connectedOnceResolve = null;
      this.connectedOnceReject = null;
    }
    return true;
  }

  connect() {
    if (this.closed || this.socket) return;
    const wsUrl = `${this.workerUrl.replace(/^http/i, "ws")}/daemon/ws`;
    this.logger.debug?.("connecting to remote relay", { endpoint: redactUrl(wsUrl), attempt: this.reconnectAttempt + 1 });
    let socket;
    try {
      socket = new this.WebSocketClass(wsUrl, {
        headers: { "X-Bridge-Token": this.secret },
        maxPayload: this.maxPayload,
      });
    } catch (error) {
      this.lastTransportErrorClass = classifyOperationalError(error);
      this.logger.debug?.("remote relay connection could not be created", { error_class: this.lastTransportErrorClass });
      this.scheduleReconnect("connection_interrupted");
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket || this.closed) {
        try { socket.close(1000, "stale daemon connection"); } catch {}
        return;
      }
      this.lastInboundAt = this.now();
      this.logger.debug?.("remote relay transport opened; awaiting authentication acknowledgement");
      if (!this.sendOnSocket(socket, this.helloMessage())) return;
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
      try {
        const outcome = this.onMessage(data);
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
      this.socket = null;
      this.ready = false;
      this.clearTimer("heartbeatTimer", "clearInterval");
      this.clearTimer("handshakeTimer", "clearTimeout");
      const reasonText = sanitizeCloseReason(reason);
      const category = this.pendingCloseCategory || relayCloseCategory(code, reasonText);
      this.pendingCloseCategory = "";
      const connectedForMs = wasReady && this.connectedAt > 0 ? Math.max(0, this.now() - this.connectedAt) : 0;
      this.logger.debug?.("remote relay transport closed", {
        close_code: Number(code) || 0,
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
        this.logger.warn?.("daemon connection was replaced by a newer authenticated instance");
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
      this.lastTransportErrorClass = classifyOperationalError(error);
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
    this.ready = false;
    this.socket = null;
    this.clearTimer("heartbeatTimer", "clearInterval");
    this.clearTimer("handshakeTimer", "clearTimeout");
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
    this.logger.error?.(message, { cause: relayCloseUserCause(category) });
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
    this.scheduleOutageWarning();
    this.maybeRepeatOutageWarning();
    this.logger.debug?.("scheduling daemon reconnect", { delay_ms: delay, attempt: this.outageAttempts });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
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
      this.lastTransportErrorClass = classifyOperationalError(error);
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
      if (this.closed || !this.ready || !this.isSocketOpen(socket)) return;
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
      this.outageAttempts = 0;
      this.outageNoticeEmitted = false;
      this.lastOutageWarnAt = 0;
    }
    this.outageAttempts += 1;
    this.lastCloseCategory = category;
  }

  scheduleOutageWarning() {
    if (this.outageNoticeEmitted || this.outageWarnTimer || this.outageStartedAt === 0) return;
    const elapsed = Math.max(0, this.now() - this.outageStartedAt);
    const delay = Math.max(0, this.outageWarnAfterMs - elapsed);
    this.outageWarnTimer = this.scheduler.setTimeout(() => {
      this.outageWarnTimer = null;
      if (this.closed || this.ready || this.outageStartedAt === 0) return;
      this.emitOutageWarning();
    }, delay);
    this.outageWarnTimer?.unref?.();
  }

  maybeRepeatOutageWarning() {
    if (!this.outageNoticeEmitted || this.lastOutageWarnAt === 0) return;
    if (this.now() - this.lastOutageWarnAt < this.outageWarnRepeatMs) return;
    this.emitOutageWarning();
  }

  emitOutageWarning() {
    const outageMs = Math.max(0, this.now() - this.outageStartedAt);
    this.outageNoticeEmitted = true;
    this.lastOutageWarnAt = this.now();
    this.logger.warn?.(relayOutageWarningMessage(), {
      outage_seconds: roundSeconds(outageMs),
      attempts: this.outageAttempts,
      cause: relayCloseUserCause(this.lastCloseCategory),
      ...(this.lastTransportErrorClass ? { error_class: this.lastTransportErrorClass } : {}),
    });
  }

  resetOutage() {
    this.clearTimer("outageWarnTimer", "clearTimeout");
    this.outageStartedAt = 0;
    this.outageAttempts = 0;
    this.outageNoticeEmitted = false;
    this.lastOutageWarnAt = 0;
    this.lastCloseCategory = "connection_interrupted";
    this.lastTransportErrorClass = "";
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

export function relayCloseCategory(code, reason = "") {
  const numeric = Number(code);
  if (isSupersededClose(numeric, reason)) return "superseded";
  if (numeric === 1000) return "normal_close";
  if (numeric === 1001 || numeric === 1012 || numeric === 1013) return "relay_restarting_or_unavailable";
  if (numeric === 1006) return "connection_interrupted";
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
  return "remote relay rejected the daemon connection; verify credentials or redeploy the Worker";
}

function relayOutageWarningMessage() {
  return "remote relay is unavailable; automatic reconnection is still in progress";
}

function relayCloseUserCause(category) {
  const causes = {
    connection_interrupted: "connection interrupted",
    relay_restarting_or_unavailable: "relay restarting or temporarily unavailable",
    relay_policy_rejected: "relay rejected the connection",
    relay_internal_error: "relay internal error",
    relay_protocol_mismatch: "relay identity or version mismatch",
    relay_authentication_failed: "relay authentication failed",
    relay_handshake_timeout: "relay authentication acknowledgement timed out",
    relay_heartbeat_timeout: "relay stopped responding",
    relay_transport_error: "relay transport error",
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

export function isSupersededClose(code, reason) {
  return Number(code) === 1012 && String(reason || "") === "replaced by authenticated daemon";
}

export function reconnectDelay(attempt, random = Math.random) {
  const safeAttempt = Math.max(0, Number.isFinite(Number(attempt)) ? Number(attempt) : 0);
  const base = Math.min(3000 * (2 ** Math.min(safeAttempt, 5)), 60_000);
  return base + Math.floor(random() * 1000);
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

function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function roundSeconds(milliseconds) {
  return Math.max(1, Math.round(milliseconds / 1000));
}
