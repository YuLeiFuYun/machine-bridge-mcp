import { toolCallAdmission, toolCallCapacityConfig, toolCallCapacityUsage } from "../shared/tool-call-capacity.mjs";
import { BridgeError } from "./errors.mjs";

/** @param {unknown} maximumValue @param {unknown} reservedValue @param {Iterable<string>} [reservedTools] */
export function callCapacityConfig(maximumValue, reservedValue, reservedTools = []) {
  const maximum = Number(maximumValue);
  return toolCallCapacityConfig(
    Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : 16,
    reservedValue,
    reservedTools,
  );
}

/** @param {Map<string, any>} calls @param {ReturnType<typeof callCapacityConfig>} config @param {string} toolName */
export function assertCallCapacity(calls, config, toolName) {
  const decision = toolCallAdmission(callSnapshot(calls), config, toolName);
  if (decision.allowed) return;
  if (decision.reason === "total_capacity") {
    throw new BridgeError("limit_exceeded", `too many concurrent tool calls (${config.maximum})`, { retryable: true });
  }
  throw new BridgeError(
    "limit_exceeded",
    `ordinary tool-call capacity reached (${config.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`,
    { retryable: true },
  );
}

/** @param {Map<string, any>} calls @param {ReturnType<typeof callCapacityConfig>} config */
export function callCapacitySnapshot(calls, config) {
  const usage = toolCallCapacityUsage(callSnapshot(calls), config);
  return {
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_capacity: usage.reserved,
    active_reserved: usage.activeReserved,
    active_ordinary: usage.activeOrdinary,
  };
}

/** @param {Map<string, any>} calls */
function callSnapshot(calls) {
  const byTool = Object.create(null);
  for (const call of calls.values()) byTool[call.tool] = (byTool[call.tool] || 0) + 1;
  return { active: calls.size, byTool };
}
