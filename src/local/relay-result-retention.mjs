import { performance } from "node:perf_hooks";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { MAX_CONCURRENT_TOOL_CALLS } from "./execution-limits.mjs";
const MAX_ACK_RETENTION_MS = relayContract.maximumRelayToolTimeoutMs;
const MAX_RETAINED_RESULTS = MAX_CONCURRENT_TOOL_CALLS;
const MAX_RETAINED_RESULTS_WITH_EMERGENCY_SLOT = MAX_RETAINED_RESULTS + 1;
export class RelayResultRetention {
  #entries = new Map();
  #retainedAt = new Map();
  constructor({ logger = {}, now = () => performance.now(), onOwnershipLost = (_callId) => {} } = {}) {
    this.logger = logger;
    this.now = now;
    this.onOwnershipLost = onOwnershipLost;
  }
  get size() { return this.#entries.size; }
  has(callId) { return this.#entries.has(String(callId || "")); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  retain(callId, response, { emergency = false } = {}) {
    const key = String(callId || "");
    const maximum = emergency ? MAX_RETAINED_RESULTS_WITH_EMERGENCY_SLOT : MAX_RETAINED_RESULTS;
    if (!this.#entries.has(key) && this.#entries.size >= maximum) return false;
    this.#entries.set(key, response);
    if (!this.#retainedAt.has(key)) this.#retainedAt.set(key, this.now());
    return true;
  }
  retainForDelivery(callId, response) {
    if (this.retain(callId, response)) return "normal";
    if (!this.retain(callId, response, { emergency: true })) {
      this.onOwnershipLost(callId);
      this.logger.event?.("error", "relay.tool_result.retention_capacity", {
        retained_results: this.size, emergency_slot_available: false,
      }, "Relay result recovery capacity invariant failed after the emergency retention slot was already occupied");
      return "full";
    }
    this.logger.event?.("error", "relay.tool_result.retention_capacity", {
      retained_results: this.size, emergency_slot_used: true,
    }, "Relay result recovery capacity invariant failed; retained the completed result in the emergency ownership slot without losing call ownership");
    return "emergency";
  }
  delete(callId) {
    const key = String(callId || "");
    this.#retainedAt.delete(key);
    return this.#entries.delete(key);
  }
  #clear() { this.#retainedAt.clear(); this.#entries.clear(); }
  discardAll() {
    const discarded = this.size;
    for (const callId of this.#entries.keys()) this.onOwnershipLost(callId);
    this.#clear();
    return discarded;
  }
  pruneExpired() {
    const cutoff = this.now() - MAX_ACK_RETENTION_MS;
    let expired = 0;
    for (const [callId, retainedAt] of this.#retainedAt) {
      if (retainedAt > cutoff || !this.#entries.has(callId)) continue;
      this.onOwnershipLost(callId);
      this.delete(callId); expired += 1;
    }
    if (expired > 0) this.logger.event?.("warn", "relay.tool_results.ack_expired", {
      expired_results: expired, acknowledgement_retention_ms: MAX_ACK_RETENTION_MS,
    }, "Discarded completed relay results after the Worker acknowledgement lifetime expired");
    return expired;
  }
}
