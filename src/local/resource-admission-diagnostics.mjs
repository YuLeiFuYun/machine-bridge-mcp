import { resourceAdmissionDiagnosticError } from "./resource-admission-diagnostic-error.mjs";

const LOGGABLE_ADMISSION_REASONS = new Set([
  "resource_capacity", "project_resource_busy", "host_pressure_red", "disk_reserve_floor",
  "cpu_reservation", "io_reservation", "memory_reservation", "cpu_pressure_window",
  "cpu_request_exceeds_launch_window", "fairness_wait", "coordinator_busy", "resource_busy",
]);
const LOGGABLE_PRESSURE_STATES = new Set(["green", "yellow", "red", "unknown"]);

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

export function resourceAdmissionLogFields(error) {
  if (error?.details?.reason !== "resource_admission") return {};
  const reason = String(error.details.admission_reason || "resource_busy");
  const pressure = String(error.details.pressure_state || "unknown");
  return {
    resource_admission_reason: LOGGABLE_ADMISSION_REASONS.has(reason) ? reason : "resource_busy",
    resource_pressure_state: LOGGABLE_PRESSURE_STATES.has(pressure) ? pressure : "unknown",
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
        fairness_drain_active: snapshot?.waiters?.drain_active === true,
      },
    };
  } catch (error) {
    return resourceAdmissionDiagnosticError(error, classifyError);
  }
}
