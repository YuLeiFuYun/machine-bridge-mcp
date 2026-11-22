import { positiveInteger } from "../../shared/numbers.mjs";
import { normalizeRelayHeartbeatTiming, positiveInteger as livenessPositiveInteger } from "./relay-recovery.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { RelayInboundState, preferredRelayCloseCategory } from "./relay-diagnostics.mjs";
import { classifyRelayTransportError, terminateSocket } from "./relay-classification.mjs";
import { classifyOperationalError } from "../core/log.mjs";

export class RelayProbeDeadline {
  constructor(enabled = false) {
    this.enabled = enabled === true;
    this.sentAt = null;
    this.lastResponseMs = 0;
    this.maxResponseMs = 0;
    this.lastTimeoutAgeMs = 0;
  }

  reset() { this.sentAt = null; }
  outstanding() { return this.enabled && Number.isFinite(this.sentAt); }
  age(now) { return this.outstanding() ? Math.max(0, Number(now) - this.sentAt) : 0; }

  sent(now, accepted) {
    if (this.enabled && accepted !== false && Number.isFinite(Number(now))) this.sentAt = Number(now);
  }

  observe(now) {
    if (!this.outstanding()) return;
    const responseMs = this.age(now);
    this.lastResponseMs = responseMs;
    this.maxResponseMs = Math.max(this.maxResponseMs, responseMs);
    this.sentAt = null;
  }

  timeout(now) {
    const age = this.age(now);
    this.lastTimeoutAgeMs = age;
    this.sentAt = null;
    return age;
  }

  snapshot(now) {
    if (!this.enabled) return {};
    return {
      probe_timeout_from_dispatch: true,
      probe_outstanding: this.outstanding(),
      probe_age_ms: this.age(now),
      last_probe_response_ms: this.lastResponseMs,
      max_probe_response_ms: this.maxResponseMs,
      last_probe_timeout_age_ms: this.lastTimeoutAgeMs,
    };
  }
}
class RelayProbeDispatchMetrics {
  constructor() {
    this.lastDelayMs = 0;
    this.maxDelayMs = 0;
    this.lastTimeoutAgeMs = 0;
  }

  complete(delay) {
    this.lastDelayMs = delay;
    this.maxDelayMs = Math.max(this.maxDelayMs, delay);
  }

  timeout(age) { this.lastTimeoutAgeMs = age; }

  snapshot() {
    return {
      last_probe_dispatch_ms: this.lastDelayMs,
      max_probe_dispatch_ms: this.maxDelayMs,
      last_probe_dispatch_timeout_age_ms: this.lastTimeoutAgeMs,
    };
  }
}

export class RelayProbeDispatch {
  constructor(enabled = false) {
    this.enabled = enabled === true; this.pendingAt = null; this.token = 0;
    this.metrics = new RelayProbeDispatchMetrics(); this.proofObserved = false;
  }
  begin(now) {
    if (!this.enabled || !Number.isFinite(Number(now))) return 0;
    this.token += 1; this.pendingAt = Number(now); this.proofObserved = false;
    return this.token;
  }
  cancel(token) {
    if (token !== this.token) return false;
    this.pendingAt = null; this.proofObserved = false; return true;
  }
  complete(token, now) {
    if (token !== this.token || !this.pending()) return null;
    const delay = this.age(now); const satisfiedByProof = this.proofObserved;
    this.metrics.complete(delay); this.pendingAt = null; this.proofObserved = false;
    return { delayMs: delay, satisfiedByProof };
  }
  pending() { return this.enabled && Number.isFinite(this.pendingAt); }
  age(now) { return this.pending() ? Math.max(0, Number(now) - this.pendingAt) : 0; }
  observeProof() { if (this.pending()) this.proofObserved = true; }
  timeout(now) {
    const age = this.age(now); this.metrics.timeout(age); this.reset(); return age;
  }
  reset() { this.pendingAt = null; this.proofObserved = false; this.token += 1; }
  metricsSnapshot() { return this.metrics.snapshot(); }
  snapshot(now) {
    if (!this.enabled) return {};
    return {
      probe_dispatch_pending: this.pending(), probe_dispatch_age_ms: this.age(now),
      ...this.metricsSnapshot(),
    };
  }
}
export class RelayHeartbeatStall {
  constructor({ logger, timeoutMs, wallNow = Date.now }) {
    this.logger = logger || console;
    this.timeoutMs = timeoutMs;
    this.wallNow = wallNow;
    this.lastLagMs = 0;
    this.maxLagMs = 0;
    this.count = 0;
    this.lastWallAt = 0;
    this.lastStallLagMs = 0;
    this.lastWarnAt = 0;
  }

  recordLag(lagMs) {
    this.lastLagMs = lagMs;
    this.maxLagMs = Math.max(this.maxLagMs, lagMs);
  }

  observe(now, lagMs, recoveryGraceMs, relayDisconnectDeferred = true) {
    this.count += 1;
    this.lastWallAt = this.wallNow();
    this.lastStallLagMs = lagMs;
    if (this.lastWarnAt && now - this.lastWarnAt < this.timeoutMs) return;
    this.lastWarnAt = now;
    this.logger.warn?.(
      relayDisconnectDeferred
        ? "local event loop stalled; relay liveness decision deferred"
        : "local event loop resumed after a long pause; reconnecting stale relay transport",
      {
        event: "runtime.event_loop.stall",
        lag_ms: lagMs,
        recovery_grace_ms: recoveryGraceMs,
        relay_disconnect_deferred: relayDisconnectDeferred,
      },
    );
  }

  snapshot() {
    return {
      last_event_loop_lag_ms: this.lastLagMs,
      max_event_loop_lag_ms: this.maxLagMs,
      event_loop_stall_count: this.count,
      last_event_loop_stall_at: this.lastWallAt > 0 ? new Date(this.lastWallAt).toISOString() : null,
      last_event_loop_stall_lag_ms: this.lastStallLagMs,
    };
  }
}
export function advanceRelayTransportState(monitor, now, silentForMs, eventLoopLagMs) {
  if (monitor.confirmation.pending()) {
    if (monitor.confirmation.dispatchExpired(now)) {
      monitor.onTimeout({ silentForMs, eventLoopLagMs,
        confirmationDispatchAgeMs: monitor.confirmation.dispatchTimeout(now) });
    } else if (monitor.confirmation.expired(now)) {
      monitor.onTimeout({ silentForMs, eventLoopLagMs, confirmationAgeMs: monitor.confirmation.timeout(now) });
    }
    return true;
  }
  if (!monitor.probeDeadline.enabled) return false;
  if (monitor.probeDispatch.pending()) {
    const dispatchAgeMs = monitor.probeDispatch.age(now);
    if (dispatchAgeMs >= monitor.dispatchTimeoutMs) {
      monitor.probeDispatch.timeout(now);
      monitor.onTimeout({ silentForMs, eventLoopLagMs, probeAgeMs: 0, dispatchAgeMs });
    }
    return true;
  }
  if (monitor.probeDeadline.outstanding()) {
    const probeAgeMs = monitor.probeDeadline.age(now);
    if (probeAgeMs >= monitor.timeoutMs) {
      const details = { silentForMs, eventLoopLagMs, probeAgeMs: monitor.probeDeadline.timeout(now) };
      if (!monitor.confirmation.begin(now, details)) monitor.onTimeout(details);
    }
    return true;
  }
  monitor.sendProbe(now);
  return true;
}
export class RelayTransportConfirmation {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000);
    this.dispatchTimeoutMs = positiveInteger(options.dispatchTimeoutMs, 30_000);
    this.sendConfirmation = typeof options.sendConfirmation === "function" ? options.sendConfirmation : () => false;
    this.onSuspect = typeof options.onSuspect === "function" ? options.onSuspect : () => {};
    this.onRecovered = typeof options.onRecovered === "function" ? options.onRecovered : () => {};
    this.dispatch = new RelayProbeDispatch(this.enabled); this.deadline = new RelayProbeDeadline(this.enabled); this.startedAt = null;
  }
  begin(now, details = {}) {
    if (!this.enabled || this.pending()) return false;
    const current = Number(now); if (!Number.isFinite(current)) return false;
    this.startedAt = current; const token = this.dispatch.begin(current);
    this.onSuspect({ ...details, confirmation_timeout_ms: this.timeoutMs,
      confirmation_dispatch_timeout_ms: this.dispatchTimeoutMs });
    let requested = false;
    try {
      requested = this.sendConfirmation(current, (error, dispatchedAt) => {
        if (error) {
          if (this.dispatch.cancel(token)) this.startedAt = null;
          return;
        }
        const completed = this.dispatch.complete(token, dispatchedAt);
        if (completed && !completed.satisfiedByProof) this.deadline.sent(dispatchedAt, true);
      }) !== false;
    } catch { requested = false; }
    if (!requested) this.reset();
    return requested;
  }
  observe(now) {
    if (!this.pending()) return false;
    this.dispatch.observeProof();
    const responseMs = this.deadline.age(now); const totalMs = this.totalAge(now);
    this.deadline.observe(now); this.resetPending();
    this.onRecovered({ confirmation_ms: responseMs, confirmation_total_ms: totalMs,
      reason: "inbound_confirmation", confirmed: true });
    return true;
  }
  pending() { return this.dispatch.pending() || this.deadline.outstanding(); }
  dispatchPending() { return this.dispatch.pending(); }
  responsePending() { return this.deadline.outstanding(); }
  dispatchAge(now) { return this.dispatch.age(now); }
  age(now) { return this.deadline.age(now); }
  totalAge(now) { return this.startedAt === null ? 0 : Math.max(0, Number(now) - this.startedAt); }
  dispatchExpired(now) { return this.dispatchPending() && this.dispatchAge(now) >= this.dispatchTimeoutMs; }
  expired(now) { return this.responsePending() && this.age(now) >= this.timeoutMs; }
  dispatchTimeout(now) { const age = this.dispatch.timeout(now); this.startedAt = null; return age; }
  timeout(now) { const age = this.deadline.timeout(now); this.startedAt = null; return age; }
  cancel(now, reason = "cancelled") {
    if (!this.pending()) return false;
    const responseMs = this.age(now); const totalMs = this.totalAge(now); this.resetPending();
    this.onRecovered({ confirmation_ms: responseMs, confirmation_total_ms: totalMs, reason, confirmed: false });
    return true;
  }
  reset() { this.resetPending(); }
  resetPending() { this.dispatch.reset(); this.deadline.reset(); this.startedAt = null; }
  snapshot(now) {
    if (!this.enabled) return {};
    const metrics = this.dispatch.metricsSnapshot(); const response = this.deadline.snapshot(now);
    return {
      transport_confirmation_pending: this.pending(), transport_confirmation_dispatch_pending: this.dispatchPending(),
      transport_confirmation_dispatch_age_ms: this.dispatchAge(now), transport_confirmation_dispatch_timeout_ms: this.dispatchTimeoutMs,
      transport_confirmation_age_ms: this.age(now), transport_confirmation_timeout_ms: this.timeoutMs,
      last_transport_confirmation_dispatch_ms: metrics.last_probe_dispatch_ms,
      max_transport_confirmation_dispatch_ms: metrics.max_probe_dispatch_ms,
      last_transport_confirmation_dispatch_timeout_age_ms: metrics.last_probe_dispatch_timeout_age_ms,
      last_transport_confirmation_ms: response.last_probe_response_ms, max_transport_confirmation_ms: response.max_probe_response_ms,
      last_transport_confirmation_timeout_age_ms: response.last_probe_timeout_age_ms,
    };
  }
}
export class RelayHeartbeatMonitor {
  constructor(options = {}) {
    Object.assign(this, normalizeRelayHeartbeatTiming(options));
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.logger = options.logger || console;
    this.isActive = options.isActive;
    this.lastInboundAt = options.lastInboundAt;
    this.sendHeartbeat = options.sendHeartbeat;
    this.onTimeout = options.onTimeout;
    this.probeDeadline = new RelayProbeDeadline(options.timeoutAfterProbe);
    this.probeDispatch = new RelayProbeDispatch(options.timeoutAfterProbe);
    this.confirmation = new RelayTransportConfirmation({ enabled: options.timeoutAfterProbe,
      timeoutMs: options.confirmationTimeoutMs, dispatchTimeoutMs: this.dispatchTimeoutMs,
      sendConfirmation: options.sendConfirmation, onSuspect: options.onSuspect, onRecovered: options.onRecovered });
    this.stall = new RelayHeartbeatStall({ logger: this.logger, timeoutMs: this.timeoutMs, wallNow: options.wallNow });
    this.timer = null; this.expectedAt = 0; this.recoveryUntil = 0;
  }

  start() {
    this.stop();
    this.expectedAt = this.now() + this.intervalMs;
    this.recoveryUntil = 0;
    this.timer = this.scheduler.setInterval(() => this.tick(), this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.expectedAt = 0;
    this.recoveryUntil = 0;
    this.probeDeadline.reset(); this.probeDispatch.reset(); this.confirmation.reset();
  }

  observeInbound() {
    this.probeDispatch.observeProof();
    this.probeDeadline.observe(this.now());
    this.confirmation.observe(this.now());
    this.recoveryUntil = 0;
  }

  snapshot(now = this.now()) {
    const current = Number(now) || 0;
    return {
      interval_ms: this.intervalMs,
      timeout_ms: this.timeoutMs,
      recovery_grace_ms: this.recoveryGraceMs,
      recovery_active: this.recoveryUntil > current,
      recovery_remaining_ms: this.recoveryUntil > current ? this.recoveryUntil - current : 0,
      ...this.stall.snapshot(),
      dispatch_timeout_ms: this.probeDeadline.enabled ? this.dispatchTimeoutMs : 0,
      ...this.probeDispatch.snapshot(current),
      ...this.probeDeadline.snapshot(current),
      ...this.confirmation.snapshot(current),
    };
  }

  tick() {
    const now = this.now();
    const expectedAt = this.expectedAt || now;
    const eventLoopLagMs = Math.max(0, now - expectedAt);
    this.expectedAt = now + this.intervalMs;
    if (!this.isActive()) return;
    this.stall.recordLag(eventLoopLagMs);

    if (eventLoopLagMs >= this.stallThresholdMs) {
      const silentForMs = Math.max(0, now - this.lastInboundAt());
      const staleAfterLongPause = eventLoopLagMs > this.timeoutMs + this.recoveryGraceMs
        && silentForMs > this.timeoutMs;
      this.stall.observe(now, eventLoopLagMs, this.recoveryGraceMs, !staleAfterLongPause);
      if (staleAfterLongPause) {
        this.recoveryUntil = 0;
        this.onTimeout({ silentForMs, eventLoopLagMs, probeAgeMs: this.probeDeadline.age(now) });
        return;
      }
      this.recoveryUntil = Math.max(this.recoveryUntil, now + this.recoveryGraceMs);
      this.probeDeadline.reset(); this.confirmation.cancel(now, "local_event_loop_stall");
      if (!this.probeDispatch.pending()) this.sendProbe(now);
      return;
    }
    if (now < this.recoveryUntil) {
      if (!this.probeDeadline.outstanding() && !this.probeDispatch.pending()) this.sendProbe(now);
      return;
    }

    const silentForMs = Math.max(0, now - this.lastInboundAt());
    if (advanceRelayTransportState(this, now, silentForMs, eventLoopLagMs)) return;
    if (silentForMs >= this.timeoutMs) {
      this.onTimeout({ silentForMs, eventLoopLagMs });
      return;
    }
    this.sendHeartbeat(now);
  }

  sendProbe(now) {
    if (!this.probeDeadline.enabled) return this.sendHeartbeat(now);
    const token = this.probeDispatch.begin(now);
    const sent = this.sendHeartbeat(now, () => {
      const dispatchedAt = this.now();
      const completed = this.probeDispatch.complete(token, dispatchedAt);
      if (completed && !completed.satisfiedByProof) this.probeDeadline.sent(dispatchedAt, true);
    });
    if (sent === false) this.probeDispatch.cancel(token);
    return sent;
  }

}
const MAX_BUFFERED_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;

export function sendRelayTransportProbe(socket, fallback, onTransportError, onDispatched) {
  if (!socket) return { sent: false, bufferedBytes: 0 };
  const bufferedBytes = boundedBufferedAmount(socket.bufferedAmount);
  if (typeof socket.ping !== "function") {
    const sent = fallback?.() !== false;
    if (sent) onDispatched?.();
    return { sent, bufferedBytes };
  }
  try {
    socket.ping((error) => {
      if (error) onTransportError?.(error, socket);
      else onDispatched?.();
    });
    return { sent: true, bufferedBytes };
  } catch (error) {
    onTransportError?.(error, socket);
    return { sent: false, bufferedBytes };
  }
}

function boundedBufferedAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(MAX_BUFFERED_DIAGNOSTIC_BYTES, Math.round(number)) : 0;
}
export class RelayTransportProbe {
  constructor({ currentSocket, fallback, onTransportError }) {
    this.currentSocket = currentSocket;
    this.fallback = fallback;
    this.onTransportError = onTransportError;
    this.lastBufferedBytes = 0;
    this.maxBufferedBytes = 0;
  }

  send(onDispatched) {
    const socket = this.currentSocket?.();
    const isCurrent = () => this.currentSocket?.() === socket;
    const probe = sendRelayTransportProbe(socket, this.fallback,
      (error, failedSocket) => { if (isCurrent()) this.onTransportError?.(error, failedSocket); },
      () => { if (isCurrent()) onDispatched?.(); });
    this.lastBufferedBytes = probe.bufferedBytes;
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, probe.bufferedBytes);
    return probe.sent;
  }

  snapshot() {
    return { last_probe_buffered_bytes: this.lastBufferedBytes, max_probe_buffered_bytes: this.maxBufferedBytes };
  }
}
const SILENT_STALL_LOGGER = Object.freeze({ warn() {} });

export class RelayLiveness {
  constructor(options = {}) {
    this.now = options.now; this.currentSocket = options.currentSocket;
    this.sendApplicationHeartbeat = options.sendApplicationHeartbeat;
    this.isApplicationActive = typeof options.isApplicationActive === "function" ? options.isApplicationActive : options.isActive;
    this.inbound = new RelayInboundState(this.now);
    this.transportProbe = new RelayTransportProbe({
      currentSocket: this.currentSocket,
      fallback: () => this.sendApplicationProbe(this.now()),
      onTransportError: options.onTransportError,
    });
    const active = options.isActive;
    const scheduler = options.scheduler;
    const transportIntervalMs = livenessPositiveInteger(options.transportPingIntervalMs ?? options.heartbeatIntervalMs,
      relayContract.transportPingIntervalMs);
    this.transport = new RelayHeartbeatMonitor({
      intervalMs: transportIntervalMs,
      timeoutMs: livenessPositiveInteger(options.transportPongTimeoutMs ?? options.heartbeatTimeoutMs,
        relayContract.transportPongTimeoutMs),
      timeoutAfterProbe: true,
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs ?? transportIntervalMs,
      scheduler,
      now: this.now,
      wallNow: options.wallNow,
      logger: options.logger,
      isActive: active,
      lastInboundAt: () => this.inbound.lastInboundAt,
      dispatchTimeoutMs: livenessPositiveInteger(options.transportPingDispatchTimeoutMs,
        relayContract.transportPingDispatchTimeoutMs),
      confirmationTimeoutMs: livenessPositiveInteger(options.transportConfirmationTimeoutMs,
        relayContract.transportApplicationConfirmationTimeoutMs),
      sendHeartbeat: (_now, onDispatched) => this.transportProbe.send(onDispatched),
      sendConfirmation: (now, onDispatched) => this.sendApplicationProbe(now, onDispatched),
      onSuspect: (details) => options.onTransportSuspect?.(details, this.currentSocket?.()),
      onRecovered: (details) => options.onTransportRecovered?.(details, this.currentSocket?.()),
      onTimeout: (details) => options.onTransportTimeout?.(details, this.currentSocket?.()),
    });
    this.application = new RelayHeartbeatMonitor({
      intervalMs: livenessPositiveInteger(options.applicationHeartbeatIntervalMs,
        relayContract.daemonApplicationHeartbeatIntervalMs),
      timeoutMs: livenessPositiveInteger(options.applicationHeartbeatTimeoutMs,
        relayContract.daemonApplicationHeartbeatTimeoutMs),
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs,
      scheduler,
      now: this.now,
      wallNow: options.wallNow,
      logger: SILENT_STALL_LOGGER,
      isActive: this.isApplicationActive,
      lastInboundAt: () => this.inbound.lastApplicationInboundAt,
      sendHeartbeat: (now) => this.sendApplicationProbe(now),
      onTimeout: (details) => options.onApplicationTimeout?.(details, this.currentSocket?.()),
    });
  }

  start() {
    this.inbound.reset();
    this.transport.start();
    this.application.start();
  }

  stop() {
    this.transport.stop();
    this.application.stop();
  }

  observeInbound() {
    this.inbound.observeTransportProof(this.transport);
  }

  observeApplicationInbound() {
    this.inbound.observeApplicationInbound(this.application);
  }

  observeApplicationPong() {
    this.inbound.observeApplicationProof(this.transport, this.application);
  }

  silenceMs(now = this.now()) {
    return this.inbound.silenceMs(now);
  }

  snapshot(now = this.now()) {
    const application = this.application.snapshot(now);
    return {
      ...this.transport.snapshot(now),
      ...this.transportProbe.snapshot(),
      application_heartbeat_interval_ms: application.interval_ms,
      application_heartbeat_timeout_ms: application.timeout_ms,
      application_inbound_silence_ms: this.inbound.applicationSilenceMs(now),
    };
  }

  sendApplicationProbe(now, onDispatched) {
    if (!this.isApplicationActive?.()) return false;
    const socket = this.currentSocket?.();
    return socket ? this.sendApplicationHeartbeat?.(now, socket, onDispatched) !== false : false;
  }
}
export function relayLivenessActions(connection) {
  return {
    onTransportError: (error, socket) => {
      const errorClass = connection.transportError.record(classifyRelayTransportError(error), {
        error, ready: connection.ready, authenticated: connection.authenticated,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory, "relay_transport_error");
      connection.logger.debug?.("remote relay transport ping failed", { error_class: errorClass });
      terminateSocket(socket);
    },
    onTransportSuspect: ({ silentForMs, probeAgeMs, confirmation_timeout_ms: confirmationTimeoutMs }, socket) => {
      if (!socket || !connection.ready) return;
      connection.logger.warn?.("remote relay protocol pong overdue; checking the application path before reconnecting", {
        event: "relay.transport.suspect", silent_for_ms: silentForMs,
        probe_age_ms: bounded(probeAgeMs), confirmation_timeout_ms: bounded(confirmationTimeoutMs),
      });
      notifyObserver(connection, "onDegraded", {
        category: "relay_transport_timeout", connectionId: connection.workerConnectionId, sessionId: connection.activeSessionId,
      }, "relay degraded callback failed");
    },
    onTransportRecovered: ({ confirmation_ms: confirmationMs, reason = "inbound_confirmation", confirmed = true }, socket) => {
      if (!socket || !connection.ready) return;
      connection.logger.warn?.("remote relay transport suspicion cleared without reconnecting", {
        event: "relay.transport.recovered", confirmation_ms: bounded(confirmationMs),
        recovery_reason: reason, transport_confirmed: confirmed === true,
      });
      notifyObserver(connection, "onRecovered", {
        category: "relay_transport_timeout", connectionId: connection.workerConnectionId, sessionId: connection.activeSessionId,
      }, "relay recovery callback failed");
    },
    onTransportTimeout: ({ silentForMs, eventLoopLagMs, probeAgeMs, dispatchAgeMs,
      confirmationDispatchAgeMs, confirmationAgeMs }, socket) => {
      if (!socket) return;
      const dispatchTimedOut = Number(dispatchAgeMs) > 0 || Number(confirmationDispatchAgeMs) > 0;
      const confirmationSendTimedOut = Number(confirmationDispatchAgeMs) > 0;
      connection.logger.warn?.(dispatchTimedOut ? "remote relay liveness frame dispatch timed out" : "remote relay transport confirmation failed; reconnecting", {
        event: confirmationSendTimedOut ? "relay.transport.confirmation_send_timeout"
          : dispatchTimedOut ? "relay.transport.send_timeout" : "relay.transport.confirmation_failed",
        silent_for_ms: silentForMs, probe_age_ms: bounded(probeAgeMs), dispatch_age_ms: bounded(dispatchAgeMs),
        confirmation_dispatch_age_ms: bounded(confirmationDispatchAgeMs),
        confirmation_age_ms: bounded(confirmationAgeMs), event_loop_lag_ms: eventLoopLagMs,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory,
        dispatchTimedOut ? "relay_transport_send_timeout" : "relay_transport_timeout");
      terminateSocket(socket);
    },
    onApplicationTimeout: ({ silentForMs, eventLoopLagMs }, socket) => {
      if (!socket) return;
      connection.logger.debug?.("remote relay application heartbeat timed out", {
        silent_for_ms: silentForMs, event_loop_lag_ms: eventLoopLagMs,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory, "relay_heartbeat_timeout");
      terminateSocket(socket);
    },
  };
}

function bounded(value) { return Math.max(0, Number(value) || 0); }

function notifyObserver(connection, name, event, message) {
  try { connection[name](event); }
  catch (error) { connection.logger.error?.(message, { error_class: classifyOperationalError(error) }); }
}
