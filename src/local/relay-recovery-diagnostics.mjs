import { toolCallAdmission } from "../shared/tool-call-capacity.mjs";
import {
  nonNegativeInteger, RELAY_RECOVERY_CAPACITY, relayRecoveryCapacityInput,
} from "./relay-recovery-capacity.mjs";

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

export function relayRecoveryRuntimeSnapshot(activeTools, recovery) {
  const safety = recovery.redeliverySafetySnapshot();
  return relayRecoveryCapacitySnapshot(
    activeTools, recovery.retainedResultCount(), safety.automaticRedeliverySafe,
    safety.unsafeCallTombstones, safety.globalRedeliveryDisabled,
  );
}
