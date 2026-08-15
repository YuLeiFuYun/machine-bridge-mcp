export function resourceAdmissionGuardrailSnapshot() {
  return {
    scope: "machine-user-cross-process",
    model: "work-conserving-multi-resource",
    durable_process_group_leases: true,
    priority_aging: true,
    light_operations_bypass: true,
    default_compiler_jobs: 3,
    hard_resource_quota: false,
  };
}

export async function resourceAdmissionDiagnostic(snapshotFunction, classifyError) {
  if (typeof snapshotFunction !== "function") return { snapshot: null, check: null };
  try {
    const snapshot = await snapshotFunction();
    return {
      snapshot,
      check: {
        layer: "local-resource-admission",
        ok: snapshot?.healthy === true,
        pressure_state: snapshot?.pressure?.state || "unknown",
        active_leases: Number(snapshot?.active_leases) || 0,
        active_waiters: Number(snapshot?.waiters?.active) || 0,
      },
    };
  } catch (error) {
    const errorClass = classifyError(error);
    return {
      snapshot: { healthy: false, error_class: errorClass },
      check: { layer: "local-resource-admission", ok: false, error_class: errorClass },
    };
  }
}
