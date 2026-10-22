// @ts-check
import { toolCallCapacityConfig, toolCallAdmission } from "../shared/tool-call-capacity.mjs";
import {
  CONTROL_PLANE_TOOL_NAMES, MAX_CONCURRENT_TOOL_CALLS, RESERVED_CONTROL_TOOL_CALLS,
} from "./execution-limits.mjs";

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
