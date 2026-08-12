import { aggregateResourceLeases, resourceLeaseAccountingContext } from "./resource-lease-accounting.mjs";

export function resourceCoordinatorEvaluator(evaluate, processParents, fallbackPid) {
  return (host, leases, request, now, candidate = null) => evaluate(host, leases, request, now, {
    accounting: resourceLeaseAccountingContext(
      leases, processParents, candidate?.owner?.pid || fallbackPid,
    ),
  });
}

export function resourceCoordinatorAccounting(leases, processParents, now, requesterPid = 0) {
  const accounting = resourceLeaseAccountingContext(leases, processParents, requesterPid);
  const used = aggregateResourceLeases(leases, accounting, now);
  return {
    accounting,
    resources: {
      cpu: used.cpu, io: used.io, memory_mb: used.memory_mb,
      disk_reserve_bytes: used.disk_reserve_bytes,
    },
  };
}
