import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createExclusiveFileSync, removeOwnedJsonFileSync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { validateResourceRequest } from "./resource-request-contract.mjs";
const SCHEMA = 1;
const WAITER_FILE = /^wait_[a-f0-9]{32}\.json$/;
const MAX_WAITER_BYTES = 16 * 1024;
const WAITER_GRACE_MS = 5_000;
const AGING_MS = 120_000;
const PROTECTION_FLOOR_MS = AGING_MS;
const LEASE_DRAIN_REASONS = new Set(["project_resource_busy", "cpu_reservation", "io_reservation", "memory_reservation", "disk_reserve_floor"]);
export function createResourceWaiter(waitersDir, request, waitMs, now = Date.now()) {
  const waiterId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + Math.max(5_000, Number(waitMs) || 0) + WAITER_GRACE_MS;
  const waiter = {
    schema_version: SCHEMA,
    waiter_id: waiterId,
    token,
    enqueued_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    owner: { pid: process.pid, process_started_at: new Date(currentProcessStartTimeMs()).toISOString() },
    request: normalizeWaiterRequest(request),
  };
  createExclusiveFileSync(waiterPath(waitersDir, waiterId), `${JSON.stringify(waiter)}\n`, { mode: 0o600 });
  return waiter;
}
export function removeResourceWaiter(waitersDir, waiter) {
  if (!waiter?.waiter_id || !waiter?.token) return false;
  return removeOwnedJsonFileSync(waiterPath(waitersDir, waiter.waiter_id), {
    waiter_id: waiter.waiter_id, token: waiter.token,
  }, { maxBytes: MAX_WAITER_BYTES });
}

export function pruneAndReadResourceWaiters(waitersDir, entries, now = Date.now()) {
  const waiters = [];
  for (const entry of entries) {
    if (!entry.isFile() || !WAITER_FILE.test(entry.name)) throw new Error("resource coordinator waiter directory contains an unexpected entry");
    const file = join(waitersDir, entry.name);
    let waiter;
    try { waiter = readWaiter(file); }
    catch (error) { if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") continue; throw error; }
    validateWaiter(waiter);
    if (waiterIsStale(waiter, now)) {
      if (!removeResourceWaiter(waitersDir, waiter)) throw new Error("resource waiter changed during stale pruning");
      continue;
    }
    waiters.push(waiter);
  }
  return waiters;
}

export function selectedResourceWaiter(waiters, leases, host, evaluate, now = Date.now()) {
  const ranked = [...waiters].sort((left, right) => compareWaiters(left, right, now));
  const selected = ranked.find((waiter) => evaluate(host, leases, waiter.request, now, waiter).admitted) || null;
  const protectedWaiter = leases.length ? ranked.find((waiter) => {
    const current = evaluate(host, leases, waiter.request, now, waiter); const empty = evaluate(host, [], waiter.request, now, waiter);
    return resourceWaiterProtected(waiter, now) && LEASE_DRAIN_REASONS.has(current.reason)
      && (empty.admitted || empty.reason === "cpu_pressure_window");
  }) : null;
  if (protectedWaiter && (!selected || compareWaiters(protectedWaiter, selected, now) <= 0)) return null;
  return selected;
}

export function resourceWaiterRank(waiter, now = Date.now()) {
  const base = waiterBaseRank(waiter);
  const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
  const ageBoost = Number.isFinite(enqueued) ? Math.floor(Math.max(0, now - enqueued) / AGING_MS) : 0;
  return Math.max(0, base - ageBoost);
}

export function resourceWaiterProtected(waiter, now = Date.now()) {
  const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
  if (!Number.isFinite(enqueued) || resourceWaiterRank(waiter, now) !== 0) return false;
  const protectionAge = Math.max(PROTECTION_FLOOR_MS, waiterBaseRank(waiter) * AGING_MS);
  return Math.max(0, now - enqueued) >= protectionAge;
}

export function resourceWaiterQueueSnapshot(waiters, now = Date.now()) {
  const byPriority = { interactive: 0, ordinary: 0, background: 0 };
  let oldest = null;
  for (const waiter of waiters || []) {
    const priority = ["interactive", "ordinary", "background"].includes(waiter?.request?.priority) ? waiter.request.priority : "ordinary";
    byPriority[priority] += 1;
    const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
    if (Number.isFinite(enqueued) && (oldest === null || enqueued < oldest)) oldest = enqueued;
  }
  return {
    active: (waiters || []).length,
    by_priority: byPriority,
    protected: (waiters || []).filter((waiter) => resourceWaiterProtected(waiter, now)).length,
    oldest_ms: oldest === null ? 0 : Math.max(0, now - oldest),
  };
}

function waiterBaseRank(waiter) {
  return waiter?.request?.priority === "interactive" ? 0 : waiter?.request?.priority === "ordinary" ? 1 : 2;
}
function compareWaiters(left, right, now) {
  const rank = resourceWaiterRank(left, now) - resourceWaiterRank(right, now);
  if (rank) return rank;
  const time = Date.parse(left.enqueued_at) - Date.parse(right.enqueued_at);
  return time || String(left.waiter_id).localeCompare(String(right.waiter_id));
}
function waiterIsStale(waiter, now) {
  if (Date.parse(waiter.expires_at) < now) return true;
  const status = inspectProcessInstance({
    pid: waiter.owner.pid,
    startedAt: waiter.enqueued_at,
    processStartedAt: waiter.owner.process_started_at,
  });
  return status.reclaimable === true;
}
function validateWaiter(waiter) {
  if (waiter?.schema_version !== SCHEMA || !/^[a-f0-9]{32}$/.test(String(waiter.waiter_id || ""))
      || !/^[a-f0-9]{64}$/.test(String(waiter.token || ""))) throw new Error("resource coordinator waiter is invalid");
  if (!Number.isFinite(Date.parse(String(waiter.enqueued_at || ""))) || !Number.isFinite(Date.parse(String(waiter.expires_at || "")))
      || !Number.isInteger(waiter.owner?.pid) || waiter.owner.pid <= 0
      || !Number.isFinite(Date.parse(String(waiter.owner?.process_started_at || "")))) throw new Error("resource coordinator waiter ownership is invalid");
  validateResourceRequest(waiter.request);
}
function readWaiter(file) {
  const text = readBoundedRegularFileSync(file, MAX_WAITER_BYTES, "resource waiter", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  }).toString("utf8");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resource coordinator waiter is invalid");
  return value;
}
function waiterPath(waitersDir, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("invalid resource waiter id");
  return join(waitersDir, `wait_${id}.json`);
}
function normalizeWaiterRequest(request = {}) {
  const keys = ["family", "resource_class", "priority", "cpu", "io", "memory_mb", "disk_reserve_bytes", "heavy", "compiler_jobs", "unbounded", "serialize_project", "contention_key"];
  return Object.fromEntries(keys.map((key) => [key, request[key] ?? null]));
}
