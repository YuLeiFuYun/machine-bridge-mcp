// @ts-check

export function compactRuntimeRelay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    authenticated: value.authenticated === true,
    ready: value.ready === true,
    closed: value.closed === true,
    transport: value.transport ?? null,
    network_route: value.network_route ?? null,
    reconnect_attempt: value.reconnect_attempt ?? 0,
    outage_active: value.outage_active === true,
    outage_count: value.outage_count ?? 0,
    outage_duration_ms: value.outage_duration_ms ?? 0,
    last_close_category: value.last_close_category ?? null,
    last_close_code: value.last_close_code ?? null,
    last_transport_error_class: value.last_transport_error_class ?? null,
    https_fallback_active: value.https_fallback_active === true,
    websocket_ready: value.websocket_ready === true,
  };
}
