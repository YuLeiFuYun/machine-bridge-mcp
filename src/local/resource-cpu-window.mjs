import { aggregateResourceLeases } from "./resource-lease-accounting.mjs";

export function unobservedResourceCpu(leases, accounting = {}, sampledAtMs = 0) {
  const sampledAt = Number(sampledAtMs);
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) return 0;
  const all = aggregateResourceLeases(leases, accounting);
  const observed = aggregateResourceLeases(
    (leases || []).filter((lease) => leaseObservedBySample(lease, sampledAt)),
    accounting,
  );
  return Math.max(0, all.cpu - observed.cpu);
}

function leaseObservedBySample(lease, sampledAtMs) {
  const boundAt = Date.parse(String(lease?.bound_at || ""));
  if (Number.isFinite(boundAt)) return boundAt <= sampledAtMs;
  if (lease?.owner?.kind !== "process") return false;
  const acquiredAt = Date.parse(String(lease?.acquired_at || ""));
  return Number.isFinite(acquiredAt) && acquiredAt <= sampledAtMs;
}
