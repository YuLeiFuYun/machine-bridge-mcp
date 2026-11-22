import { performance } from "node:perf_hooks";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { MAX_CONCURRENT_TOOL_CALLS } from "../process/execution-limits.mjs";

export const APPLICATION_PROXY_ROUTE_SCOPE = "application-proxy-selection-only";

export const RECENT_RELAY_OUTAGE_LIMIT = 8;

export function preferredRelayCloseCategory(current, next) {
  const existing = String(current || "");
  const candidate = String(next || "relay_transport_error");
  return !existing || existing === "relay_transport_error" ? candidate : existing;
}

export function relayStatusSnapshot(state, now = Date.now()) {
  const current = Number(now) || 0;
  const liveness = state.liveness?.snapshot(current) || null;
  const initialLiveness = state.outageStartedLiveness || {};
  return {
    authenticated: state.authenticated === true,
    ready: state.ready === true,
    readiness_probe_delivered: state.readinessProbeDelivered === true,
    closed: state.closed === true,
    network_route: state.networkRoute,
    network_route_scope: state.networkRouteScope,
    transport: "websocket",
    connect_timeout_ms: state.connectTimeoutMs,
    handshake_timeout_ms: state.handshakeTimeoutMs,
    readiness_timeout_ms: state.readinessTimeoutMs,
    ...connectTimingFields(state),
    reconnect_attempt: state.reconnectAttempt,
    outage_active: state.outageStartedAt > 0,
    outage_count: state.outageCount,
    outage_attempts: state.outageAttempts,
    outage_started_at: isoTimestamp(state.outageStartedWallAt),
    outage_duration_ms: state.outageStartedAt > 0 ? Math.max(0, current - state.outageStartedAt) : 0,
    probe_dispatch_pending_at_start: initialLiveness.probe_dispatch_pending === true,
    probe_dispatch_age_ms_at_start: boundedMs(initialLiveness.probe_dispatch_age_ms),
    probe_outstanding_at_start: initialLiveness.probe_outstanding === true,
    probe_age_ms_at_start: boundedMs(initialLiveness.probe_age_ms),
    transport_confirmation_pending_at_start: initialLiveness.transport_confirmation_pending === true,
    application_inbound_silence_ms_at_start: boundedMs(initialLiveness.application_inbound_silence_ms),
    recent_outages: recentOutagesSnapshot(state.recentOutages),
    last_close_category: state.outageCount > 0 ? state.lastCloseCategory : null,
    last_close_code: state.outageCount > 0 ? state.lastCloseCode : null,
    last_transport_error_class: state.outageCount > 0 ? (state.transportError?.errorClass || null) : null,
    ...(state.transportError?.snapshot?.() || {}),
    last_disconnected_at: isoTimestamp(state.lastDisconnectedAt),
    last_ready_at: isoTimestamp(state.lastReadyWallAt),
    last_ready_duration_ms: state.lastReadyDurationMs,
    last_ready_inbound_silence_ms: state.lastReadyInboundSilenceMs,
    application_heartbeat_interval_ms: liveness?.application_heartbeat_interval_ms || 0,
    application_heartbeat_timeout_ms: liveness?.application_heartbeat_timeout_ms || 0,
    last_reconnect_delay_ms: state.lastReconnectDelayMs,
    next_reconnect_at: isoTimestamp(state.nextReconnectWallAt),
    next_reconnect_in_ms: state.nextReconnectAt > 0 ? Math.max(0, state.nextReconnectAt - current) : 0,
    session_generation: state.sessionGeneration,
    heartbeat: liveness,
  };
}

export function relayOutageFields(state, now, cause) {
  const current = Number(now) || 0;
  return {
    event: "relay.outage.active",
    outage_seconds: roundSeconds(Math.max(0, current - state.outageStartedAt)),
    attempts: state.outageAttempts,
    cause,
    close_category: state.lastCloseCategory,
    close_code: state.lastCloseCode,
    previous_ready_inbound_silence_ms: state.lastReadyInboundSilenceMs,
    network_route: state.networkRoute,
    network_route_scope: state.networkRouteScope,
    transport: "websocket",
    ...connectTimingFields(state),
    next_reconnect_in_ms: state.nextReconnectAt > 0 ? Math.max(0, state.nextReconnectAt - current) : 0,
    ...(state.transportError?.errorClass ? { error_class: state.transportError.errorClass } : {}),
    ...(state.transportError?.snapshot?.() || {}),
  };
}

export function relayRecoveryFields(state, outageMs) {
  return {
    event: "relay.outage.recovered",
    outage_seconds: roundSeconds(outageMs),
    attempts: state.outageAttempts,
    close_category: state.lastCloseCategory,
    close_code: state.lastCloseCode,
    previous_ready_inbound_silence_ms: state.lastReadyInboundSilenceMs,
    network_route: state.networkRoute,
    network_route_scope: state.networkRouteScope,
    transport: "websocket",
    ...connectTimingFields(state),
    ...(state.transportError?.errorClass ? { error_class: state.transportError.errorClass } : {}),
    ...(state.transportError?.snapshot?.() || {}),
  };
}

export function relayRecoveredOutageSnapshot(state, outageMs) {
  const initialLiveness = state.outageStartedLiveness || {};
  return {
    outage_number: state.outageCount,
    disconnected_at: isoTimestamp(state.outageStartedWallAt),
    last_disconnect_at: isoTimestamp(state.lastDisconnectedAt),
    ready_at: isoTimestamp(state.lastReadyWallAt),
    duration_ms: Math.max(0, Math.round(Number(outageMs) || 0)),
    attempts: state.outageAttempts,
    close_category: state.lastCloseCategory,
    close_code: state.lastCloseCode,
    network_route: state.networkRoute,
    last_transport_error_class: state.transportError?.errorClass || null,
    ...(state.transportError?.snapshot?.() || {}),
    previous_ready_duration_ms: state.lastReadyDurationMs,
    previous_ready_inbound_silence_ms: state.lastReadyInboundSilenceMs,
    probe_dispatch_pending_at_start: initialLiveness.probe_dispatch_pending === true,
    probe_dispatch_age_ms_at_start: boundedMs(initialLiveness.probe_dispatch_age_ms),
    probe_outstanding_at_start: initialLiveness.probe_outstanding === true,
    probe_age_ms_at_start: boundedMs(initialLiveness.probe_age_ms),
    transport_confirmation_pending_at_start: initialLiveness.transport_confirmation_pending === true,
    application_inbound_silence_ms_at_start: boundedMs(initialLiveness.application_inbound_silence_ms),
    ...connectTimingFields(state),
  };
}

export function recordRecoveredOutage(state, outageMs) {
  state.recentOutages.unshift(relayRecoveredOutageSnapshot(state, outageMs));
  if (state.recentOutages.length > RECENT_RELAY_OUTAGE_LIMIT) state.recentOutages.length = RECENT_RELAY_OUTAGE_LIMIT;
}

function isoTimestamp(value) {
  return Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
}

function roundSeconds(milliseconds) {
  return Math.max(1, Math.round(Number(milliseconds || 0) / 1000));
}

function boundedMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(31 * 24 * 60 * 60_000, Math.round(number)) : 0;
}

function connectTimingFields(state) {
  const value = state.connectTiming?.snapshot?.();
  return value && typeof value === "object" ? value : {
    last_connect_stage: "idle", last_connect_duration_ms: 0,
    last_connect_milestones_ms: {}, last_connect_http_status: null,
  };
}

function recentOutagesSnapshot(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, RECENT_RELAY_OUTAGE_LIMIT).map((entry) => ({
    ...entry,
    last_connect_milestones_ms: { ...(entry.last_connect_milestones_ms || {}) },
    last_failed_connect_milestones_ms: { ...(entry.last_failed_connect_milestones_ms || {}) },
  }));
}
const MAX_ACK_RETENTION_MS = relayContract.maximumRelayToolTimeoutMs;

const MAX_RETAINED_RESULTS = MAX_CONCURRENT_TOOL_CALLS;

const MAX_RETAINED_RESULTS_WITH_EMERGENCY_SLOT = MAX_RETAINED_RESULTS + 1;

export class RelayResultRetention {
  #entries = new Map();
  #retainedAt = new Map();
  constructor({ logger = {}, now = () => performance.now(), onOwnershipLost = (_callId) => {} } = {}) {
    this.logger = logger;
    this.now = now;
    this.onOwnershipLost = onOwnershipLost;
  }
  get size() { return this.#entries.size; }
  has(callId) { return this.#entries.has(String(callId || "")); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  retain(callId, response, { emergency = false } = {}) {
    const key = String(callId || "");
    const maximum = emergency ? MAX_RETAINED_RESULTS_WITH_EMERGENCY_SLOT : MAX_RETAINED_RESULTS;
    if (!this.#entries.has(key) && this.#entries.size >= maximum) return false;
    this.#entries.set(key, response);
    if (!this.#retainedAt.has(key)) this.#retainedAt.set(key, this.now());
    return true;
  }
  retainForDelivery(callId, response) {
    if (this.retain(callId, response)) return "normal";
    if (!this.retain(callId, response, { emergency: true })) {
      this.onOwnershipLost(callId);
      this.logger.event?.("error", "relay.tool_result.retention_capacity", {
        retained_results: this.size, emergency_slot_available: false,
      }, "Relay result recovery capacity invariant failed after the emergency retention slot was already occupied");
      return "full";
    }
    this.logger.event?.("error", "relay.tool_result.retention_capacity", {
      retained_results: this.size, emergency_slot_used: true,
    }, "Relay result recovery capacity invariant failed; retained the completed result in the emergency ownership slot without losing call ownership");
    return "emergency";
  }
  delete(callId) {
    const key = String(callId || "");
    this.#retainedAt.delete(key);
    return this.#entries.delete(key);
  }
  #clear() { this.#retainedAt.clear(); this.#entries.clear(); }
  discardAll() {
    const discarded = this.size;
    for (const callId of this.#entries.keys()) this.onOwnershipLost(callId);
    this.#clear();
    return discarded;
  }
  pruneExpired() {
    const cutoff = this.now() - MAX_ACK_RETENTION_MS;
    let expired = 0;
    for (const [callId, retainedAt] of this.#retainedAt) {
      if (retainedAt > cutoff || !this.#entries.has(callId)) continue;
      this.onOwnershipLost(callId);
      this.delete(callId); expired += 1;
    }
    if (expired > 0) this.logger.event?.("warn", "relay.tool_results.ack_expired", {
      expired_results: expired, acknowledgement_retention_ms: MAX_ACK_RETENTION_MS,
    }, "Discarded completed relay results after the Worker acknowledgement lifetime expired");
    return expired;
  }
}
export class RelayInboundState {
  constructor(now) {
    this.now = now;
    this.lastInboundAt = 0;
    this.lastApplicationInboundAt = 0;
  }

  reset() {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
  }

  observeTransportProof(transport) {
    this.lastInboundAt = this.now();
    transport.observeInbound();
  }

  observeApplicationInbound(application) {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    application.observeInbound();
  }

  observeApplicationProof(transport, application) {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    transport.observeInbound();
    application.observeInbound();
  }

  silenceMs(now = this.now()) {
    return this.lastInboundAt > 0 ? Math.max(0, Number(now) - this.lastInboundAt) : 0;
  }

  applicationSilenceMs(now = this.now()) {
    return Math.max(0, Number(now) - this.lastApplicationInboundAt);
  }
}
