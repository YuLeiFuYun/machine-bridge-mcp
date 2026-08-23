const HOST_SAMPLE_FRESH_MS = 500;
const HOST_CPU_PREVIOUS_MAX_AGE_MS = 2_000;
const HOST_IO_SAMPLE_FRESH_MS = 5_000;
const HOST_IO_HINT_MAX_AGE_MS = HOST_IO_SAMPLE_FRESH_MS;

export function resourceHostNeedsFreshIo(request) {
  return request?.resource_class === "io" || request?.resource_class === "unbounded";
}

export async function freshResourceHostSnapshot({ cached, current, sampleHost, cwd, request = null, scope = "" }) {
  const scopedCached = cached?.sample_scope === scope ? cached : null;
  const sampleAge = scopedCached ? current - Number(scopedCached.sampled_at_ms) : Number.POSITIVE_INFINITY;
  const globalAge = cached ? current - Number(cached.sampled_at_ms) : Number.POSITIVE_INFINITY;
  const cpuPrevious = cached && globalAge >= 0 && globalAge <= HOST_CPU_PREVIOUS_MAX_AGE_MS ? cached : null;
  const needsIo = resourceHostNeedsFreshIo(request);
  if (scopedCached && sampleAge >= 0 && sampleAge <= HOST_SAMPLE_FRESH_MS && (!needsIo || scopedCached.io_sampled === true)) return scopedCached;
  const ioSampledAt = Number(scopedCached?.io_sampled_at_ms ?? scopedCached?.sampled_at_ms);
  const ioAge = current - ioSampledAt;
  if (!needsIo) {
    const quick = { ...await Promise.resolve(sampleHost({ cwd, quick: true, previous: cpuPrevious })), sample_scope: scope };
    if (scopedCached?.io_sampled !== true || !Number.isFinite(ioAge) || ioAge < 0 || ioAge > HOST_IO_HINT_MAX_AGE_MS) return quick;
    return withCachedIo(quick, scopedCached);
  }
  if (scopedCached?.io_sampled === true && Number.isFinite(ioAge) && ioAge >= 0 && ioAge <= HOST_IO_SAMPLE_FRESH_MS) {
    const quick = { ...await Promise.resolve(sampleHost({ cwd, quick: true, previous: cpuPrevious })), sample_scope: scope };
    return withCachedIo(quick, scopedCached);
  }
  return { ...await Promise.resolve(sampleHost({ cwd, quick: false, previous: cpuPrevious })), sample_scope: scope };
}

function withCachedIo(sample, cached) {
  return {
    ...sample,
    disk_mb_per_s: cached.disk_mb_per_s ?? null,
    disk_iops: cached.disk_iops ?? null,
    io_sampled: true,
    io_sampled_at_ms: Number.isFinite(Number(cached.io_sampled_at_ms)) ? Number(cached.io_sampled_at_ms) : Number(cached.sampled_at_ms),
  };
}
