const RETRYABLE_COORDINATOR_BUSY_CODES = new Set(["MBM_RESOURCE_TRANSACTION_BUSY", "MBM_RESOURCE_STAGING_BUSY"]);

export function resourceAdmissionDiagnosticError(error, classifyError) {
  if (RETRYABLE_COORDINATOR_BUSY_CODES.has(String(error?.code || ""))) {
    const busy = {
      snapshot_available: false,
      retryable: true,
      error_class: "unavailable",
      reason: "coordinator_busy",
    };
    return {
      snapshot: { healthy: false, ...busy },
      check: { layer: "local-resource-admission", ok: false, ...busy },
    };
  }
  const errorClass = classifyError(error);
  return {
    snapshot: { healthy: false, error_class: errorClass },
    check: { layer: "local-resource-admission", ok: false, error_class: errorClass },
  };
}
