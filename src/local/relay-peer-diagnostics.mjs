// @ts-check

import { clampInteger } from "./numbers.mjs";
import { isPlainRecord } from "./records.mjs";

export function relayHandshakeDiagnostics(value = {}) {
  const status = isPlainRecord(value) ? value : {};
  return {
    schema_version: 1,
    network_route: typeof status.network_route === "string" ? status.network_route : "unresolved",
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
    last_disconnected_at: typeof status.last_disconnected_at === "string" ? status.last_disconnected_at : null,
    previous_ready_duration_ms: clampInteger(status.last_ready_duration_ms, 0, 0, 365 * 24 * 60 * 60_000),
  };
}
