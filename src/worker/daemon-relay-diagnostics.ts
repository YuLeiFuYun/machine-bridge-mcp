import { sanitizeMetadataText } from "./http.ts";

const NETWORK_ROUTES = new Set([
  "unresolved",
  "application-http-proxy",
  "system-network-stack",
  "invalid-application-proxy-configuration",
]);
const TRANSPORTS = new Set(["websocket", "https"]);
const CONNECT_STAGES = new Set([
  "idle", "socket_constructing", "proxy_connecting", "tcp_connecting", "dns_resolved",
  "tcp_connected", "tls_established", "http_rejected", "websocket_open",
]);
const TRANSPORT_ERROR_CLASSES = new Set([
  "cancelled", "timeout", "authentication_failed", "authorization_denied", "policy_denied",
  "invalid_request", "not_found", "conflict", "limit_exceeded", "permission_denied",
  "path_boundary", "network_error", "protocol_error", "unavailable", "integrity_error",
  "execution_failed", "internal_error",
]);
const TRANSPORT_ERROR_REASONS = new Set([
  "unknown", "connection_reset", "connection_refused", "connection_aborted", "connection_timeout",
  "network_unreachable", "host_unreachable", "network_down", "local_address_unavailable", "broken_pipe",
  "dns_not_found", "dns_temporary_failure", "tls_certificate", "tls_protocol", "multi_address_failure",
]);
const CLOSE_CATEGORIES = new Set([
  "connection_interrupted",
  "local_authority_revocation_retry",
  "relay_restarting_or_unavailable",
  "relay_policy_rejected",
  "relay_internal_error",
  "relay_protocol_mismatch",
  "relay_authentication_failed",
  "relay_connect_timeout",
  "relay_handshake_timeout",
  "relay_readiness_timeout",
  "relay_heartbeat_timeout",
  "relay_transport_timeout",
  "relay_transport_send_timeout",
  "relay_transport_error",
  "relay_protocol_error",
  "relay_proxy_configuration",
  "relay_device_session_expired",
  "invalid_transport_payload",
  "message_too_large",
  "normal_close",
  "unexpected_close",
  "superseded",
]);

export interface DaemonRelayDiagnostics {
  schema_version: 1;
  transport: string;
  network_route: string;
  connect_timeout_ms: number;
  last_connect_stage: string;
  last_connect_duration_ms: number;
  last_connect_milestones_ms: Record<string, number>;
  last_connect_http_status: number | null;
  last_failed_connect_stage: string | null;
  last_failed_connect_duration_ms: number;
  last_failed_connect_milestones_ms: Record<string, number>;
  last_failed_connect_http_status: number | null;
  outage_count: number;
  outage_active: boolean;
  outage_started_at: string | null;
  outage_duration_ms: number;
  outage_attempts: number;
  last_close_category: string | null;
  last_close_code: number | null;
  last_transport_error_class: string | null;
  last_transport_error_reason: string;
  last_transport_error_ready: boolean;
  last_transport_error_authenticated: boolean;
  last_probe_buffered_bytes: number;
  max_probe_buffered_bytes: number;
  last_probe_dispatch_ms: number;
  max_probe_dispatch_ms: number;
  last_probe_dispatch_timeout_age_ms: number;
  last_probe_timeout_age_ms: number;
  transport_confirmation_dispatch_timeout_ms: number;
  last_transport_confirmation_dispatch_ms: number;
  max_transport_confirmation_dispatch_ms: number;
  last_transport_confirmation_dispatch_timeout_age_ms: number;
  transport_confirmation_timeout_ms: number;
  last_transport_confirmation_ms: number;
  max_transport_confirmation_ms: number;
  last_transport_confirmation_timeout_age_ms: number;
  last_disconnected_at: string | null;
  previous_ready_duration_ms: number;
  previous_ready_inbound_silence_ms: number;
  https_fallback_last_takeover_ms: number;
}

export function sanitizeDaemonRelayDiagnostics(value: unknown): DaemonRelayDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1) return undefined;
  return {
    schema_version: 1,
    transport: enumText(candidate.transport, TRANSPORTS, "websocket"),
    network_route: enumText(candidate.network_route, NETWORK_ROUTES, "unresolved"),
    connect_timeout_ms: boundedInteger(candidate.connect_timeout_ms, 1_000, 10 * 60_000, 30_000),
    last_connect_stage: enumText(candidate.last_connect_stage, CONNECT_STAGES, "idle"),
    last_connect_duration_ms: boundedInteger(candidate.last_connect_duration_ms, 0, 10 * 60_000, 0),
    last_connect_milestones_ms: connectMilestones(candidate.last_connect_milestones_ms),
    last_connect_http_status: nullableInteger(candidate.last_connect_http_status, 100, 599),
    last_failed_connect_stage: nullableEnum(candidate.last_failed_connect_stage, CONNECT_STAGES),
    last_failed_connect_duration_ms: boundedInteger(candidate.last_failed_connect_duration_ms, 0, 10 * 60_000, 0),
    last_failed_connect_milestones_ms: connectMilestones(candidate.last_failed_connect_milestones_ms),
    last_failed_connect_http_status: nullableInteger(candidate.last_failed_connect_http_status, 100, 599),
    outage_count: boundedInteger(candidate.outage_count, 0, 1_000_000_000, 0),
    outage_active: candidate.outage_active === true,
    outage_started_at: timestamp(candidate.outage_started_at),
    outage_duration_ms: boundedInteger(candidate.outage_duration_ms, 0, 31 * 24 * 60 * 60_000, 0),
    outage_attempts: boundedInteger(candidate.outage_attempts, 0, 1_000_000, 0),
    last_close_category: nullableEnum(candidate.last_close_category, CLOSE_CATEGORIES),
    last_close_code: nullableInteger(candidate.last_close_code, 0, 4999),
    last_transport_error_class: nullableEnum(candidate.last_transport_error_class, TRANSPORT_ERROR_CLASSES),
    last_transport_error_reason: enumText(candidate.last_transport_error_reason, TRANSPORT_ERROR_REASONS, "unknown"),
    last_transport_error_ready: candidate.last_transport_error_ready === true,
    last_transport_error_authenticated: candidate.last_transport_error_authenticated === true,
    last_probe_buffered_bytes: boundedInteger(candidate.last_probe_buffered_bytes, 0, 64 * 1024 * 1024, 0),
    max_probe_buffered_bytes: boundedInteger(candidate.max_probe_buffered_bytes, 0, 64 * 1024 * 1024, 0),
    last_probe_dispatch_ms: boundedInteger(candidate.last_probe_dispatch_ms, 0, 10 * 60_000, 0),
    max_probe_dispatch_ms: boundedInteger(candidate.max_probe_dispatch_ms, 0, 10 * 60_000, 0),
    last_probe_dispatch_timeout_age_ms: boundedInteger(candidate.last_probe_dispatch_timeout_age_ms, 0, 10 * 60_000, 0),
    last_probe_timeout_age_ms: boundedInteger(candidate.last_probe_timeout_age_ms, 0, 10 * 60_000, 0),
    transport_confirmation_dispatch_timeout_ms: boundedInteger(candidate.transport_confirmation_dispatch_timeout_ms, 0, 10 * 60_000, 0),
    last_transport_confirmation_dispatch_ms: boundedInteger(candidate.last_transport_confirmation_dispatch_ms, 0, 10 * 60_000, 0),
    max_transport_confirmation_dispatch_ms: boundedInteger(candidate.max_transport_confirmation_dispatch_ms, 0, 10 * 60_000, 0),
    last_transport_confirmation_dispatch_timeout_age_ms: boundedInteger(candidate.last_transport_confirmation_dispatch_timeout_age_ms, 0, 10 * 60_000, 0),
    transport_confirmation_timeout_ms: boundedInteger(candidate.transport_confirmation_timeout_ms, 0, 10 * 60_000, 0),
    last_transport_confirmation_ms: boundedInteger(candidate.last_transport_confirmation_ms, 0, 10 * 60_000, 0),
    max_transport_confirmation_ms: boundedInteger(candidate.max_transport_confirmation_ms, 0, 10 * 60_000, 0),
    last_transport_confirmation_timeout_age_ms: boundedInteger(candidate.last_transport_confirmation_timeout_age_ms, 0, 10 * 60_000, 0),
    last_disconnected_at: timestamp(candidate.last_disconnected_at),
    previous_ready_duration_ms: boundedInteger(candidate.previous_ready_duration_ms, 0, 365 * 24 * 60 * 60_000, 0),
    previous_ready_inbound_silence_ms: boundedInteger(candidate.previous_ready_inbound_silence_ms, 0, 31 * 24 * 60 * 60_000, 0),
    https_fallback_last_takeover_ms: boundedInteger(candidate.https_fallback_last_takeover_ms, 0, 10 * 60_000, 0),
  };
}

function enumText(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return allowed.has(text) ? text : fallback;
}

function nullableEnum(value: unknown, allowed: Set<string>): string | null {
  const text = typeof value === "string" ? value : "";
  return allowed.has(text) ? text : null;
}

export function relayDiagnosticsAfterReady(
  value: DaemonRelayDiagnostics | undefined,
  readyAt?: string,
): DaemonRelayDiagnostics | undefined {
  if (!value) return undefined;
  const started = Date.parse(value.outage_started_at ?? "");
  const ready = Date.parse(readyAt ?? "");
  const elapsed = Number.isFinite(started) && Number.isFinite(ready) ? Math.max(0, ready - started) : 0;
  return {
    ...value,
    outage_active: false,
    outage_duration_ms: Math.min(31 * 24 * 60 * 60_000, Math.max(value.outage_duration_ms, elapsed)),
  };
}

function timestamp(value: unknown): string | null {
  const text = sanitizeMetadataText(value, 64);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function connectMilestones(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of CONNECT_STAGES) {
    const duration = Number(source[key]);
    if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 10 * 60_000) result[key] = duration;
  }
  return result;
}
