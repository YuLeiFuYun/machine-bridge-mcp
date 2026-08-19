// @ts-check

import { clampInteger } from "./numbers.mjs";
import { isPlainRecord } from "./records.mjs";

const CONNECT_STAGES = new Set([
  "socket_constructing", "proxy_connecting", "tcp_connecting", "dns_resolved",
  "tcp_connected", "tls_established", "http_rejected", "websocket_open",
]);
const TRANSPORT_ERROR_REASONS = new Set([
  "unknown", "connection_reset", "connection_refused", "connection_aborted", "connection_timeout",
  "network_unreachable", "host_unreachable", "network_down", "local_address_unavailable", "broken_pipe",
  "dns_not_found", "dns_temporary_failure", "tls_certificate", "tls_protocol", "multi_address_failure",
]);

export function relayHandshakeDiagnostics(value = {}) {
  const status = isPlainRecord(value) ? value : {};
  const heartbeat = isPlainRecord(status.heartbeat) ? status.heartbeat : {};
  return {
    schema_version: 1,
    transport: ["websocket", "https"].includes(status.transport) ? status.transport : "unknown",
    network_route: typeof status.network_route === "string" ? status.network_route : "unresolved",
    connect_timeout_ms: clampInteger(status.connect_timeout_ms, 30_000, 1_000, 10 * 60_000),
    last_connect_stage: typeof status.last_connect_stage === "string" ? status.last_connect_stage : "idle",
    last_connect_duration_ms: clampInteger(status.last_connect_duration_ms, 0, 0, 10 * 60_000),
    last_connect_milestones_ms: connectMilestones(status.last_connect_milestones_ms),
    last_connect_http_status: boundedHttpStatus(status.last_connect_http_status),
    last_failed_connect_stage: CONNECT_STAGES.has(String(status.last_failed_connect_stage || ""))
      ? status.last_failed_connect_stage : null,
    last_failed_connect_duration_ms: clampInteger(status.last_failed_connect_duration_ms, 0, 0, 10 * 60_000),
    last_failed_connect_milestones_ms: connectMilestones(status.last_failed_connect_milestones_ms),
    last_failed_connect_http_status: boundedHttpStatus(status.last_failed_connect_http_status),
    outage_count: clampInteger(status.outage_count, 0, 0, 1_000_000_000),
    outage_active: status.outage_active === true,
    outage_started_at: typeof status.outage_started_at === "string" ? status.outage_started_at : null,
    outage_duration_ms: clampInteger(status.outage_duration_ms, 0, 0, 31 * 24 * 60 * 60_000),
    outage_attempts: clampInteger(status.outage_attempts, 0, 0, 1_000_000),
    last_close_category: typeof status.last_close_category === "string" ? status.last_close_category : null,
    last_close_code: Number.isSafeInteger(status.last_close_code) ? status.last_close_code : null,
    last_transport_error_class: typeof status.last_transport_error_class === "string"
      ? status.last_transport_error_class
      : null,
    last_transport_error_reason: TRANSPORT_ERROR_REASONS.has(String(status.last_transport_error_reason || ""))
      ? status.last_transport_error_reason : "unknown",
    last_transport_error_ready: status.last_transport_error_ready === true,
    last_transport_error_authenticated: status.last_transport_error_authenticated === true,
    last_probe_buffered_bytes: clampInteger(heartbeat.last_probe_buffered_bytes, 0, 0, 64 * 1024 * 1024),
    max_probe_buffered_bytes: clampInteger(heartbeat.max_probe_buffered_bytes, 0, 0, 64 * 1024 * 1024),
    last_probe_dispatch_ms: clampInteger(heartbeat.last_probe_dispatch_ms, 0, 0, 10 * 60_000),
    max_probe_dispatch_ms: clampInteger(heartbeat.max_probe_dispatch_ms, 0, 0, 10 * 60_000),
    last_probe_dispatch_timeout_age_ms: clampInteger(heartbeat.last_probe_dispatch_timeout_age_ms, 0, 0, 10 * 60_000),
    last_probe_timeout_age_ms: clampInteger(heartbeat.last_probe_timeout_age_ms, 0, 0, 10 * 60_000),
    transport_confirmation_dispatch_timeout_ms: clampInteger(heartbeat.transport_confirmation_dispatch_timeout_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_dispatch_ms: clampInteger(heartbeat.last_transport_confirmation_dispatch_ms, 0, 0, 10 * 60_000),
    max_transport_confirmation_dispatch_ms: clampInteger(heartbeat.max_transport_confirmation_dispatch_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_dispatch_timeout_age_ms: clampInteger(heartbeat.last_transport_confirmation_dispatch_timeout_age_ms, 0, 0, 10 * 60_000),
    transport_confirmation_timeout_ms: clampInteger(heartbeat.transport_confirmation_timeout_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_ms: clampInteger(heartbeat.last_transport_confirmation_ms, 0, 0, 10 * 60_000),
    max_transport_confirmation_ms: clampInteger(heartbeat.max_transport_confirmation_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_timeout_age_ms: clampInteger(heartbeat.last_transport_confirmation_timeout_age_ms, 0, 0, 10 * 60_000),
    last_disconnected_at: typeof status.last_disconnected_at === "string" ? status.last_disconnected_at : null,
    previous_ready_duration_ms: clampInteger(status.last_ready_duration_ms, 0, 0, 365 * 24 * 60 * 60_000),
    previous_ready_inbound_silence_ms: clampInteger(status.last_ready_inbound_silence_ms, 0, 0, 31 * 24 * 60 * 60_000),
  };
}

function connectMilestones(value) {
  const source = isPlainRecord(value) ? value : {};
  const out = {};
  for (const key of CONNECT_STAGES) {
    const duration = Number(source[key]);
    if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 10 * 60_000) out[key] = duration;
  }
  return out;
}

function boundedHttpStatus(value) {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}
