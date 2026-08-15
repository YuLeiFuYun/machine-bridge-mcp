const DEFAULT_CACHE_MS = 1_000;

export function cachedResourceProcessParentSampler(sample, now = Date.now, cacheMs = DEFAULT_CACHE_MS) {
  const ttl = Math.max(0, Number(cacheMs) || 0);
  let sampledAt = null;
  let cached = null;
  return () => {
    const current = Number(now());
    if (cacheFresh(sampledAt, current, ttl)) return cached;
    cached = normalizeSnapshot(sample());
    sampledAt = finishedAt(now, current);
    return cached;
  };
}

export function cachedResourceProcessParentSamplerAsync(sample, now = Date.now, cacheMs = DEFAULT_CACHE_MS) {
  const ttl = Math.max(0, Number(cacheMs) || 0);
  let sampledAt = null;
  let cached = null;
  let inFlight = null;
  return async () => {
    const current = Number(now());
    if (cacheFresh(sampledAt, current, ttl)) return cached;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => sample()).then((value) => {
      cached = normalizeSnapshot(value);
      sampledAt = finishedAt(now, current);
      return cached;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

function normalizeSnapshot(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function cacheFresh(sampledAt, current, ttl) {
  return sampledAt !== null && Number.isFinite(current) && current >= sampledAt && current - sampledAt <= ttl;
}
function finishedAt(now, fallback) {
  const finished = Number(now());
  return Number.isFinite(finished) ? finished : Number.isFinite(fallback) ? fallback : null;
}
