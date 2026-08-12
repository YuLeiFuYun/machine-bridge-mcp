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
function normalizePid(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
function requestVector(request = {}) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, finite(request[key]))])); }
function finite(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function emptyVector() { return { cpu: 0, io: 0, memory_mb: 0, disk_reserve_bytes: 0 }; }
function emptyAggregate() { return { ...emptyVector(), heavy_leases: 0 }; }
function addVector(target, value) { for (const key of RESOURCE_KEYS) target[key] += value[key] || 0; return target; }
