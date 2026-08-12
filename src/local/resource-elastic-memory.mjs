export function elasticMemoryJobLimit(request, pressure, maximumJobs, floorValue) {
  if (floorValue === null || floorValue === undefined || floorValue === "") return maximumJobs;
  const floor = Number(floorValue); const limit = Number(pressure?.limits?.memory_mb);
  const overcommit = Number(pressure?.limits?.memory_overcommit); const used = Number(pressure?.used?.memory_mb);
  if (![floor, limit, overcommit, used].every(Number.isFinite)) return maximumJobs;
  const incremental = Number(pressure?.requested?.memory_mb);
  const covered = Number.isFinite(incremental) ? Math.max(0, Number(request.memory_mb) - incremental) : 0;
  const available = Math.max(0, limit * overcommit + 1 - Math.max(0, used) + covered);
  for (let jobs = maximumJobs; jobs >= 1; jobs -= 1) {
    if (elasticMemoryMb(request, jobs, floor) <= available) return jobs;
  }
  return 1;
}

export function elasticMemoryMb(request, jobs, floorValue) {
  const floor = Number(floorValue);
  if (!Number.isFinite(floor)) return request.memory_mb;
  return Math.min(request.memory_mb, Math.max(floor, Math.ceil(request.memory_mb * jobs / request.compiler_jobs)));
}
