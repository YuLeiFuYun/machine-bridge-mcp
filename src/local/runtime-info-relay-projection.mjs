// @ts-check

/** @param {unknown} value */
export function compactRuntimeRelay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const relay = /** @type {Record<string, unknown>} */ (value);
  return {
    authenticated: relay.authenticated === true,
    ready: relay.ready === true,
    closed: relay.closed === true,
    transport: relay.transport ?? null,
    network_route: relay.network_route ?? null,
    reconnect_attempt: relay.reconnect_attempt ?? 0,
    outage_active: relay.outage_active === true,
    outage_count: relay.outage_count ?? 0,
    outage_duration_ms: relay.outage_duration_ms ?? 0,
    last_close_category: relay.last_close_category ?? null,
    last_close_code: relay.last_close_code ?? null,
    last_transport_error_class: relay.last_transport_error_class ?? null,
    https_fallback_active: relay.https_fallback_active === true,
    websocket_ready: relay.websocket_ready === true,
    https_fallback_last_takeover_ms: relay.https_fallback_last_takeover_ms ?? 0,
    https_fallback_last_takeover_outage_number: relay.https_fallback_last_takeover_outage_number ?? 0,
  };
}
