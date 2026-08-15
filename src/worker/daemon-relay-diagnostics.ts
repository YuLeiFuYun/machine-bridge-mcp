import { sanitizeMetadataText } from "./http.ts";

const NETWORK_ROUTES = new Set([
  "unresolved",
  "application-http-proxy",
  "system-network-stack",
  "invalid-application-proxy-configuration",
]);
const TRANSPORT_ERROR_CLASSES = new Set([
  "cancelled", "timeout", "authentication_failed", "authorization_denied", "policy_denied",
  "invalid_request", "not_found", "conflict", "limit_exceeded", "permission_denied",
  "path_boundary", "network_error", "protocol_error", "unavailable", "integrity_error",
  "execution_failed", "internal_error",
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
  "relay_transport_error",
  "relay_protocol_error",
  "relay_proxy_configuration",
  "invalid_transport_payload",
  "message_too_large",
  "normal_close",
  "unexpected_close",
  "superseded",
]);

export interface DaemonRelayDiagnostics {
  schema_version: 1;
  network_route: string;
  outage_count: number;
  outage_active: boolean;
  outage_started_at: string | null;
  outage_duration_ms: number;
  outage_attempts: number;
  last_close_category: string | null;
  last_close_code: number | null;
  last_transport_error_class: string | null;
  last_disconnected_at: string | null;
  previous_ready_duration_ms: number;
}

export function sanitizeDaemonRelayDiagnostics(value: unknown): DaemonRelayDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1) return undefined;
  return {
    schema_version: 1,
    network_route: enumText(candidate.network_route, NETWORK_ROUTES, "unresolved"),
    outage_count: boundedInteger(candidate.outage_count, 0, 1_000_000_000, 0),
    outage_active: candidate.outage_active === true,
    outage_started_at: timestamp(candidate.outage_started_at),
    outage_duration_ms: boundedInteger(candidate.outage_duration_ms, 0, 31 * 24 * 60 * 60_000, 0),
    outage_attempts: boundedInteger(candidate.outage_attempts, 0, 1_000_000, 0),
    last_close_category: nullableEnum(candidate.last_close_category, CLOSE_CATEGORIES),
    last_close_code: nullableInteger(candidate.last_close_code, 0, 4999),
    last_transport_error_class: nullableEnum(candidate.last_transport_error_class, TRANSPORT_ERROR_CLASSES),
    last_disconnected_at: timestamp(candidate.last_disconnected_at),
    previous_ready_duration_ms: boundedInteger(candidate.previous_ready_duration_ms, 0, 365 * 24 * 60 * 60_000, 0),
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
