// @ts-check
import { aggregateResourceLeases, readResourceStateJson } from "./resource-leases.mjs";

/** @param {any} leases @param {Record<string, unknown>} [accounting] @param {number} [sampledAtMs] @returns {number} */
export function unobservedResourceCpu(leases, accounting = {}, sampledAtMs = 0) {
  const sampledAt = Number(sampledAtMs);
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) return 0;
  const all = aggregateResourceLeases(leases, accounting);
  const observed = aggregateResourceLeases(
    (leases || []).filter((/** @type {any} */ lease) => leaseObservedBySample(lease, sampledAt)),
    accounting,
  );
  return Math.max(0, all.cpu - observed.cpu);
}

/** @param {any} lease @param {number} sampledAtMs */
function leaseObservedBySample(lease, sampledAtMs) {
  const boundAt = Date.parse(String(lease?.bound_at || ""));
  if (Number.isFinite(boundAt)) return boundAt <= sampledAtMs;
  if (lease?.owner?.kind !== "process") return false;
  const acquiredAt = Date.parse(String(lease?.acquired_at || ""));
  return Number.isFinite(acquiredAt) && acquiredAt <= sampledAtMs;
}
const HOST_SAMPLE_MAX_BYTES = 32 * 1024;

/**
 * @param {string} file
 * @param {Record<string, unknown>} [options]
 * @returns {unknown}
 */
export function readResourceHostSample(file, options = {}) {
  return readResourceStateJson(file, HOST_SAMPLE_MAX_BYTES, "resource host sample", options);
}
