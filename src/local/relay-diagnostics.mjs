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
  return {
    outage_number: state.outageCount,
    disconnected_at: isoTimestamp(state.lastDisconnectedAt),
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
