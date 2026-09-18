import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { RelayConnection } from "./relay-connection.mjs";
import { DaemonHttpRelayConnection } from "./daemon-http-relay-connection.mjs";
import { relayServerErrorReconnectCategory, sanitizeProtocolErrorCode } from "./relay-connection-classification.mjs";

export class ResilientRelayConnection {
  constructor(options = {}) {
    this.logger = options.logger || {};
    this.onReady = typeof options.onReady === "function" ? options.onReady : () => {};
    this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : () => {};
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.fallbackDelayMs = positiveInteger(options.fallbackDelayMs, relayContract.httpFallbackActivationDelayMs);
    this.standbyDelayMs = positiveInteger(options.standbyDelayMs, relayContract.httpFallbackStandbyRetryIntervalMs);
    this.activeTransport = "";
    this.closed = true;
    this.startResolve = null;
    this.startPromise = null;
    this.fallbackTimer = null;
    this.fallbackRecoveredOutageMs = 0;
    this.lastFallbackTakeoverMs = 0;
    this.lastFallbackTakeoverOutageNumber = 0;
    this.fallbackTakeoversByOutage = new Map();
    const WebSocketRelayClass = options.WebSocketRelayClass || RelayConnection;
    const HttpRelayClass = options.HttpRelayClass || DaemonHttpRelayConnection;
    this.websocket = new WebSocketRelayClass({
      ...options.websocket,
      onReady: (event) => this.handleReady("websocket", event),
      onDisconnect: () => this.handleDisconnect("websocket"),
      onDegraded: (event) => this.handleDegraded(event),
      onRecovered: (event) => this.handleRecovered(event),
    });
    this.http = new HttpRelayClass({
      ...options.http,
      onReady: (event) => this.handleReady("https", event),
      onDisconnect: () => this.handleDisconnect("https"),
    });
  }

  start() {
    if (!this.closed && this.startPromise) return this.startPromise;
    this.closed = false;
    this.startPromise = new Promise((resolve) => { this.startResolve = resolve; });
    void this.websocket.start().catch(() => {
      /* RelayConnection owns reconnect/backoff and reports readiness through callbacks; startup rejection is not terminal here. */
    });
    this.armFallback(this.fallbackDelayMs);
    return this.startPromise;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.clearFallbackTimer();
    this.websocket.stop();
    this.http.stop();
    this.activeTransport = "";
    this.fallbackRecoveredOutageMs = 0;
    this.lastFallbackTakeoverMs = 0;
    this.lastFallbackTakeoverOutageNumber = 0;
    this.fallbackTakeoversByOutage.clear();
    this.startResolve?.(false);
    this.startResolve = null;
    this.startPromise = null;
  }

  status() {
    const websocket = this.projectWebSocketStatus(this.websocket.status());
    const http = this.http.status();
    if (this.activeTransport === "https" && http.ready) {
      return {
        ...websocket,
        authenticated: true,
        ready: true,
        closed: this.closed,
        transport: "https",
        network_route: http.network_route,
        last_transport_error_class: http.last_transport_error_class,
        last_transport_error_reason: http.last_transport_error_reason,
        last_transport_error_ready: http.last_transport_error_ready === true,
        last_transport_error_authenticated: http.last_transport_error_authenticated === true,
        outage_active: false,
        outage_duration_ms: this.fallbackRecoveredOutageMs,
        https_fallback_active: true,
        https_fallback: http,
        websocket_ready: websocket.ready === true,
        websocket_outage_active: websocket.outage_active === true,
        websocket_outage_duration_ms: Number(websocket.outage_duration_ms) || 0,
        websocket_reconnect_attempt: Number(websocket.reconnect_attempt) || 0,
        https_fallback_warming: false,
        https_fallback_standby: false,
        https_fallback_last_takeover_ms: this.lastFallbackTakeoverMs,
        https_fallback_last_takeover_outage_number: this.lastFallbackTakeoverOutageNumber,
      };
    }
    return {
      ...websocket,
      transport: "websocket",
      https_fallback_active: false,
      https_fallback_warming: http.closed === false && http.ready !== true && http.standby !== true,
      https_fallback_standby: http.standby === true,
      https_fallback: http,
      https_fallback_last_takeover_ms: this.lastFallbackTakeoverMs,
      https_fallback_last_takeover_outage_number: this.lastFallbackTakeoverOutageNumber,
    };
  }

  currentSessionId() {
    return this.activeTransport === "https" ? this.http.currentSessionId() : this.websocket.currentSessionId();
  }

  isCurrentSession(relayContext = {}) {
    const sessionId = Number(relayContext?.sessionId) || 0;
    if (!sessionId) return false;
    if (relayContext?.transport === "https") return sessionId === this.http.currentSessionId();
    if (relayContext?.transport === "websocket") return sessionId === this.websocket.currentSessionId();
    return false;
  }

  send(value) {
    if (this.activeTransport === "websocket") return this.websocket.send(value);
    if (this.activeTransport === "https") return this.http.send(value);
    return false;
  }

  sendForSession(value, expectedSessionId) {
    const sessionId = Number(expectedSessionId) || 0;
    if (sessionId && sessionId === this.http.currentSessionId()) return this.http.sendForSession(value, sessionId);
    return this.websocket.sendForSession(value, sessionId);
  }

  interrupt(category) {
    if (this.activeTransport === "https") return this.http.interrupt(category);
    return this.websocket.interrupt(category);
  }

  interruptForContext(category, relayContext = {}) {
    if (!this.isCurrentSession(relayContext)) return false;
    return relayContext?.transport === "https"
      ? this.http.interrupt(category)
      : this.websocket.interrupt(category);
  }

  refreshAuthentication() {
    const websocketInterrupted = this.websocket.interrupt("relay_session_rotated");
    const httpInterrupted = this.http.interrupt("relay_session_rotated");
    return websocketInterrupted || httpInterrupted;
  }

  observeWelcome(message, relayContext = {}) {
    if (relayContext?.transport === "https") return false;
    return this.websocket.observeWelcome(message);
  }
  acknowledge(message, relayContext = {}) {
    if (relayContext?.transport === "https") return false;
    return this.websocket.acknowledge(message);
  }
  confirmReady(message, relayContext = {}) {
    if (!this.isCurrentSession(relayContext)) return false;
    return relayContext?.transport === "https" ? this.http.confirmReady(message) : this.websocket.confirmReady(message);
  }
  observeApplicationPong(relayContext = {}) {
    return relayContext?.transport === "https" ? false : this.websocket.observeApplicationPong(relayContext);
  }
  handleServerError(message, relayContext = {}) {
    const sessionId = Number(relayContext?.sessionId) || 0;
    if (sessionId && !this.isCurrentSession(relayContext)) {
      this.logger.debug?.("discarded relay error from an ended transport generation", {
        source_transport: relayTransport(relayContext), connection_generation: "stale",
        handshake_stage: relayHandshakeStage(relayContext),
      });
      return false;
    }
    const errorCode = sanitizeProtocolErrorCode(message?.error);
    const reconnectCategory = relayServerErrorReconnectCategory(errorCode, {
      authenticated: relayContext?.authenticated === true, ready: relayContext?.ready === true,
    });
    const sourceTransport = relayTransport(relayContext);
    const diagnostics = {
      error_code: errorCode, source_transport: sourceTransport,
      connection_generation: sessionId ? "current" : "unbound",
      handshake_stage: relayHandshakeStage(relayContext),
    };
    if (sourceTransport === "https") {
      if (!reconnectCategory) this.logger.warn?.(
        "remote HTTPS relay reported a protocol error; restarting the fallback transport",
        { ...diagnostics, disposition: "retry_transport" },
      );
      return this.http.interrupt(errorCode);
    }
    return this.websocket.handleServerError(reconnectCategory
      ? message : { ...message, error: errorCode, diagnostics: { ...diagnostics, disposition: "fatal_runtime" } });
  }

  handleReady(transport, event) {
    if (this.closed) return;
    const bridgeWasReady = this.activeTransport === "websocket" || this.activeTransport === "https";
    if (transport === "websocket") {
      this.activeTransport = "websocket";
      this.fallbackRecoveredOutageMs = 0;
      this.http.stop();
      this.clearFallbackTimer();
      this.armFallback(0, "", true);
    } else {
      const websocket = this.websocket.status();
      if (websocket.ready === true) {
        this.http.stop();
        this.armFallback(this.standbyDelayMs, "", true);
        return;
      }
      this.fallbackRecoveredOutageMs = Math.max(0, Number(websocket.outage_duration_ms) || 0);
      this.lastFallbackTakeoverMs = boundedFallbackTakeoverMs(this.fallbackRecoveredOutageMs);
      this.recordFallbackTakeover(websocket);
      this.activeTransport = "https";
    }
    this.startResolve?.(true);
    this.startResolve = null;
    if (bridgeWasReady) return;
    try { this.onReady({ ...event, transport }); }
    catch { /* Transport readiness is already committed; observer failure must not tear down the usable channel. */ }
  }

  handleDisconnect(transport) {
    if (this.closed) return;
    if (transport === "websocket") {
      const wasPrimary = this.activeTransport === "websocket";
      const takeoverConnectionId = wasPrimary ? String(this.websocket.takeoverConnectionId?.() || "") : "";
      this.armFallback(0, takeoverConnectionId);
      if (!wasPrimary) return;
    } else if (this.activeTransport !== "https") return;
    this.activeTransport = "";
    try { this.onDisconnect({ transport }); }
    catch { /* The transport is already unavailable; observer failure must not block failover/reconnect. */ }
  }

  handleDegraded() {
    if (this.closed || this.activeTransport !== "websocket") return;
    this.armFallback(0, "", true);
  }

  handleRecovered() {
    if (this.closed || this.activeTransport !== "websocket") return;
    if (this.http.status().closed === true) this.armFallback(0, "", true);
  }

  recordFallbackTakeover(websocket = {}) {
    const outageNumber = relayOutageNumber(websocket.outage_count);
    if (websocket.outage_active !== true || outageNumber === 0) return;
    this.lastFallbackTakeoverOutageNumber = outageNumber;
    this.fallbackTakeoversByOutage.set(outageNumber, this.lastFallbackTakeoverMs);
    this.pruneFallbackTakeovers(websocket);
  }

  projectWebSocketStatus(websocket = {}) {
    this.pruneFallbackTakeovers(websocket);
    const recentOutages = Array.isArray(websocket.recent_outages) ? websocket.recent_outages : [];
    return {
      ...websocket,
      recent_outages: recentOutages.map((entry) => {
        const outageNumber = relayOutageNumber(entry?.outage_number);
        const hasTakeover = outageNumber > 0 && this.fallbackTakeoversByOutage.has(outageNumber);
        return {
          ...entry,
          https_fallback_taken_over: hasTakeover,
          https_fallback_takeover_ms: hasTakeover ? this.fallbackTakeoversByOutage.get(outageNumber) : 0,
        };
      }),
    };
  }

  pruneFallbackTakeovers(websocket = {}) {
    const retained = new Set();
    const activeOutageNumber = websocket.outage_active === true ? relayOutageNumber(websocket.outage_count) : 0;
    if (activeOutageNumber > 0) retained.add(activeOutageNumber);
    if (Array.isArray(websocket.recent_outages)) {
      for (const entry of websocket.recent_outages) {
        const outageNumber = relayOutageNumber(entry?.outage_number);
        if (outageNumber > 0) retained.add(outageNumber);
      }
    }
    for (const outageNumber of this.fallbackTakeoversByOutage.keys()) {
      if (!retained.has(outageNumber)) this.fallbackTakeoversByOutage.delete(outageNumber);
    }
  }

  armFallback(delay, takeoverWebSocketConnectionId = "", allowReadyWebSocket = false) {
    if (this.closed) return;
    const takeoverWebSocket = /^connection_[A-Za-z0-9_-]{43}$/.test(String(takeoverWebSocketConnectionId || ""));
    if (this.http.status().closed === false) {
      if (takeoverWebSocket) this.http.start({ takeoverWebSocket: true, takeoverWebSocketConnectionId });
      return;
    }
    if (this.fallbackTimer) return;
    this.fallbackTimer = this.scheduler.setTimeout(() => {
      this.fallbackTimer = null;
      if (this.closed || (!allowReadyWebSocket && this.websocket.status().ready === true)) return;
      this.http.start({ takeoverWebSocket, ...(takeoverWebSocket ? { takeoverWebSocketConnectionId } : {}) });
    }, Math.max(0, Number(delay) || 0));
    this.fallbackTimer?.unref?.();
  }

  clearFallbackTimer() {
    if (!this.fallbackTimer) return;
    this.scheduler.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}

function relayOutageNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000_000 ? number : 0;
}

function boundedFallbackTakeoverMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(10 * 60_000, Math.round(number));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function relayTransport(relayContext = {}) {
  const transport = String(relayContext?.transport || "");
  return transport === "websocket" || transport === "https" ? transport : "unknown";
}

function relayHandshakeStage(relayContext = {}) {
  if (relayContext?.ready === true) return "post_ready";
  if (relayContext?.authenticated === true) return "authenticated_pre_ready";
  return "pre_authentication";
}
