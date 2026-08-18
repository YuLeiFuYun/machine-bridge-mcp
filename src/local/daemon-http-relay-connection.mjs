import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { readinessMismatch } from "./relay-connection-classification.mjs";
import { classifyOperationalError } from "./log.mjs";
import { createDaemonHttpRelayHeaders } from "./daemon-http-relay-auth.mjs";
import { postDaemonHttpRelay } from "./daemon-http-relay-request.mjs";
import { RelayInboundSequence, RelayOutboundSequence } from "./daemon-http-relay-sequence.mjs";

const HTTP_SESSION_ID = /^relay_http_[A-Za-z0-9_-]{43}$/;
const ACTIVATION_TOKEN = /^activate_[A-Za-z0-9_-]{43}$/;

export class DaemonHttpRelayConnection {
  constructor(options = {}) {
    this.workerUrl = String(options.workerUrl || "").replace(/\/$/, "");
    this.endpoint = `${this.workerUrl}/daemon/http`;
    this.deviceIdentity = options.deviceIdentity;
    this.expectedServer = String(options.expectedServer || "");
    this.expectedVersion = String(options.expectedVersion || "");
    this.instanceId = String(options.instanceId || "");
    this.descriptor = typeof options.descriptor === "function" ? options.descriptor : () => ({});
    this.ownedCallIds = typeof options.ownedCallIds === "function" ? options.ownedCallIds : () => [];
    this.onMessage = typeof options.onMessage === "function" ? options.onMessage : () => {};
    this.onReady = typeof options.onReady === "function" ? options.onReady : () => {};
    this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : () => {};
    this.logger = options.logger || {};
    this.now = typeof options.now === "function" ? options.now : () => performance.now();
    this.wallNow = typeof options.wallNow === "function" ? options.wallNow : Date.now;
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.postRequest = typeof options.postRequest === "function" ? options.postRequest : postDaemonHttpRelay;
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, relayContract.httpFallbackPollIntervalMs);
    this.minimumRequestIntervalMs = positiveInteger(options.minimumRequestIntervalMs, relayContract.httpFallbackMinimumRequestIntervalMs);
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, relayContract.httpFallbackRequestTimeoutMs);
    this.livenessTimeoutMs = positiveInteger(options.livenessTimeoutMs, relayContract.httpFallbackLivenessTimeoutMs);
    this.sessionIdBase = positiveInteger(options.sessionIdBase, 1_000_000_000);
    this.outbound = new RelayOutboundSequence();
    this.inbound = new RelayInboundSequence();
    this.closed = true;
    this.ready = false;
    this.localReady = false;
    this.authenticated = false;
    this.activeSessionId = 0;
    this.sessionGeneration = 0;
    this.transportSessionId = "";
    this.activationToken = "";
    this.pollTimer = null;
    this.inFlight = null;
    this.lastSuccessAt = 0;
    this.lastSuccessWallAt = 0;
    this.lastErrorClass = "";
    this.networkRoute = "system-network-stack";
    this.consecutiveFailures = 0;
    this.lastRequestStartedAt = Number.NEGATIVE_INFINITY;
    this.takeoverWebSocket = false;
  }

  start(options = {}) {
    if (options.takeoverWebSocket === true) this.takeoverWebSocket = true;
    if (!this.closed) { this.schedulePoll(0); return; }
    this.closed = false;
    this.resetSession(false);
    this.schedulePoll(0);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.clearPollTimer();
    this.inFlight?.abort?.("daemon HTTP relay stopped");
    this.inFlight = null;
    this.ready = false;
    this.localReady = false;
    this.authenticated = false;
    this.activeSessionId = 0;
    this.outbound.reset();
    this.inbound.reset();
    this.takeoverWebSocket = false;
  }

  status() {
    return {
      transport: "https",
      authenticated: this.authenticated,
      ready: this.ready,
      closed: this.closed,
      network_route: this.networkRoute,
      application_heartbeat_interval_ms: this.pollIntervalMs,
      application_heartbeat_timeout_ms: this.livenessTimeoutMs,
      last_ready_at: this.lastSuccessWallAt ? new Date(this.lastSuccessWallAt).toISOString() : null,
      last_transport_error_class: this.lastErrorClass || null,
      http_poll_failures: this.consecutiveFailures,
    };
  }

  currentSessionId() { return this.authenticated ? this.activeSessionId : 0; }

  send(value) {
    if (!this.ready || this.closed) return false;
    try { this.outbound.enqueue(value); this.schedulePoll(0); return true; }
    catch (error) {
      this.lastErrorClass = classifyOperationalError(error);
      return false;
    }
  }

  sendForSession(value, expectedSessionId) {
    const sessionId = Number(expectedSessionId) || 0;
    if (!sessionId || sessionId !== this.activeSessionId) return { ok: false, reason: "session_ended" };
    if (this.closed || !this.authenticated) return { ok: false, reason: "transport_unavailable" };
    const preReadyControl = ["resume_calls_ack", "authority_revoke_ack"].includes(String(value?.type || ""));
    if (!this.ready && !preReadyControl) return { ok: false, reason: "transport_unavailable" };
    try { this.outbound.enqueue(value); this.schedulePoll(0); return { ok: true, reason: "sent" }; }
    catch { return { ok: false, reason: "send_failed" }; }
  }

  confirmReady(message = {}) {
    if (this.closed || !this.authenticated || this.localReady) return false;
    const mismatch = readinessMismatch(message, this.expectedServer, this.expectedVersion);
    if (mismatch) { this.resetSession(true); return false; }
    this.outbound.enqueue({ type: "https_ready" });
    this.localReady = true;
    return true;
  }

  interrupt() {
    if (this.closed) return false;
    this.inFlight?.abort?.("daemon HTTP relay interrupted");
    this.resetSession(true);
    this.schedulePoll(0);
    return true;
  }

  async poll() {
    if (this.closed || this.inFlight) return;
    this.clearPollTimer();
    const now = this.now();
    const earliest = this.lastRequestStartedAt + this.minimumRequestIntervalMs;
    if (now < earliest) { this.schedulePoll(earliest - now); return; }
    this.lastRequestStartedAt = now;
    const descriptor = this.activationToken ? null : (this.descriptor() || {});
    const body = JSON.stringify({
      protocol: 1,
      session_id: this.transportSessionId,
      instance_id: this.instanceId,
      ...(this.activationToken ? { activation_token: this.activationToken } : {}),
      ack_worker_seq: this.inbound.acknowledged,
      owned_call_ids: [...this.ownedCallIds()].slice(0, 32),
      messages: this.outbound.snapshot(),
      ...(this.takeoverWebSocket ? { takeover_websocket: true } : {}),
      ...(descriptor ? {
        tools: descriptor.tools ?? [], policy: descriptor.policy ?? {},
        relay_diagnostics: descriptor.relayDiagnostics ?? {},
      } : {}),
    });
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const headers = createDaemonHttpRelayHeaders(
        this.deviceIdentity, this.workerUrl, this.expectedServer, this.expectedVersion, body, this.wallNow(),
      );
      const response = await this.postRequest({
        url: this.endpoint, headers, body, timeoutMs: this.requestTimeoutMs,
        maximumResponseBytes: relayContract.httpFallbackMaximumEnvelopeBytes, signal: controller.signal,
      });
      if (this.inFlight !== controller || this.closed) return;
      this.networkRoute = response.networkRoute || this.networkRoute;
      await this.handleResponse(response.statusCode, response.body);
    } catch (error) {
      if (this.inFlight !== controller || this.closed) return;
      this.handleFailure(error);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    if (!this.closed) this.schedulePoll(this.nextPollDelay());
  }

  async handleResponse(statusCode, text) {
    if (statusCode === 404 || statusCode === 405 || statusCode === 426) {
      this.handleFailure(Object.assign(new Error("daemon HTTP fallback is not supported by the Worker"), { code: "daemon_http_unsupported" }));
      return;
    }
    if (statusCode === 401 || statusCode === 403) {
      this.handleFailure(Object.assign(new Error("daemon HTTP fallback authentication failed"), { code: "authentication_failed" }));
      return;
    }
    if (statusCode === 409) {
      this.resetSession(true);
      return;
    }
    if (statusCode < 200 || statusCode >= 300) {
      this.handleFailure(Object.assign(new Error("daemon HTTP fallback request failed"), { code: "network_error" }));
      return;
    }
    let body;
    try { body = JSON.parse(String(text || "")); } catch {
      this.resetSession(true); return;
    }
    if (!validResponse(body)) { this.resetSession(true); return; }
    if (!this.outbound.acknowledge(body.ack_daemon_seq)) { this.resetSession(true); return; }
    this.lastSuccessAt = this.now();
    this.lastSuccessWallAt = this.wallNow();
    this.lastErrorClass = "";
    this.consecutiveFailures = 0;
    if (body.phase === "standby") { this.resetSession(this.ready); return; }
    if (!this.authenticated) {
      this.authenticated = true;
      this.sessionGeneration += 1;
      this.activeSessionId = this.sessionIdBase + this.sessionGeneration;
      this.activationToken = body.activation_token;
    }
    if (body.phase === "ready" && this.localReady && !this.ready) {
      this.ready = true;
      try { this.onReady({ reconnected: true, sessionId: this.activeSessionId, transport: "https" }); }
      catch { /* Readiness notification is advisory; the authenticated transport state is already committed. */ }
    }
    for (const message of body.messages) {
      const sequence = this.inbound.classify(message.seq);
      if (sequence === "duplicate") continue;
      if (sequence === "gap") { this.resetSession(true); return; }
      const handlingSessionId = this.activeSessionId;
      const context = { sessionId: this.activeSessionId, authenticated: true, ready: this.ready, transport: "https" };
      let outcome;
      try { outcome = this.onMessage(JSON.stringify(message.payload), context); }
      catch (error) { this.logger.error?.("daemon HTTP relay message handler failed", { error_class: classifyOperationalError(error) }); return; }
      if (message.payload?.type === "tool_call") {
        if (this.closed || !this.authenticated || this.activeSessionId !== handlingSessionId) return;
        this.inbound.commit(message.seq);
        if (outcome && typeof outcome.catch === "function") {
          outcome.catch((error) => this.logger.error?.("daemon HTTP relay message handler failed", { error_class: classifyOperationalError(error) }));
        }
        continue;
      }
      try { await outcome; }
      catch (error) { this.logger.error?.("daemon HTTP relay control handler failed", { error_class: classifyOperationalError(error) }); return; }
      if (this.closed || !this.authenticated || this.activeSessionId !== handlingSessionId) return;
      this.inbound.commit(message.seq);
    }
  }

  handleFailure(error) {
    this.lastErrorClass = classifyOperationalError(error);
    this.consecutiveFailures += 1;
    if (!this.ready || !this.lastSuccessAt || this.now() - this.lastSuccessAt < this.livenessTimeoutMs) return;
    this.resetSession(true);
  }

  resetSession(notify) {
    const wasReady = this.ready;
    this.ready = false;
    this.localReady = false;
    this.authenticated = false;
    this.activeSessionId = 0;
    this.activationToken = "";
    this.transportSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
    if (!HTTP_SESSION_ID.test(this.transportSessionId)) throw new Error("could not create daemon HTTP relay session id");
    this.outbound.reset();
    this.inbound.reset();
    if (notify && wasReady) {
      try { this.onDisconnect({ transport: "https" }); }
      catch { /* Disconnect notification cannot restore the closed transport and must not block session reset. */ }
    }
  }

  nextPollDelay() {
    if (!this.authenticated || !this.ready || this.outbound.messages.length > 0) return 0;
    return this.pollIntervalMs;
  }

  schedulePoll(delay) {
    if (this.closed || this.inFlight) return;
    const earliestDelay = Math.max(0, this.lastRequestStartedAt + this.minimumRequestIntervalMs - this.now());
    const boundedDelay = Math.max(earliestDelay, Number(delay) || 0);
    if (this.pollTimer && boundedDelay > 0) return;
    this.clearPollTimer();
    this.pollTimer = this.scheduler.setTimeout(() => { this.pollTimer = null; void this.poll(); }, boundedDelay);
    this.pollTimer?.unref?.();
  }

  clearPollTimer() {
    if (!this.pollTimer) return;
    this.scheduler.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

function validResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.protocol !== 1) return false;
  if (!["probing", "ready", "standby"].includes(body.phase)) return false;
  if (!Number.isSafeInteger(body.ack_daemon_seq) || body.ack_daemon_seq < 0 || !Array.isArray(body.messages) || body.messages.length > 64) return false;
  if (body.phase !== "standby" && (typeof body.activation_token !== "string" || !ACTIVATION_TOKEN.test(body.activation_token))) return false;
  return body.messages.every((message) => message && typeof message === "object" && !Array.isArray(message)
    && Number.isSafeInteger(message.seq) && message.seq > 0 && message.payload && typeof message.payload === "object" && !Array.isArray(message.payload));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
