import { toolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import {
  CONTROL_PLANE_TOOL_NAMES, MAX_CONCURRENT_TOOL_CALLS, RESERVED_CONTROL_TOOL_CALLS,
} from "./execution-limits.mjs";

export const RELAY_RECOVERY_CAPACITY = toolCallCapacityConfig(
  MAX_CONCURRENT_TOOL_CALLS,
  RESERVED_CONTROL_TOOL_CALLS,
  CONTROL_PLANE_TOOL_NAMES,
);
const RETAINED_RESULT_TOOL = "__relay_retained_result__";

export function relayRecoveryCapacityInput(activeTools, retainedResults) {
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

export function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
