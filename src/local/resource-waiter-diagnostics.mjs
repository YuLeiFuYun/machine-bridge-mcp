import { resourceWaiterDrainActive, resourceWaiterProtected, resourceWaiterQueueSnapshot } from "./resource-waiters.mjs";

export function resourceWaiterDiagnosticSnapshot(waiters = [], leases = [], host = {}, evaluate, now = Date.now()) {
  return {
    ...resourceWaiterQueueSnapshot(waiters, now),
    drain_active: resourceWaiterDrainActive(waiters, leases, host, evaluate, now),
    diagnostics: resourceWaiterDiagnostics(waiters, leases, host, evaluate, now),
  };
}

export function resourceWaiterDiagnostics(waiters = [], leases = [], host = {}, evaluate, now = Date.now(), maximum = 4) {
  if (typeof evaluate !== "function") return [];
  return [...waiters]
    .sort((left, right) => Date.parse(String(left?.enqueued_at || "")) - Date.parse(String(right?.enqueued_at || "")))
    .slice(0, Math.max(0, Math.min(8, Number(maximum) || 0)))
    .map((waiter) => waiterDiagnostic(waiter, leases, host, evaluate, now));
}

function waiterDiagnostic(waiter, leases, host, evaluate, now) {
  const request = waiter?.request || {};
  const enqueuedMs = Date.parse(String(waiter?.enqueued_at || ""));
  const expiresMs = Date.parse(String(waiter?.expires_at || ""));
  const current = safeDecision(evaluate, host, leases, request, now, waiter);
  const withoutLeases = safeDecision(evaluate, host, [], request, now, waiter);
  return {
    age_ms: Number.isFinite(enqueuedMs) ? Math.max(0, now - enqueuedMs) : 0,
    expires_in_ms: Number.isFinite(expiresMs) ? Math.max(0, expiresMs - now) : 0,
    priority: token(request.priority), family: token(request.family), resource_class: token(request.resource_class),
    cpu: number(request.cpu), io: number(request.io), memory_mb: number(request.memory_mb),
    heavy: request.heavy === true, unbounded: request.unbounded === true,
    compiler_jobs: Number.isSafeInteger(request.compiler_jobs) ? request.compiler_jobs : null,
    serialize_project: request.serialize_project === true, protected: resourceWaiterProtected(waiter, now),
    admitted_now: current.admitted === true, admission_reason: token(current.reason),
    would_admit_without_leases: withoutLeases.admitted === true,
  };
}

function safeDecision(evaluate, host, leases, request, now, waiter) {
  try { return evaluate(host, leases, request, now, waiter) || {}; } catch { return { admitted: false, reason: "diagnostic_unavailable" }; }
}
function token(value) { return String(value || "unknown").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || "unknown"; }
function number(value) { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : 0; }
