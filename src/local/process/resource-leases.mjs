import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeFromSnapshot } from "./identity.mjs";
import { readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { resourceDiskHardFloorBytes, resourceDiskSoftFloorBytes, elasticMemoryJobLimit, elasticMemoryMb } from "./resource-metrics.mjs";

const RESOURCE_KEYS = Object.freeze(["cpu", "io", "memory_mb", "disk_reserve_bytes"]);

export function resourceLeaseAccountingContext(leases, processParents, requesterPid) {
  const empty = { parentByLeaseId: {}, parentLeaseId: null, ancestorLeaseIds: [] };
  if (!processParents || typeof processParents !== "object" || Array.isArray(processParents)) return empty;
  const ownerByPid = new Map();
  for (const lease of leases || []) {
    const id = leaseId(lease); const pid = processOwnerPid(lease);
    if (!id || !pid) continue;
    if (ownerByPid.has(pid)) return empty;
    ownerByPid.set(pid, id);
  }
  const parentByLeaseId = {};
  for (const lease of leases || []) {
    const id = leaseId(lease); const pid = processOwnerPid(lease);
    if (!id || !pid) continue;
    const parent = nearestLease(processParents, ownerByPid, parentPid(processParents, pid), id);
    if (parent) parentByLeaseId[id] = parent;
  }
  if (!validParentForest(leases, parentByLeaseId)) return empty;
  const parentLeaseId = nearestLease(processParents, ownerByPid, normalizePid(requesterPid), null);
  return {
    parentByLeaseId,
    parentLeaseId,
    ancestorLeaseIds: leaseAncestors(parentByLeaseId, parentLeaseId),
  };
}

export function aggregateResourceLeases(leases, accounting = {}) {
  return aggregateEffective(leases || [], accounting.parentByLeaseId || {});
}

export function resourceRequestIncrement(leases, request, accounting = {}) {
  const parentByLeaseId = accounting.parentByLeaseId || {};
  const before = aggregateEffective(leases || [], parentByLeaseId);
  const pendingId = "__pending_resource_request__";
  const pending = { lease_id: pendingId, request };
  const afterParents = { ...parentByLeaseId };
  if (accounting.parentLeaseId) afterParents[pendingId] = accounting.parentLeaseId;
  const after = aggregateEffective([...(leases || []), pending], afterParents);
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, after[key] - before[key])]));
}

function aggregateEffective(leases, parentByLeaseId) {
  const indexed = indexLeases(leases);
  if (!indexed || !validParentForest(leases, parentByLeaseId)) return naiveAggregate(leases);
  const children = new Map([...indexed.keys()].map((id) => [id, []]));
  for (const [child, parent] of Object.entries(parentByLeaseId || {})) {
    if (children.has(child) && children.has(parent)) children.get(parent).push(child);
  }
  const roots = [...indexed.keys()].filter((id) => !parentByLeaseId?.[id] || !indexed.has(parentByLeaseId[id]));
  const memo = new Map();
  const effective = (id) => {
    if (memo.has(id)) return memo.get(id);
    const own = requestVector(indexed.get(id)?.request);
    const childSum = emptyVector();
    for (const child of children.get(id) || []) addVector(childSum, effective(child));
    const value = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(own[key], childSum[key])])) ;
    memo.set(id, value); return value;
  };
  const total = emptyAggregate();
  for (const root of roots) { addVector(total, effective(root)); total.heavy_leases += 1; }
  return total;
}

function indexLeases(leases) {
  const result = new Map();
  for (let index = 0; index < leases.length; index += 1) {
    const lease = leases[index];
    const id = leaseId(lease) || `__anonymous_${index}`;
    if (result.has(id)) return null;
    result.set(id, lease);
  }
  return result;
}

function naiveAggregate(leases) {
  const total = emptyAggregate();
  for (const lease of leases || []) {
    if (lease?.request?.heavy === false) continue;
    addVector(total, requestVector(lease?.request)); total.heavy_leases += 1;
  }
  return total;
}

function validParentForest(leases, parentByLeaseId) {
  const ids = new Set((leases || []).map(leaseId).filter(Boolean));
  for (const start of Object.keys(parentByLeaseId || {})) {
    if (!ids.has(start)) continue;
    const seen = new Set(); let current = start;
    while (current && ids.has(current)) {
      if (seen.has(current)) return false;
      seen.add(current); current = parentByLeaseId[current] || null;
    }
  }
  return true;
}

function nearestLease(parents, ownerByPid, startPid, excludedLeaseId) {
  let pid = normalizePid(startPid); const seen = new Set();
  for (let depth = 0; pid && depth < 2048 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const id = ownerByPid.get(pid);
    if (id && id !== excludedLeaseId) return id;
    pid = parentPid(parents, pid);
  }
  return null;
}

function leaseAncestors(parentByLeaseId, first) {
  const result = []; const seen = new Set(); let current = first;
  while (current && !seen.has(current)) { seen.add(current); result.push(current); current = parentByLeaseId[current] || null; }
  return result;
}

function processOwnerPid(lease) { return lease?.owner?.kind === "process" ? normalizePid(lease.owner.pid) : 0; }

function leaseId(lease) { return typeof lease?.lease_id === "string" && lease.lease_id ? lease.lease_id : null; }

function parentPid(parents, pid) { return normalizePid(parents?.[String(pid)] ?? parents?.[pid]); }

function normalizePid(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0; }

function requestVector(request = {}) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, finite(request[key]))])); }

function finite(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function emptyVector() { return { cpu: 0, io: 0, memory_mb: 0, disk_reserve_bytes: 0 }; }

function emptyAggregate() { return { ...emptyVector(), heavy_leases: 0 }; }

function addVector(target, value) { for (const key of RESOURCE_KEYS) target[key] += value[key] || 0; return target; }
export function resourceLeaseOwnerStatus(lease, processStarts = null) {
  const observedStart = lease.owner.pid === process.pid
    ? currentProcessStartTimeMs()
    : processStartTimeFromSnapshot(processStarts, lease.owner.pid);
  return resourceLeaseOwnerStatusFromStart(lease, observedStart);
}

export function resourceLeaseOwnerStatusFromStart(lease, observedStart = null) {
  return inspectProcessInstance({
    pid: lease.owner.pid,
    startedAt: lease.acquired_at,
    processStartedAt: lease.owner.process_started_at,
  }, { getProcessStartTime: () => observedStart });
}

export function resourceLeaseIsStale(lease, processStarts, now, provisionalTtlMs) {
  const owner = lease.owner;
  const status = resourceLeaseOwnerStatus(lease, processStarts);
  if (owner.kind === "process" && status.reason === "pid_reused") return true;
  if (owner.kind === "process" && owner.process_group_isolated === true && resourceProcessGroupAlive(owner.process_group_id)) return false;
  if (owner.kind === "provisional" && now - Date.parse(lease.acquired_at) > provisionalTtlMs) return true;
  return status.reclaimable === true;
}

export function resourceProcessGroupAlive(value) {
  const pgid = Number(value);
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
export function resourceCoordinatorEvaluator(evaluate, processParents, fallbackPid) {
  return (host, leases, request, now, candidate = null) => evaluate(host, leases, request, now, {
    accounting: resourceLeaseAccountingContext(
      leases, processParents, candidate?.owner?.pid || fallbackPid,
    ),
  });
}

export function resourceCoordinatorAccounting(leases, processParents, requesterPid = 0) {
  const accounting = resourceLeaseAccountingContext(leases, processParents, requesterPid);
  const used = aggregateResourceLeases(leases, accounting);
  return {
    accounting,
    resources: {
      cpu: used.cpu, io: used.io, memory_mb: used.memory_mb,
      disk_reserve_bytes: used.disk_reserve_bytes,
    },
  };
}
const RESOURCE_STATE_READ_ATTEMPTS = 4;

/**
 * Read coordinator state without mutating its link topology. An extra hard link can be an
 * attacker-controlled alias, so a normal read fails closed; only the explicit doctor repair
 * may replace an unattributable link. Directory staging recovery handles the attributable
 * `.tmp` alias before this reader is called.
 */
export function readResourceStateJson(file, maxBytes, label, options = {}) {
  const readFile = options.readFile || readBoundedRegularFileSync;
  for (let attempt = 1; attempt <= RESOURCE_STATE_READ_ATTEMPTS; attempt += 1) {
    try {
      const text = readFile(file, maxBytes, label, {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
      }).toString("utf8");
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      if (options.optional === true && (error?.code === "ENOENT" || error?.cause?.code === "ENOENT")) return null;
      const identityChanged = error?.code === "MBM_IDENTITY_CHANGED" || error?.cause?.code === "MBM_IDENTITY_CHANGED";
      if (!identityChanged || attempt === RESOURCE_STATE_READ_ATTEMPTS) throw error;
    }
  }
  throw new Error(`${label} generation did not settle`);
}
const IO_PRESSURE_FRESH_MS = 5_000;

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
  const io = freshIoPressureSignals(host);
  if ((io.diskMbPerSecond ?? 0) >= 100) mark(1, "disk_throughput");
  if ((io.diskIops ?? 0) >= 2500) mark(1, "disk_iops");
  thresholdPressure(optionalResourceNumber(host?.pageouts_per_s), { critical: 1024, warning: 256 }, mark, "pageout_rate");
  thresholdPressure(optionalResourceNumber(host?.swapouts_per_s), { critical: 512, warning: 128 }, mark, "swapout_rate");
  markDiskHeadroom(host, mark);
  markPsiPressure(host, mark);
  markCpuLoadPressure(host, cores, mark, io);
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
  const ioFull = optionalResourceNumber(host?.psi_io_full_avg10);
  thresholdPressure(memoryFull, { critical: 60, warning: 10 }, mark, "psi_memory_full");
  thresholdPressure(ioFull, { critical: 60, warning: 10 }, mark, "psi_io_full");
  for (const [value, reason] of [
    [host?.psi_cpu_some_avg10, "psi_cpu_some"], [host?.psi_memory_some_avg10, "psi_memory_some"],
    [host?.psi_io_some_avg10, "psi_io_some"],
  ]) if ((optionalResourceNumber(value) ?? 0) >= 10) mark(1, reason);
}

function markCpuLoadPressure(host, cores, mark, io) {
  const cpu = optionalResourceNumber(host?.cpu_busy_cores); const load = optionalResourceNumber(host?.load1);
  const ioMb = io.diskMbPerSecond; const iops = io.diskIops;
  if (cpu !== null && cpu >= cores * 0.9) mark(1, "cpu_busy");
  if (load === null) return;
  const psiBacklog = [host?.psi_cpu_some_avg10, host?.psi_memory_some_avg10, host?.psi_io_some_avg10, host?.psi_io_full_avg10]
    .some((value) => (optionalResourceNumber(value) ?? 0) >= 10);
  const corroborated = (cpu ?? 0) >= cores * 0.70 || (ioMb ?? 0) >= 50 || (iops ?? 0) >= 1250 || psiBacklog;
  if (load >= cores * 1.25 && (host?.platform !== "darwin" || corroborated)) mark(1, "load_backlog");
  if (load >= cores * 2 && ((cpu ?? 0) >= cores * 0.75 || (ioMb ?? 0) >= 100 || (iops ?? 0) >= 2500)) mark(2, "load_backlog_critical");
}

function freshIoPressureSignals(host) {
  if (host?.io_sampled !== true) return { diskMbPerSecond: null, diskIops: null };
  const sampledAt = Number(host?.sampled_at_ms);
  const ioSampledAt = Number(host?.io_sampled_at_ms);
  if (!Number.isFinite(sampledAt) || !Number.isFinite(ioSampledAt)
      || ioSampledAt > sampledAt || sampledAt - ioSampledAt > IO_PRESSURE_FRESH_MS) {
    return { diskMbPerSecond: null, diskIops: null };
  }
  return {
    diskMbPerSecond: optionalResourceNumber(host?.disk_mb_per_s),
    diskIops: optionalResourceNumber(host?.disk_iops),
  };
}

function thresholdPressure(value, thresholds, mark, label) {
  if (value === null) return;
  const critical = thresholds.lowerIsWorse ? value < thresholds.critical : value >= thresholds.critical;
  if (critical) { mark(2, `${label}_critical`); return; }
  const warning = thresholds.lowerIsWorse ? value < thresholds.warning : value >= thresholds.warning;
  if (warning) mark(1, label);
}
const ELASTIC_COMPILER_JOBS = Symbol("resource.elasticCompilerJobs");

const PRESERVE_COMPILER_JOBS = Symbol("resource.preserveCompilerJobs");

export function markPreservedCompilerJobs(request, enabled = true) {
  if (enabled) request[PRESERVE_COMPILER_JOBS] = true;
  return request;
}

export function preservesCompilerJobs(request) { return request?.[PRESERVE_COMPILER_JOBS] === true; }

export function markElasticCompilerJobs(request, enabled = true, memoryFloorMb = null) {
  if (enabled && Number.isInteger(request?.compiler_jobs) && request.compiler_jobs > 1) {
    request[ELASTIC_COMPILER_JOBS] = memoryFloorMb !== null && memoryFloorMb !== undefined && memoryFloorMb !== "" && Number.isFinite(Number(memoryFloorMb))
      ? { memory_floor_mb: Math.max(0, Number(memoryFloorMb)) } : {};
  }
  return request;
}

export function isElasticCompilerRequest(request) { return Boolean(request?.[ELASTIC_COMPILER_JOBS]); }

export function fitElasticRequestToPressure(request, pressure) {
  if (!isElasticCompilerRequest(request) || !pressure || pressure.state === "red") return request;
  const limit = Number(pressure.limits?.cpu); const busy = Number(pressure.observed?.cpu_busy_cores);
  const unobserved = Number(pressure.observed?.unobserved_reserved_cpu ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(busy) || !Number.isFinite(unobserved)) return request;
  const used = Number(pressure.used?.cpu); const overcommit = Number(pressure.limits?.cpu_overcommit); const incremental = Number(pressure.requested?.cpu);
  const covered = Number.isFinite(incremental) ? Math.max(0, Number(request.cpu) - incremental) : 0;
  const hostAvailable = Math.floor(limit + 0.25 - busy - Math.max(0, unobserved) + covered);
  const reservedAvailable = Number.isFinite(used) && Number.isFinite(overcommit)
    ? Math.floor(limit * overcommit + 0.01 - Math.max(0, used) + covered) : request.compiler_jobs;
  const floor = request[ELASTIC_COMPILER_JOBS]?.memory_floor_mb;
  let jobs = Math.max(1, Math.min(request.compiler_jobs, hostAvailable, reservedAvailable));
  jobs = Math.min(jobs, elasticMemoryJobLimit(request, pressure, jobs, floor));
  if (jobs >= request.compiler_jobs) return request;
  return { ...request, cpu: Math.min(Math.max(0, Number(request.cpu) || 0), jobs),
    memory_mb: elasticMemoryMb(request, jobs, floor), compiler_jobs: jobs };
}
