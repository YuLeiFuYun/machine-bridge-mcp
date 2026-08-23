import { toolCallAdmission } from "../shared/tool-call-capacity.mjs";
import { RELAY_RECOVERY_CAPACITY, relayRecoveryCapacityInput } from "./relay-recovery-capacity.mjs";

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
