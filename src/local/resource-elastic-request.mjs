import { elasticMemoryJobLimit, elasticMemoryMb } from "./resource-elastic-memory.mjs";

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
