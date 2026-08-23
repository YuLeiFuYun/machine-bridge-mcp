import { executionGuardrailsSnapshot } from "./execution-limits.mjs";
import { relayRecoveryRuntimeSnapshot } from "./relay-recovery-diagnostics.mjs";

export function runtimeControlPlaneSnapshot(runtime) {
  return {
    lifecycle: runtime.lifecycle.snapshot(),
    inFlightCalls: runtime.callRegistry.snapshot(),
    relayResultRecovery: relayRecoveryRuntimeSnapshot(runtime.activeRelayCalls.values(), runtime.relayCallRecovery),
    processes: runtime.processTracker.snapshot(),
    executionGuardrails: executionGuardrailsSnapshot(),
    securityAudit: runtime.securityAudit.snapshot(),
    idleSleepGuard: runtime.remoteActivityIdleSleepGuard.snapshot(),
  };
}

export function diagnosticControlPlaneState(state = {}, relay = null) {
  return {
    observability: { in_flight_calls: state.inFlightCalls ?? null },
    runtime: {
      lifecycle: state.lifecycle ?? null,
      relay,
      relay_result_recovery: state.relayResultRecovery ?? null,
      processes: state.processes ?? null,
      execution_guardrails: state.executionGuardrails ?? null,
      resource_admission: state.resourceAdmission ?? null,
      security_audit: state.securityAudit ?? null,
      idle_sleep_guard: state.idleSleepGuard ?? null,
    },
  };
}
