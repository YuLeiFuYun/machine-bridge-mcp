import { aggregateResourceLeases, resourceRequestIncrement, optionalResourceNumber, resourcePressureState } from "./resource-leases.mjs";
import { unobservedResourceCpu } from "./resource-host-window.mjs";
import { resourceDiskHardFloorBytes } from "./resource-metrics.mjs";

const NON_RETRYABLE_ADMISSION_REASONS = new Set(["cpu_request_exceeds_launch_window"]);

export function resourceAdmissionDecisionRetryable(decision) {
  return !NON_RETRYABLE_ADMISSION_REASONS.has(decision?.reason);
}

export function evaluateResourceAdmission(host, leases, request, _now = Date.now(), context = {}) {
  if (!request?.heavy) return { admitted: true, state: "light", reason: "light_bypass" };
  const accounting = context?.accounting || {};
  const cpuCores = Math.max(1, Number(host?.cpu_cores) || 1);
  const totalMemoryMb = Math.max(1024, Number(host?.total_memory_mb) || 1024);
  const used = aggregateResourceLeases(leases, accounting);
  const unobservedCpu = unobservedResourceCpu(leases, accounting, host?.sampled_at_ms);
  const pressure = resourcePressureState(host, used);
  const diskReclaim = isDiskReclaimRequest(request);
  const diskOnlyCritical = diskReclaim && pressure.state === "red"
    && pressure.critical_reasons?.length === 1 && pressure.critical_reasons[0] === "disk_free_headroom_critical";
  const limits = resourceLimits(cpuCores, totalMemoryMb, request.priority, diskOnlyCritical ? "yellow" : pressure.state, pressure.reasons);
  const declared = {
    cpu: request.unbounded ? limits.cpu : Math.max(0, Number(request.cpu) || 0),
    io: Math.max(0, Number(request.io) || 0),
    memory_mb: Math.max(0, Number(request.memory_mb) || 0),
    disk_reserve_bytes: Math.max(0, Number(request.disk_reserve_bytes) || 0),
  };
  const requested = resourceRequestIncrement(leases, { ...request, ...declared, unbounded: false }, accounting);
  const decision = {
    admitted: false, state: pressure.state, reason: "resource_capacity",
    pressure_reasons: pressure.reasons, limits, used, requested, reservation: declared,
    cpu_window: { observed_busy_cores: optionalResourceNumber(host?.cpu_busy_cores), unobserved_reserved_cpu: unobservedCpu },
  };
  const bestCaseCpuLimit = resourceLimits(cpuCores, totalMemoryMb, request.priority, "green").cpu;
  if (!request.unbounded && requested.cpu > bestCaseCpuLimit + 0.25) {
    return { ...decision, reason: "cpu_request_exceeds_launch_window" };
  }
  const ignoredContention = new Set(accounting.ancestorLeaseIds || []);
  if (request.contention_key && leases.some((lease) => lease?.request?.contention_key === request.contention_key
      && !ignoredContention.has(lease?.lease_id))) return { ...decision, reason: "project_resource_busy" };
  if (pressure.state === "red" && !diskOnlyCritical) return { ...decision, reason: "host_pressure_red" };
  if (!diskReclaim && !diskReservationFits(host, used.disk_reserve_bytes, requested.disk_reserve_bytes)) return { ...decision, reason: "disk_reserve_floor" };
  if (used.cpu + requested.cpu > limits.cpu * limits.cpu_overcommit + 0.01) return { ...decision, reason: "cpu_reservation" };
  if (used.io + requested.io > limits.io * limits.io_overcommit + 0.01) return { ...decision, reason: "io_reservation" };
  if (used.memory_mb + requested.memory_mb > limits.memory_mb * limits.memory_overcommit + 1) return { ...decision, reason: "memory_reservation" };
  const currentCpu = Number.isFinite(Number(host?.cpu_busy_cores)) ? Number(host.cpu_busy_cores) : 0;
  if (currentCpu + unobservedCpu + requested.cpu > limits.cpu + 0.25) return { ...decision, reason: "cpu_pressure_window" };
  return { ...decision, admitted: true, reason: diskOnlyCritical ? "admitted_disk_reclaim" : pressure.state === "yellow" ? "admitted_yellow" : "admitted_green" };
}

export function resourcePressureSnapshot(host, leases, priority = "ordinary", _now = Date.now(), accounting = {}, request = null) {
  const cpuCores = Math.max(1, Number(host?.cpu_cores) || 1);
  const totalMemoryMb = Math.max(1024, Number(host?.total_memory_mb) || 1024);
  const used = aggregateResourceLeases(leases, accounting);
  const pressure = resourcePressureState(host, used);
  const observedCpu = optionalResourceNumber(host?.cpu_busy_cores);
  const unobservedCpu = unobservedResourceCpu(leases, accounting, host?.sampled_at_ms);
  const snapshot = { state: pressure.state, reasons: pressure.reasons, used,
    observed: {
      cpu_busy_cores: observedCpu,
      reserved_cpu: used.cpu,
      unobserved_reserved_cpu: unobservedCpu,
      reserved_to_observed_cpu_ratio: observedCpu !== null && observedCpu > 0 ? Math.min(1, used.cpu / observedCpu) : null,
    },
    limits: resourceLimits(cpuCores, totalMemoryMb, priority, pressure.state, pressure.reasons) };
  if (request?.heavy) snapshot.requested = resourceRequestIncrement(leases, request, accounting);
  return snapshot;
}

export function deriveHostRates(current, previous) {
  const result = { ...current };
  const elapsed = (Number(current?.sampled_at_ms) - Number(previous?.sampled_at_ms)) / 1000;
  if (!(elapsed > 0 && elapsed <= 30)) return result;
  for (const [totalKey, rateKey] of [["pageouts_total", "pageouts_per_s"], ["swapouts_total", "swapouts_per_s"]]) {
    const currentValue = Number(current?.[totalKey]); const priorValue = Number(previous?.[totalKey]);
    if (Number.isFinite(currentValue) && Number.isFinite(priorValue) && currentValue >= priorValue) result[rateKey] = (currentValue - priorValue) / elapsed;
  }
  const totalDelta = Number(current?.cpu_time_ms_total) - Number(previous?.cpu_time_ms_total);
  const idleDelta = Number(current?.cpu_idle_ms_total) - Number(previous?.cpu_idle_ms_total);
  const cores = Math.max(1, Number(current?.cpu_cores) || 1);
  if (Number.isFinite(totalDelta) && Number.isFinite(idleDelta) && totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
    result.cpu_busy_cores = Math.max(0, Math.min(cores, cores * (1 - idleDelta / totalDelta)));
  }
  return result;
}

function resourceLimits(cores, totalMemoryMb, priority, state, reasons = []) {
  const headroom = priority === "background" ? 2 : priority === "interactive" ? 1 : 1.5;
  const constrained = state !== "green"; const reasonSet = new Set(reasons);
  const cpuPressure = constrained && (reasonSet.has("cpu_busy") || reasonSet.has("psi_cpu_some"));
  const ioPressure = constrained && [...reasonSet].some((reason) => reason.startsWith("disk_") || reason.startsWith("psi_io_"));
  const memoryPressure = constrained && [...reasonSet].some((reason) =>
    reason.startsWith("memory_pressure") || reason.startsWith("pageout_rate") || reason.startsWith("swapout_rate") || reason.startsWith("psi_memory_"));
  return {
    cpu: Math.max(1, cores - headroom - (cpuPressure ? 1 : 0)),
    io: ioPressure ? 1 : 1.25,
    memory_mb: Math.max(1024, totalMemoryMb * (memoryPressure ? 0.55 : 0.70)),
    cpu_overcommit: cpuPressure ? 1.15 : 1.35,
    io_overcommit: ioPressure ? 1.05 : 1.25,
    memory_overcommit: memoryPressure ? 1.10 : 1.25,
  };
}

function diskReservationFits(host, usedBytes, requestedBytes) {
  const free = Number(host?.disk_free_bytes); const total = Number(host?.disk_total_bytes);
  if (!Number.isFinite(free) || !Number.isFinite(total) || free <= 0 || total <= 0) return true;
  const hardFloor = resourceDiskHardFloorBytes(total);
  return free - usedBytes - requestedBytes >= hardFloor;
}

function isDiskReclaimRequest(request) {
  return request.family === "disk-reclaim" && request.resource_class === "io"
    && request.unbounded === false && request.serialize_project === false
    && Number(request.cpu) <= 0.25 && Number(request.io) <= 0.75
    && Number(request.memory_mb) <= 256 && Number(request.disk_reserve_bytes) === 0;
}
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
const DEFAULT_MINIMUM_WAIT_MS = 2_000;

const DEFAULT_MAXIMUM_WAIT_MS = 10_000;

const REMOTE_PROCESS_SESSION_WAIT_MS = 0;

const MAXIMUM_CONFIGURED_WAIT_MS = 30 * 60_000;

const DEFAULT_TIMEOUT_FRACTION = 0.2;

export function foregroundResourceWaitMs(executionTimeoutMs, configuredWaitMs = undefined) {
  if (configuredWaitMs !== undefined) return configuredResourceWaitMs(configuredWaitMs);
  const timeout = positiveInteger(executionTimeoutMs, "foreground execution timeout");
  const proportional = Math.floor(timeout * DEFAULT_TIMEOUT_FRACTION);
  return Math.min(timeout, DEFAULT_MAXIMUM_WAIT_MS, Math.max(DEFAULT_MINIMUM_WAIT_MS, proportional));
}

export function processSessionResourceWaitMs(configuredWaitMs = undefined, options = {}) {
  if (configuredWaitMs !== undefined) return configuredResourceWaitMs(configuredWaitMs);
  return options.remote === true ? REMOTE_PROCESS_SESSION_WAIT_MS : DEFAULT_MAXIMUM_WAIT_MS;
}

function configuredResourceWaitMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new TypeError("resource wait must be a non-negative finite duration");
  return Math.min(MAXIMUM_CONFIGURED_WAIT_MS, Math.floor(numeric));
}

function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new TypeError(`${label} must be positive`);
  return Math.max(1, Math.floor(numeric));
}
