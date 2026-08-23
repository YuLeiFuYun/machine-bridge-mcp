import { MAX_CONCURRENT_TOOL_CALLS } from "./execution-limits.mjs";

const MAX_UNSAFE_CALL_TOMBSTONES = MAX_CONCURRENT_TOOL_CALLS * 4;

export class RelayRedeliverySafety {
  #unsafeCallIds = new Set();
  #globalRedeliveryDisabled = false;

  constructor({ logger = {} } = {}) { this.logger = logger; }

  canProveMissing(callId) {
    const key = String(callId || "");
    return Boolean(key) && !this.#globalRedeliveryDisabled && !this.#unsafeCallIds.has(key);
  }

  observeResumedCallIds(callIds) {
    if (this.#globalRedeliveryDisabled || this.#unsafeCallIds.size === 0) return;
    const resumed = new Set(callIds);
    for (const callId of this.#unsafeCallIds) if (!resumed.has(callId)) this.#unsafeCallIds.delete(callId);
  }

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
