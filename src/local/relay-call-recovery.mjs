// @ts-check

import relayContract from "../shared/relay-contract.json" with { type: "json" };

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
 *   graceMs?: unknown,
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
    /** @type {Map<string, RelayResult>} */
    this.pendingResults = new Map();
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

    // Retain sent results until the Worker commits and acknowledges them.
    this.pendingResults.set(callId, response);
    const sent = this.send(response);
    if (sent) {
      this.logger.event?.("debug", "relay.tool_result.awaiting_ack", {
        call_id: shortCallId(callId), unacknowledged_results: this.pendingResults.size,
      }, "Delivered a tool result and retained it until Worker acknowledgement");
      return true;
    }

    this.scheduleExpiry();
    this.logger.event?.("debug", "relay.tool_result.queued", {
      call_id: shortCallId(callId), queued_results: this.pendingResults.size,
    }, "Queued a completed tool result while the relay reconnects");
    return false;
  }

  /** @param {unknown} callId */
  acknowledge(callId) { return this.pendingResults.delete(String(callId)); }

  /** @param {unknown} callId */
  discard(callId) { return this.pendingResults.delete(String(callId)); }

  /** @param {Iterable<string>} resumedCallIds @param {(callId: string) => boolean} cancelCall */
  reconcile(resumedCallIds, cancelCall) {
    const resumed = new Set(resumedCallIds);
    let cancelled = 0;
    let discarded = 0;
    for (const callId of this.activeCallIds()) {
      if (!resumed.has(callId) && cancelCall(callId)) cancelled += 1;
    }
    for (const callId of [...this.pendingResults.keys()]) {
      if (!resumed.has(callId) && this.pendingResults.delete(callId)) discarded += 1;
    }
    if (cancelled > 0 || discarded > 0) {
      this.logger.event?.("debug", "relay.calls.reconciled", { cancelled_calls: cancelled, discarded_results: discarded },
        "Cancelled relay work that no longer had a waiting client after reconnect");
    }
  }

  disconnected() {
    const activeCalls = [...this.activeCallIds()].length;
    if (activeCalls === 0 && this.pendingResults.size === 0) return;
    this.scheduleExpiry();
    this.logger.event?.("debug", "relay.calls.awaiting_reconnect", {
      active_calls: activeCalls, queued_results: this.pendingResults.size, grace_ms: this.graceMs,
    }, "Keeping in-flight tool calls alive during a brief relay interruption");
  }

  ready() { this.clearTimer(); this.retryUnacknowledged("reconnected"); }

  pulse() {
    this.retryUnacknowledged("heartbeat");
  }

  /** @param {string} reason */
  retryUnacknowledged(reason) {
    let delivered = 0;
    for (const response of this.pendingResults.values()) {
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
        unacknowledged_results: this.pendingResults.size,
      }, "Redelivered completed tool results awaiting Worker acknowledgement");
    }
  }

  stop() {
    this.clearTimer();
    this.pendingResults.clear();
  }

  scheduleExpiry() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      for (const callId of this.activeCallIds()) this.suppressCall(callId, "relay_reconnect_timeout");
      const cancelled = this.cancelOrigin("remote relay reconnect grace expired");
      const discarded = this.pendingResults.size;
      this.pendingResults.clear();
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
}

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/** @param {unknown} value */
function shortCallId(value) {
  const text = String(value || "");
  return text.length <= 18 ? text : `${text.slice(0, 10)}...${text.slice(-5)}`;
}
