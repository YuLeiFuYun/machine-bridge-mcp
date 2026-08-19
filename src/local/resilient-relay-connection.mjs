import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { RelayConnection } from "./relay-connection.mjs";
import { DaemonHttpRelayConnection } from "./daemon-http-relay-connection.mjs";

export class ResilientRelayConnection {
  constructor(options = {}) {
    this.logger = options.logger || {};
    this.onReady = typeof options.onReady === "function" ? options.onReady : () => {};
    this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : () => {};
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.fallbackDelayMs = positiveInteger(options.fallbackDelayMs, relayContract.httpFallbackActivationDelayMs);
    this.activeTransport = "";
    this.closed = true;
    this.startResolve = null;
    this.startPromise = null;
    this.fallbackTimer = null;
    this.fallbackRecoveredOutageMs = 0;
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
    this.startResolve?.(false);
    this.startResolve = null;
    this.startPromise = null;
  }

  status() {
    const websocket = this.websocket.status();
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
      };
    }
    return {
      ...websocket,
      transport: "websocket",
      https_fallback_active: false,
      https_fallback_warming: http.closed === false && http.ready !== true,
      https_fallback: http,
    };
  }

  currentSessionId() {
    return this.activeTransport === "https" ? this.http.currentSessionId() : this.websocket.currentSessionId();
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

  observeWelcome(message, relayContext = {}) {
    if (relayContext?.transport === "https") return false;
    return this.websocket.observeWelcome(message);
  }
  acknowledge(message, relayContext = {}) {
    if (relayContext?.transport === "https") return false;
    return this.websocket.acknowledge(message);
  }
  confirmReady(message, relayContext = {}) {
    return relayContext?.transport === "https" ? this.http.confirmReady(message) : this.websocket.confirmReady(message);
  }
  observeApplicationPong(relayContext = {}) {
    return relayContext?.transport === "https" ? false : this.websocket.observeApplicationPong(relayContext);
  }
  handleServerError(message, relayContext = {}) {
    if (relayContext?.transport === "https") return this.http.interrupt(message?.error);
    return this.websocket.handleServerError(message);
  }

  handleReady(transport, event) {
    if (this.closed) return;
    if (transport === "websocket") {
      this.activeTransport = "websocket";
      this.fallbackRecoveredOutageMs = 0;
      this.http.stop();
      this.clearFallbackTimer();
    } else {
      if (this.websocket.status().ready === true) { this.http.stop(); return; }
      this.fallbackRecoveredOutageMs = Math.max(0, Number(this.websocket.status().outage_duration_ms) || 0);
      this.activeTransport = "https";
    }
    this.startResolve?.(true);
    this.startResolve = null;
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
    this.clearFallbackTimer();
    if (this.http.status().ready !== true) this.http.stop();
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
