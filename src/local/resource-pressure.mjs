import { resourceDiskHardFloorBytes, resourceDiskSoftFloorBytes } from "./resource-disk-headroom.mjs";

export function resourcePressureState(host, used) {
  const cores = Math.max(1, Number(host?.cpu_cores) || 1);
  const reasons = [];
  const criticalReasons = [];
  let level = 0;
  const mark = (next, reason) => {
    if (next > level) level = next;
    reasons.push(reason);
    if (next === 2) criticalReasons.push(reason);
  };
  if (host?.thermal_warning === true) mark(2, "thermal_warning");
  thresholdPressure(optionalResourceNumber(host?.memory_free_percent), { critical: 8, warning: 18, lowerIsWorse: true }, mark, "memory_pressure");
  thresholdPressure(optionalResourceNumber(host?.disk_mb_per_s), { critical: 220, warning: 100 }, mark, "disk_throughput");
  thresholdPressure(optionalResourceNumber(host?.disk_iops), { critical: 5000, warning: 2500 }, mark, "disk_iops");
  thresholdPressure(optionalResourceNumber(host?.pageouts_per_s), { critical: 1024, warning: 256 }, mark, "pageout_rate");
  thresholdPressure(optionalResourceNumber(host?.swapouts_per_s), { critical: 512, warning: 128 }, mark, "swapout_rate");
  markDiskHeadroom(host, mark);
  markPsiPressure(host, mark);
  markCpuLoadPressure(host, cores, mark);
  if (used.heavy_leases > cores * 2) mark(1, "heavy_root_count");
  return { state: level === 2 ? "red" : level === 1 ? "yellow" : "green", reasons, critical_reasons: criticalReasons };
}

export function optionalResourceNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function markDiskHeadroom(host, mark) {
  const free = optionalResourceNumber(host?.disk_free_bytes); const total = optionalResourceNumber(host?.disk_total_bytes);
  if (free === null || total === null || total <= 0) return;
  const hardFloor = resourceDiskHardFloorBytes(total); const softFloor = resourceDiskSoftFloorBytes(total);
  if (free < hardFloor) mark(2, "disk_free_headroom_critical");
  else if (free < softFloor) mark(1, "disk_free_headroom");
}

function markPsiPressure(host, mark) {
  const memoryFull = optionalResourceNumber(host?.psi_memory_full_avg10);
  thresholdPressure(memoryFull, { critical: 60, warning: 10 }, mark, "psi_memory_full");
  for (const [value, reason] of [
    [host?.psi_cpu_some_avg10, "psi_cpu_some"], [host?.psi_memory_some_avg10, "psi_memory_some"],
    [host?.psi_io_some_avg10, "psi_io_some"], [host?.psi_io_full_avg10, "psi_io_full"],
  ]) if ((optionalResourceNumber(value) ?? 0) >= 10) mark(1, reason);
}

function markCpuLoadPressure(host, cores, mark) {
  const cpu = optionalResourceNumber(host?.cpu_busy_cores); const load = optionalResourceNumber(host?.load1);
  const ioMb = optionalResourceNumber(host?.disk_mb_per_s); const iops = optionalResourceNumber(host?.disk_iops);
  if (cpu !== null && cpu >= cores * 0.9) mark(1, "cpu_busy");
  if (load === null) return;
  const psiBacklog = [host?.psi_cpu_some_avg10, host?.psi_memory_some_avg10, host?.psi_io_some_avg10, host?.psi_io_full_avg10]
    .some((value) => (optionalResourceNumber(value) ?? 0) >= 10);
  const corroborated = (cpu ?? 0) >= cores * 0.70 || (ioMb ?? 0) >= 50 || (iops ?? 0) >= 1250 || psiBacklog;
  if (load >= cores * 1.25 && (host?.platform !== "darwin" || corroborated)) mark(1, "load_backlog");
  if (load >= cores * 2 && ((cpu ?? 0) >= cores * 0.75 || (ioMb ?? 0) >= 100 || (iops ?? 0) >= 2500)) mark(2, "load_backlog_critical");
}

function thresholdPressure(value, thresholds, mark, label) {
  if (value === null) return;
  const critical = thresholds.lowerIsWorse ? value < thresholds.critical : value >= thresholds.critical;
  if (critical) { mark(2, `${label}_critical`); return; }
  const warning = thresholds.lowerIsWorse ? value < thresholds.warning : value >= thresholds.warning;
  if (warning) mark(1, label);
}
