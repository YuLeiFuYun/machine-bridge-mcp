export function diagnosticControlPlaneState(state = {}, relay = null) {
  return {
    observability: { in_flight_calls: state.inFlightCalls ?? null },
    runtime: {
      lifecycle: state.lifecycle ?? null,
      relay,
      processes: state.processes ?? null,
      execution_guardrails: state.executionGuardrails ?? null,
      security_audit: state.securityAudit ?? null,
    },
  };
}
