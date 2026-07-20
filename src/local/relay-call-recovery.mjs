// @ts-check

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

const DEFAULT_RECONNECT_GRACE_MS = 30_000;

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
    if (this.send(response)) {
      if (callId) this.pendingResults.delete(callId);
      return true;
    }
    if (callId && this.isRecoverable()) {
      this.pendingResults.set(callId, response);
      this.scheduleExpiry();
      this.logger.event?.("debug", "relay.tool_result.queued", {
        call_id: shortCallId(callId), queued_results: this.pendingResults.size,
      }, "Queued a completed tool result while the relay reconnects");
      return false;
    }
    this.logger.event?.("debug", "relay.tool_result.discarded", {
      call_id: shortCallId(callId), reason: "transport_unavailable",
    }, "Discarded a tool result because the relay is no longer recoverable");
    return false;
  }

  /** @param {unknown} callId */
  discard(callId) {
    return this.pendingResults.delete(String(callId));
  }

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

  ready() {
    this.clearTimer();
    let delivered = 0;
    for (const [callId, response] of [...this.pendingResults]) {
      if (!this.send(response)) {
        this.scheduleExpiry();
        break;
      }
      this.pendingResults.delete(callId);
      delivered += 1;
    }
    if (delivered > 0) {
      this.logger.event?.("info", "relay.tool_results.replayed", { delivered_results: delivered },
        "Delivered completed tool results after the relay reconnected");
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
      this.terminate();
      if (cancelled > 0 || discarded > 0) {
        this.logger.warn?.(`remote relay did not recover within ${this.graceMs / 1000} seconds; cancelled ${cancelled} call(s) and discarded ${discarded} queued result(s)`);
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
