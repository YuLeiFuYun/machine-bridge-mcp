// @ts-check
import { toolCallCapacityConfig, toolCallAdmission } from "../../shared/tool-call-capacity.mjs";
import { CONTROL_PLANE_TOOL_NAMES, MAX_CONCURRENT_TOOL_CALLS, RESERVED_CONTROL_TOOL_CALLS } from "../process/execution-limits.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { RelayResultRetention } from "./relay-diagnostics.mjs";
import { positiveInteger, clampInteger } from "../../shared/numbers.mjs";
import { shortCallId, isPlainRecord } from "../../shared/records.mjs";
import { isRemoteDurableProcessTool, remoteDurableProcessTimeoutSeconds } from "../../shared/foreground-timeout.mjs";

const MAX_UNSAFE_CALL_TOMBSTONES = MAX_CONCURRENT_TOOL_CALLS * 4;

const RETAINED_RESULT_TOOL = "__relay_retained_result__";

export const RELAY_RECOVERY_CAPACITY = toolCallCapacityConfig(
  MAX_CONCURRENT_TOOL_CALLS,
  RESERVED_CONTROL_TOOL_CALLS,
  CONTROL_PLANE_TOOL_NAMES,
);

/**
 * @param {unknown} value
 * @returns {number}
 */
export function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/**
 * @param {Iterable<unknown> | null | undefined} activeTools
 * @param {unknown} retainedResults
 */
export function relayRecoveryCapacityInput(activeTools, retainedResults) {
  /** @type {Record<string, number>} */
  const byTool = Object.create(null);
  const retained = nonNegativeInteger(retainedResults);
  let active = retained;
  if (retained) byTool[RETAINED_RESULT_TOOL] = retained;
  for (const value of activeTools || []) {
    const tool = String(value || "");
    byTool[tool] = (byTool[tool] || 0) + 1;
    active += 1;
  }
  return { active, byTool, retained };
}

/**
 * @param {Iterable<unknown> | null | undefined} activeTools
 * @param {unknown} retainedResults
 * @param {boolean} [automaticRedeliverySafe]
 * @param {unknown} [unsafeCallTombstones]
 * @param {boolean} [globalRedeliveryDisabled]
 */
export function relayRecoveryCapacitySnapshot(activeTools, retainedResults, automaticRedeliverySafe = true, unsafeCallTombstones = 0, globalRedeliveryDisabled = false) {
  const { active, byTool, retained } = relayRecoveryCapacityInput(activeTools, retainedResults);
  const usage = toolCallAdmission({ active, byTool }, RELAY_RECOVERY_CAPACITY, "diagnose_runtime");
  return Object.freeze({
    active_calls: active - retained,
    retained_results: retained,
    active_ownership: active,
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_control_capacity: usage.reserved,
    automatic_redelivery_safe: automaticRedeliverySafe !== false,
    unsafe_call_tombstones: nonNegativeInteger(unsafeCallTombstones),
    global_redelivery_disabled: globalRedeliveryDisabled === true,
  });
}

/**
 * @param {Iterable<unknown>} activeTools
 * @param {{ redeliverySafetySnapshot: () => { automaticRedeliverySafe: boolean, unsafeCallTombstones: number, globalRedeliveryDisabled: boolean }, retainedResultCount: () => number }} recovery
 */
export function relayRecoveryRuntimeSnapshot(activeTools, recovery) {
  const safety = recovery.redeliverySafetySnapshot();
  return relayRecoveryCapacitySnapshot(
    activeTools, recovery.retainedResultCount(), safety.automaticRedeliverySafe,
    safety.unsafeCallTombstones, safety.globalRedeliveryDisabled,
  );
}

/** @param {any} activeTools @param {any} retainedResults @param {unknown} toolName @param {unknown} callId */
export function relayRecoveryCapacityRejection(activeTools, retainedResults, toolName, callId) {
  const { active, byTool } = relayRecoveryCapacityInput(activeTools, retainedResults);
  const decision = toolCallAdmission({ active, byTool }, RELAY_RECOVERY_CAPACITY, String(toolName || ""));
  if (decision.allowed) return null;
  return Object.freeze({
    type: "tool_result",
    id: String(callId || ""),
    ok: false,
    error: Object.freeze({
      code: "limit_exceeded",
      message: "relay result-recovery capacity is occupied; retry after prior calls settle",
      retryable: true,
      details: Object.freeze({ side_effects_started: false, capacity_scope: "relay_result_recovery" }),
    }),
  });
}

/**
 * @typedef {{ event?: (level: string, name: string, fields: Record<string, unknown>, message: string) => void }} RedeliveryLogger
 */

export class RelayRedeliverySafety {
  /** @type {Set<string>} */
  #unsafeCallIds = new Set();
  #globalRedeliveryDisabled = false;

  /** @param {{ logger?: RedeliveryLogger }} [options] */
  constructor({ logger = {} } = {}) {
    /** @type {RedeliveryLogger} */
    this.logger = logger;
  }

  /** @param {unknown} callId */
  canProveMissing(callId) {
    const key = String(callId || "");
    return Boolean(key) && !this.#globalRedeliveryDisabled && !this.#unsafeCallIds.has(key);
  }

  /** @param {Iterable<string>} callIds */
  observeResumedCallIds(callIds) {
    if (this.#globalRedeliveryDisabled || this.#unsafeCallIds.size === 0) return;
    const resumed = new Set(callIds);
    for (const callId of this.#unsafeCallIds) if (!resumed.has(callId)) this.#unsafeCallIds.delete(callId);
  }

  /** @param {unknown} callId */
  markUnsafe(callId) {
    const key = String(callId || "");
    if (!key || this.#globalRedeliveryDisabled || this.#unsafeCallIds.has(key)) return;
    if (this.#unsafeCallIds.size >= MAX_UNSAFE_CALL_TOMBSTONES) {
      this.#unsafeCallIds.clear();
      this.#globalRedeliveryDisabled = true;
      this.logger.event?.("error", "relay.tool_result.unsafe_tombstone_capacity", {
        maximum: MAX_UNSAFE_CALL_TOMBSTONES,
      }, "Relay result loss exceeded bounded per-call replay-safety evidence; disabled automatic missing-call redelivery globally");
      return;
    }
    this.#unsafeCallIds.add(key);
  }

  snapshot() {
    return Object.freeze({
      automaticRedeliverySafe: !this.#globalRedeliveryDisabled && this.#unsafeCallIds.size === 0,
      unsafeCallTombstones: this.#unsafeCallIds.size,
      globalRedeliveryDisabled: this.#globalRedeliveryDisabled,
    });
  }
}
/** @typedef {{id?: unknown, [key: string]: unknown}} RelayResult */
/** @typedef {{event?: (level: string, name: string, fields: Record<string, unknown>, message: string) => void, warn?: (message: string) => void}} RecoveryLogger */
/** @typedef {{setTimeout: (callback: () => void, delay: number) => any, clearTimeout: (handle: any) => void}} RecoveryScheduler */
/**
 * @typedef {{
 *   logger?: RecoveryLogger,
 *   send?: (value: RelayResult) => boolean,
 *   isRecoverable?: () => boolean,
 *   activeCallIds?: () => Iterable<string>,
 *   suppressCall?: (callId: string, reason: string) => void,
 *   cancelOrigin?: (reason: string) => number,
 *   terminate?: () => void,
 *   graceMs?: unknown, now?: () => number,
 *   scheduler?: RecoveryScheduler,
 * }} RelayCallRecoveryOptions
 */

const DEFAULT_RECONNECT_GRACE_MS = relayContract.reconnectGraceMs;

export class RelayCallRecovery {
  /** @param {RelayCallRecoveryOptions} [options] */
  constructor(options = {}) {
    /** @type {RecoveryLogger} */
    this.logger = options.logger || { warn: (message) => console.warn(message) };
    this.send = typeof options.send === "function" ? options.send : () => false;
    this.isRecoverable = typeof options.isRecoverable === "function" ? options.isRecoverable : () => false;
    this.activeCallIds = typeof options.activeCallIds === "function" ? options.activeCallIds : () => [];
    this.suppressCall = typeof options.suppressCall === "function" ? options.suppressCall : () => {};
    this.cancelOrigin = typeof options.cancelOrigin === "function" ? options.cancelOrigin : () => 0;
    this.terminate = typeof options.terminate === "function" ? options.terminate : () => {};
    this.graceMs = positiveInteger(options.graceMs, DEFAULT_RECONNECT_GRACE_MS);
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.redeliverySafety = new RelayRedeliverySafety({ logger: this.logger });
    this.resultRetention = new RelayResultRetention({
      logger: this.logger, now: options.now,
      onOwnershipLost: (callId) => this.redeliverySafety.markUnsafe(callId),
    });
    /** @type {any} */
    this.reconnectTimer = null;
  }

  /** @param {RelayResult} response */
  deliver(response) {
    const callId = String(response?.id || "");
    if (!callId) return this.send(response);
    if (!this.isRecoverable()) {
      this.logger.event?.("debug", "relay.tool_result.discarded", {
        call_id: shortCallId(callId), reason: "transport_unavailable",
      }, "Discarded a tool result because the relay is no longer recoverable");
      return false;
    }

    this.resultRetention.pruneExpired();
    const retention = this.resultRetention.retainForDelivery(callId, response);
    if (retention === "full") return false;
    const sent = this.send(response);
    if (sent) {
      this.logger.event?.("debug", "relay.tool_result.awaiting_ack", {
        call_id: shortCallId(callId), unacknowledged_results: this.resultRetention.size,
      }, "Delivered a tool result and retained it until Worker acknowledgement");
      return true;
    }

    this.scheduleExpiry();
    this.logger.event?.("debug", "relay.tool_result.queued", {
      call_id: shortCallId(callId), queued_results: this.resultRetention.size,
    }, "Queued a completed tool result while the relay reconnects");
    return false;
  }

  /** @param {string} callId */ acknowledge(callId) { return this.resultRetention.delete(callId); }
  /** @param {string} callId */ discard(callId) { return this.resultRetention.delete(callId); }
  retainedResultCount() { return this.resultRetention.size; }
  /** @param {string} callId */ hasRetainedResult(callId) { return this.resultRetention.has(callId); }

  ownedCallIds() { return [...new Set([...this.activeCallIds(), ...this.resultRetention.keys()])]; }

  /** @param {Iterable<string>} resumedCallIds @param {(callId: string) => boolean} cancelCall */
  reconcile(resumedCallIds, cancelCall) {
    this.resultRetention.pruneExpired();
    const resumed = new Set(resumedCallIds);
    this.redeliverySafety.observeResumedCallIds(resumed);
    const active = [...this.activeCallIds()];
    const locallyOwned = new Set(this.ownedCallIds());
    const missing = [...resumed].filter((callId) => !locallyOwned.has(callId) && this.redeliverySafety.canProveMissing(callId));
    let cancelled = 0; let discarded = 0;
    for (const callId of active) if (!resumed.has(callId) && cancelCall(callId)) cancelled += 1;
    for (const callId of [...this.resultRetention.keys()]) {
      if (!resumed.has(callId) && this.resultRetention.delete(callId)) discarded += 1;
    }
    if (cancelled > 0 || discarded > 0 || missing.length > 0) this.logger.event?.(
      "debug", "relay.calls.reconciled",
      { cancelled_calls: cancelled, discarded_results: discarded, missing_resumed_calls: missing.length },
      "Reconciled local relay-call ownership against the Worker reconnect set",
    );
    return missing;
  }

  disconnected() {
    const activeCalls = [...this.activeCallIds()].length;
    if (activeCalls === 0 && this.resultRetention.size === 0) return;
    this.scheduleExpiry();
    this.logger.event?.("debug", "relay.calls.awaiting_reconnect", {
      active_calls: activeCalls, queued_results: this.resultRetention.size, grace_ms: this.graceMs,
    }, "Keeping in-flight tool calls alive during a brief relay interruption");
  }

  ready() { this.clearTimer(); this.retryUnacknowledged("reconnected"); }

  pulse() { this.retryUnacknowledged("heartbeat"); }

  /** @param {string} reason */
  retryUnacknowledged(reason) {
    this.resultRetention.pruneExpired();
    let delivered = 0;
    for (const response of this.resultRetention.values()) {
      if (!this.send(response)) {
        this.scheduleExpiry();
        break;
      }
      delivered += 1;
    }
    if (delivered > 0) {
      this.logger.event?.(reason === "reconnected" ? "info" : "debug", "relay.tool_results.redelivered", {
        delivered_results: delivered,
        reason,
        unacknowledged_results: this.resultRetention.size,
      }, "Redelivered completed tool results awaiting Worker acknowledgement");
    }
  }

  stop() {
    this.clearTimer();
    this.resultRetention.discardAll();
  }

  scheduleExpiry() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      for (const callId of this.activeCallIds()) this.suppressCall(callId, "relay_reconnect_timeout");
      const cancelled = this.cancelOrigin("remote relay reconnect grace expired");
      const discarded = this.resultRetention.discardAll();
      if (cancelled > 0) this.terminate();
      if (cancelled > 0 || discarded > 0) {
        const message = `remote relay did not recover within ${this.graceMs / 1000} seconds; cancelled ${cancelled} call(s) and discarded ${discarded} queued result(s)`;
        this.logger.event
          ? this.logger.event("warn", "relay.calls.reconnect_expired", { cancelled_calls: cancelled, discarded_results: discarded, grace_ms: this.graceMs }, message)
          : this.logger.warn?.(message);
      }
    }, this.graceMs);
    this.reconnectTimer?.unref?.();
  }

  clearTimer() {
    if (!this.reconnectTimer) return;
    this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  redeliverySafetySnapshot() { return this.redeliverySafety.snapshot(); }
}
/**
 * @param {{
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   stallThresholdMs?: number,
 *   recoveryGraceMs?: number,
 *   dispatchTimeoutMs?: number,
 * }} [options]
 */
export function normalizeRelayHeartbeatTiming(options = {}) {
  const intervalMs = positiveInteger(options.intervalMs, 25_000);
  const timeoutMs = positiveInteger(options.timeoutMs, 75_000);
  return {
    intervalMs,
    timeoutMs,
    stallThresholdMs: positiveInteger(options.stallThresholdMs, Math.max(1000, Math.floor(intervalMs / 2))),
    recoveryGraceMs: positiveInteger(options.recoveryGraceMs, Math.max(intervalMs, Math.min(timeoutMs, 30_000))),
    dispatchTimeoutMs: positiveInteger(options.dispatchTimeoutMs, Math.max(30_000, timeoutMs * 3)),
  };
}

export { positiveInteger };
const CONNECT_STAGES = new Set([
  "socket_constructing", "proxy_connecting", "tcp_connecting", "dns_resolved",
  "tcp_connected", "tls_established", "http_rejected", "websocket_open",
]);

const TRANSPORT_ERROR_REASONS = new Set([
  "unknown", "connection_reset", "connection_refused", "connection_aborted", "connection_timeout",
  "network_unreachable", "host_unreachable", "network_down", "local_address_unavailable", "broken_pipe",
  "dns_not_found", "dns_temporary_failure", "tls_certificate", "tls_protocol", "multi_address_failure",
]);

const RECENT_RELAY_OUTAGE_LIMIT = 8;

/**
 * Clamp a duration that may be reported as a high-resolution float.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 */
function clampDuration(value, fallback, minimum, maximum) {
  const number = typeof value === "number" ? value : Number(value);
  const rounded = Number.isFinite(number) ? Math.round(number) : fallback;
  return clampInteger(rounded, fallback, minimum, maximum);
}

/** @param {unknown} value */
export function relayHandshakeDiagnostics(value = {}) {
  const status = isPlainRecord(value) ? value : {};
  const heartbeat = isPlainRecord(status.heartbeat) ? status.heartbeat : {};
  return {
    schema_version: 1,
    transport: typeof status.transport === "string" && ["websocket", "https"].includes(status.transport) ? status.transport : "unknown",
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
    probe_dispatch_pending_at_start: status.probe_dispatch_pending_at_start === true,
    probe_dispatch_age_ms_at_start: clampInteger(status.probe_dispatch_age_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
    probe_outstanding_at_start: status.probe_outstanding_at_start === true,
    probe_age_ms_at_start: clampInteger(status.probe_age_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
    transport_confirmation_pending_at_start: status.transport_confirmation_pending_at_start === true,
    application_inbound_silence_ms_at_start: clampInteger(status.application_inbound_silence_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
    recent_outages: recentOutages(status.recent_outages),
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
    last_probe_dispatch_ms: clampDuration(heartbeat.last_probe_dispatch_ms, 0, 0, 10 * 60_000),
    max_probe_dispatch_ms: clampDuration(heartbeat.max_probe_dispatch_ms, 0, 0, 10 * 60_000),
    last_probe_dispatch_timeout_age_ms: clampDuration(heartbeat.last_probe_dispatch_timeout_age_ms, 0, 0, 10 * 60_000),
    last_probe_timeout_age_ms: clampDuration(heartbeat.last_probe_timeout_age_ms, 0, 0, 10 * 60_000),
    transport_confirmation_dispatch_timeout_ms: clampDuration(heartbeat.transport_confirmation_dispatch_timeout_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_dispatch_ms: clampDuration(heartbeat.last_transport_confirmation_dispatch_ms, 0, 0, 10 * 60_000),
    max_transport_confirmation_dispatch_ms: clampDuration(heartbeat.max_transport_confirmation_dispatch_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_dispatch_timeout_age_ms: clampDuration(heartbeat.last_transport_confirmation_dispatch_timeout_age_ms, 0, 0, 10 * 60_000),
    transport_confirmation_timeout_ms: clampDuration(heartbeat.transport_confirmation_timeout_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_ms: clampDuration(heartbeat.last_transport_confirmation_ms, 0, 0, 10 * 60_000),
    max_transport_confirmation_ms: clampDuration(heartbeat.max_transport_confirmation_ms, 0, 0, 10 * 60_000),
    last_transport_confirmation_timeout_age_ms: clampDuration(heartbeat.last_transport_confirmation_timeout_age_ms, 0, 0, 10 * 60_000),
    last_disconnected_at: typeof status.last_disconnected_at === "string" ? status.last_disconnected_at : null,
    previous_ready_duration_ms: clampDuration(status.last_ready_duration_ms, 0, 0, 365 * 24 * 60 * 60_000),
    previous_ready_inbound_silence_ms: clampDuration(status.last_ready_inbound_silence_ms, 0, 0, 31 * 24 * 60 * 60_000),
    https_fallback_last_takeover_ms: clampDuration(status.https_fallback_last_takeover_ms, 0, 0, 10 * 60_000),
    https_fallback_last_takeover_outage_number: clampInteger(status.https_fallback_last_takeover_outage_number, 0, 0, 1_000_000_000),
  };
}

/** @param {unknown} value */
function recentOutages(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const candidate of value.slice(0, RECENT_RELAY_OUTAGE_LIMIT)) {
    if (!isPlainRecord(candidate)) continue;
    const outageNumber = Number(candidate.outage_number);
    if (!Number.isSafeInteger(outageNumber) || outageNumber < 1 || outageNumber > 1_000_000_000) continue;
    const fallbackTakenOver = candidate.https_fallback_taken_over === true;
    result.push({
      outage_number: outageNumber,
      disconnected_at: boundedTimestamp(candidate.disconnected_at),
      last_disconnect_at: boundedTimestamp(candidate.last_disconnect_at),
      ready_at: boundedTimestamp(candidate.ready_at),
      duration_ms: clampDuration(candidate.duration_ms, 0, 0, 31 * 24 * 60 * 60_000),
      https_fallback_taken_over: fallbackTakenOver,
      https_fallback_takeover_ms: fallbackTakenOver
        ? clampDuration(candidate.https_fallback_takeover_ms, 0, 0, 10 * 60_000) : 0,
      attempts: clampInteger(candidate.attempts, 0, 0, 1_000_000),
      close_category: typeof candidate.close_category === "string" ? candidate.close_category.slice(0, 128) : null,
      close_code: typeof candidate.close_code === "number" && Number.isSafeInteger(candidate.close_code) && candidate.close_code >= 0 && candidate.close_code <= 4999
        ? candidate.close_code : null,
      network_route: typeof candidate.network_route === "string" ? candidate.network_route.slice(0, 128) : "unresolved",
      last_transport_error_class: typeof candidate.last_transport_error_class === "string"
        ? candidate.last_transport_error_class.slice(0, 128) : null,
      last_transport_error_reason: TRANSPORT_ERROR_REASONS.has(String(candidate.last_transport_error_reason || ""))
        ? candidate.last_transport_error_reason : "unknown",
      last_transport_error_ready: candidate.last_transport_error_ready === true,
      last_transport_error_authenticated: candidate.last_transport_error_authenticated === true,
      previous_ready_duration_ms: clampDuration(candidate.previous_ready_duration_ms, 0, 0, 365 * 24 * 60 * 60_000),
      previous_ready_inbound_silence_ms: clampDuration(candidate.previous_ready_inbound_silence_ms, 0, 0, 31 * 24 * 60 * 60_000),
      probe_dispatch_pending_at_start: candidate.probe_dispatch_pending_at_start === true,
      probe_dispatch_age_ms_at_start: clampDuration(candidate.probe_dispatch_age_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
      probe_outstanding_at_start: candidate.probe_outstanding_at_start === true,
      probe_age_ms_at_start: clampDuration(candidate.probe_age_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
      transport_confirmation_pending_at_start: candidate.transport_confirmation_pending_at_start === true,
      application_inbound_silence_ms_at_start: clampDuration(candidate.application_inbound_silence_ms_at_start, 0, 0, 31 * 24 * 60 * 60_000),
      last_connect_stage: typeof candidate.last_connect_stage === "string" ? candidate.last_connect_stage.slice(0, 64) : "idle",
      last_connect_duration_ms: clampDuration(candidate.last_connect_duration_ms, 0, 0, 10 * 60_000),
      last_connect_milestones_ms: connectMilestones(candidate.last_connect_milestones_ms),
      last_connect_http_status: boundedHttpStatus(candidate.last_connect_http_status),
      last_failed_connect_stage: CONNECT_STAGES.has(String(candidate.last_failed_connect_stage || ""))
        ? candidate.last_failed_connect_stage : null,
      last_failed_connect_duration_ms: clampDuration(candidate.last_failed_connect_duration_ms, 0, 0, 10 * 60_000),
      last_failed_connect_milestones_ms: connectMilestones(candidate.last_failed_connect_milestones_ms),
      last_failed_connect_http_status: boundedHttpStatus(candidate.last_failed_connect_http_status),
    });
  }
  return result;
}

/** @param {unknown} value */
function boundedTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** @param {unknown} value */
function connectMilestones(value) {
  const source = isPlainRecord(value) ? value : {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of CONNECT_STAGES) {
    const duration = Number(source[key]);
    if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 10 * 60_000) out[key] = duration;
  }
  return out;
}

/** @param {unknown} value */
function boundedHttpStatus(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}
/** @typedef {{context: {origin?: unknown}, tool?: unknown, args?: Record<string, unknown>}} RelayToolOperation */
/** @typedef {{instancePath?: string, keyword?: string}[]} RelaySchemaIssue[] */

/** @param {RelayToolOperation} operation @param {RelaySchemaIssue} issues */
export function validRelayToolSchemaExtension(operation, issues) {
  return validRelayDurableProcessSchemaExtension(operation, issues)
    || validRelayManagedJobReadSchemaExtension(operation, issues);
}

/** @param {RelayToolOperation} operation @param {RelaySchemaIssue} issues */
function validRelayDurableProcessSchemaExtension(operation, issues) {
  if (operation.context.origin !== "relay" || typeof operation.tool !== "string"
      || !isRemoteDurableProcessTool(operation.tool) || !Array.isArray(issues) || !issues.length) {
    return false;
  }
  if (issues.some((issue) => issue?.instancePath !== "/timeout_seconds" || issue?.keyword !== "maximum")) return false;
  try {
    remoteDurableProcessTimeoutSeconds(operation.args?.timeout_seconds);
    return true;
  } catch {
    return false;
  }
}

/** @param {RelayToolOperation} operation @param {RelaySchemaIssue} issues */
function validRelayManagedJobReadSchemaExtension(operation, issues) {
  if (operation.context.origin !== "relay" || operation.tool !== "read_job" || !Array.isArray(issues) || !issues.length) {
    return false;
  }
  if (issues.some((issue) => issue?.instancePath !== "/wait_ms" || issue?.keyword !== "maximum")) return false;
  const waitMs = operation.args?.wait_ms;
  return typeof waitMs === "number" && Number.isInteger(waitMs)
    && waitMs >= 0 && waitMs <= relayContract.maximumManagedJobReadWaitMs;
}
// Convert the bounded public header to a duration once; scheduling uses monotonic time.
/** @param {number} statusCode @param {unknown} value @param {number} [now] @returns {number} */
export function relayRetryAfterMs(statusCode, value, now = Date.now()) {
  if (![429, 503].includes(statusCode) || typeof value !== "string" || value.length > 128) return 0;
  const text = value.trim();
  let delay;
  if (/^[0-9]+$/.test(text)) delay = Number(text) * 1000;
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    delay = Date.parse(text) - now;
  } else return 0;
  return boundedRelayRetryAfterMs(delay);
}

/** @param {unknown} value @returns {number} */
export function boundedRelayRetryAfterMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), relayContract.httpFallbackMaximumRetryAfterMs) : 0;
}

/** @param {number} failures @param {number} base @param {number} maximum @returns {number} */
export function relayFailureBackoffMs(failures, base, maximum) {
  const exponent = Math.min(Math.max(0, failures - 1), 16);
  return Math.min(base * (2 ** exponent), Math.max(base, maximum));
}
