import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createExclusiveFileSync, removeOwnedJsonFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { resourceChangeSignal, resourceRetryDelayMs, resourceSleep, signalResourceChange, waitForResourceChange } from "./resource-wait.mjs";
import { withResourceTransactionLock } from "./resource-transaction-lock.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeMsAsync } from "./process-identity.mjs";
import { freshResourceHostSnapshot, resourceHostNeedsFreshIo } from "./resource-host-cache.mjs";
import { readResourceHostSample } from "./resource-host-sample-file.mjs";
import { sampleResourceHostAsync } from "./resource-host-snapshot.mjs";
import { validateResourceRequest } from "./resource-request-contract.mjs";
import { recoverResourceDirectoryStaging, RESOURCE_STAGING_BUSY_CODE } from "./resource-staging-recovery.mjs";
import { deriveHostRates, evaluateResourceAdmission, resourceAdmissionDecisionRetryable, resourcePressureSnapshot } from "./resource-admission-policy.mjs";
import { fitElasticRequestToPressure } from "./resource-elastic-request.mjs";
import { resourceCoordinatorAccounting, resourceCoordinatorEvaluator } from "./resource-coordinator-accounting.mjs";
import { cachedResourceProcessParentSamplerAsync } from "./resource-process-ancestry-cache.mjs";
import { sampleResourceProcessParentsAsync } from "./resource-process-ancestry.mjs";
import { resourceProjectHash, resourceRequestForProject } from "./resource-project-key.mjs";
import { createResourceWaiter, pruneAndReadResourceWaiters, removeResourceWaiter, resourceWaiterQueueSnapshot, selectedResourceWaiter } from "./resource-waiters.mjs";
const SCHEMA = 1; const PROVISIONAL_TTL_MS = 30_000; const PROCESS_OWNERSHIP_LOCK_WAIT_MS = 30_000; const LEASE_FILE = /^lease_[a-f0-9]{32}\.json$/;
export class ResourceAdmissionError extends Error {
  constructor(decision) {
    super(`local heavy-resource admission deferred (${decision?.reason || "resource_busy"})`);
    this.name = "ResourceAdmissionError";
    this.code = "MBM_RESOURCE_BUSY";
    this.retryable = resourceAdmissionDecisionRetryable(decision);
    this.decision = decision;
  }
}
export function defaultResourceCoordinatorRoot(env = process.env) {
  if (env.AGENT_RESOURCE_COORDINATOR_ROOT) return resolve(String(env.AGENT_RESOURCE_COORDINATOR_ROOT));
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || homedir();
    return resolve(base, "AgentResourceCoordinator");
  }
  const base = env.XDG_STATE_HOME ? resolve(String(env.XDG_STATE_HOME)) : join(homedir(), ".local", "state");
  return join(base, "agent-resource-coordinator");
}
export class ResourceCoordinator {
  constructor(options = {}) {
    this.root = resolve(options.root || defaultResourceCoordinatorRoot(options.env));
    this.sampleHost = options.sampleHost || sampleResourceHostAsync;
    this.evaluate = options.evaluate || evaluateResourceAdmission;
    this.now = options.now || Date.now;
    this.sampleProcessParents = cachedResourceProcessParentSamplerAsync(options.sampleProcessParents || sampleResourceProcessParentsAsync, this.now, options.processParentCacheMs);
    this.sleep = options.sleep || resourceSleep;
    this.random = options.random || Math.random;
    this.leasesDir = join(this.root, "leases");
    this.waitersDir = join(this.root, "waiters");
    this.hostSampleFile = join(this.root, "host-sample.json");
    this.markerFile = join(this.root, "protocol.json");
    this.hostSamplesInFlight = new Map();
    this.ready = false;
  }

  async acquire(request, options = {}) {
    if (!request?.heavy) return ResourceLease.light(request);
    this.ensureRoot();
    const coordinatedRequest = resourceRequestForProject(request, options.cwd);
    const waitMs = Math.max(0, Math.min(30 * 60_000, Number(options.waitMs) || 0));
    const started = performance.now();
    const waiter = createResourceWaiter(this.waitersDir, coordinatedRequest, waitMs, this.now());
    let lastDecision = null;
    let retryAttempt = 0;
    try {
      while (true) {
        const changeSignal = resourceChangeSignal(this);
        abortIfNeeded(options.signal);
        options.cancelCheck?.();
        const host = await this.freshHostSnapshot(options.cwd || process.cwd(), coordinatedRequest);
        const processParents = readdirSync(this.leasesDir).some((name) => LEASE_FILE.test(name)) ? await this.sampleProcessParents() : {};
        const result = await this.withLock(() => {
          const leases = this.pruneAndReadLeases();
          const previous = readResourceHostSample(this.hostSampleFile, { optional: true });
          const enrichedHost = deriveHostRates(host, previous);
          this.writeJson(this.hostSampleFile, enrichedHost);
          const accounting = resourceCoordinatorAccounting(leases, processParents, waiter.owner.pid);
          const pressure = resourcePressureSnapshot(enrichedHost, leases, coordinatedRequest.priority, this.now(), accounting.accounting, coordinatedRequest);
          const effectiveRequest = fitElasticRequestToPressure(coordinatedRequest, pressure);
          if (waiter.request.cpu !== effectiveRequest.cpu || waiter.request.memory_mb !== effectiveRequest.memory_mb || waiter.request.compiler_jobs !== effectiveRequest.compiler_jobs) {
            waiter.request = normalizedRequest(effectiveRequest); this.writeJson(join(this.waitersDir, `wait_${waiter.waiter_id}.json`), waiter);
          }
          const waiters = this.pruneAndReadWaiters();
          const evaluate = resourceCoordinatorEvaluator(this.evaluate, processParents, waiter.owner.pid);
          const decision = evaluate(enrichedHost, leases, effectiveRequest, this.now(), waiter);
          const selected = selectedResourceWaiter(waiters, leases, enrichedHost, evaluate, this.now());
          if (!decision.admitted || selected?.waiter_id !== waiter.waiter_id) {
            return { decision: decision.admitted ? { ...decision, admitted: false, reason: "fairness_wait" } : decision, lease: null };
          }
          const lease = this.createLease(decision.reservation ? { ...effectiveRequest, ...decision.reservation } : effectiveRequest, options.cwd);
          removeResourceWaiter(this.waitersDir, waiter);
          return { decision, lease };
        }, Math.max(1, Math.min(PROCESS_OWNERSHIP_LOCK_WAIT_MS, waitMs - (performance.now() - started))));
        lastDecision = result.decision;
        if (result.lease) return new ResourceLease(this, result.lease, result.lease.request);
        if (!resourceAdmissionDecisionRetryable(lastDecision)) throw new ResourceAdmissionError(lastDecision);
        const elapsed = performance.now() - started;
        if (elapsed >= waitMs) throw new ResourceAdmissionError(lastDecision);
        const remaining = Math.max(1, waitMs - elapsed);
        const delay = resourceRetryDelayMs({
          attempt: retryAttempt, priority: coordinatedRequest.priority,
          reason: lastDecision?.reason, remainingMs: remaining, random: this.random,
        });
        retryAttempt += 1;
        await waitForResourceChange(changeSignal, delay, this.sleep, options.signal);
      }
    } finally {
      if (removeResourceWaiter(this.waitersDir, waiter)) signalResourceChange(this);
    }
  }
  async snapshot(options = {}) {
    this.ensureRoot();
    const sampleRequest = options.full === true ? { resource_class: "mixed" } : { resource_class: "adaptive" };
    const host = await this.freshHostSnapshot(options.cwd || process.cwd(), sampleRequest);
    const processParents = readdirSync(this.leasesDir).some((name) => LEASE_FILE.test(name)) ? await this.sampleProcessParents() : {};
    return this.withLock(() => {
      const leases = this.pruneAndReadLeases();
      const waiters = this.pruneAndReadWaiters();
      const previous = readResourceHostSample(this.hostSampleFile, { optional: true });
      const enrichedHost = deriveHostRates(host, previous);
      this.writeJson(this.hostSampleFile, enrichedHost);
      const accounting = resourceCoordinatorAccounting(leases, processParents);
      return {
        schema_version: SCHEMA,
        healthy: true,
        root_scope: "machine_user",
        admission_model: "work_conserving_multi_resource",
        hard_resource_quota: false,
        host: publicHost(enrichedHost),
        pressure: resourcePressureSnapshot(enrichedHost, leases, options.priority || "ordinary", this.now(), accounting.accounting),
        active_leases: leases.length,
        resources: accounting.resources,
        waiters: resourceWaiterQueueSnapshot(waiters, this.now()),
      };
    });
  }

  async bindLease(leaseId, token, child, options = {}) {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("resource lease requires a spawned child pid");
    const observedStart = await processStartTimeMsAsync(child.pid);
    return this.withLock(() => {
      const file = this.leasePath(leaseId);
      const lease = this.readJson(file, 32 * 1024, "resource lease");
      assertLeaseToken(lease, token);
      const processGroupIsolated = options.processGroupIsolated === true && process.platform !== "win32";
      const processGroupId = processGroupIsolated ? child.pid : null;
      if (lease.owner.kind === "process") {
        if (lease.owner.pid !== child.pid
            || lease.owner.process_group_isolated !== processGroupIsolated
            || lease.owner.process_group_id !== processGroupId) {
          throw new Error("resource lease is already bound with different process ownership semantics");
        }
        return lease;
      }
      const nowIso = new Date(this.now()).toISOString();
      lease.owner = {
        kind: "process",
        pid: child.pid,
        process_started_at: Number.isFinite(observedStart) ? new Date(observedStart).toISOString() : nowIso,
        process_group_id: processGroupId,
        process_group_isolated: processGroupIsolated,
      };
      lease.bound_at = nowIso;
      this.writeJson(file, lease);
      return lease;
    }, PROCESS_OWNERSHIP_LOCK_WAIT_MS);
  }

  async releaseLease(leaseId, token) {
    if (!leaseId || !token) return false;
    this.ensureRoot();
    return this.withLock(() => {
      const file = this.leasePath(leaseId);
      const lease = this.readJson(file, 32 * 1024, "resource lease", true);
      if (!lease) return false;
      assertLeaseToken(lease, token);
      const owner = lease.owner; const ownerStatus = owner?.kind === "process" ? inspectLeaseOwnerProcess(lease) : null;
      if (owner?.kind === "process" && owner.process_group_isolated === true && ownerStatus?.reason !== "pid_reused" && isProcessGroupAlive(owner.process_group_id)) return true;
      const removed = removeOwnedJsonFileSync(file, { lease_id: leaseId, token }, { maxBytes: 32 * 1024 });
      if (!removed) throw new Error("resource lease changed before release; state may require inspection");
      signalResourceChange(this);
      return true;
    }, PROCESS_OWNERSHIP_LOCK_WAIT_MS);
  }
  ensureRoot() {
    if (this.ready) return;
    ensureOwnerOnlyDirectorySync(this.root);
    ensureOwnerOnlyDirectorySync(this.leasesDir);
    ensureOwnerOnlyDirectorySync(this.waitersDir);
    const marker = this.readJson(this.markerFile, 4096, "resource coordinator protocol", true);
    if (!marker) {
      try { createExclusiveFileSync(this.markerFile, `${JSON.stringify({ schema_version: SCHEMA, protocol: "agent-resource-coordinator" })}\n`, { mode: 0o600 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const current = this.readJson(this.markerFile, 4096, "resource coordinator protocol");
    if (current?.schema_version !== SCHEMA || current?.protocol !== "agent-resource-coordinator") throw new Error("unsupported resource coordinator protocol");
    this.ready = true;
  }
  async freshHostSnapshot(cwd, request = null) {
    const scope = resourceProjectHash(cwd);
    const needsIo = resourceHostNeedsFreshIo(request);
    const pending = this.hostSamplesInFlight.get(scope);
    if (pending) {
      const shared = await pending.promise;
      if (!needsIo || shared?.io_sampled === true) return shared;
    }
    const flight = { promise: freshResourceHostSnapshot({
      cached: readResourceHostSample(this.hostSampleFile, { optional: true }),
      current: this.now(), sampleHost: this.sampleHost, cwd, request, scope,
    }) };
    this.hostSamplesInFlight.set(scope, flight);
    try { return await flight.promise; }
    finally { if (this.hostSamplesInFlight.get(scope) === flight) this.hostSamplesInFlight.delete(scope); }
  }
  async withLock(callback, timeoutMs = undefined) {
    this.ensureRoot();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try { return await withResourceTransactionLock(this.root, callback, { now: this.now, sleep: this.sleep, random: this.random, timeoutMs }); }
      catch (error) { if (error?.code !== RESOURCE_STAGING_BUSY_CODE || attempt === 4) throw error; await this.sleep(5); }
    }
  }
  pruneAndReadWaiters() {
    let entries = readdirSync(this.waitersDir, { withFileTypes: true });
    if (recoverResourceDirectoryStaging(this.waitersDir, entries, "wait")) entries = readdirSync(this.waitersDir, { withFileTypes: true });
    const waiters = pruneAndReadResourceWaiters(this.waitersDir, entries, this.now()); if (waiters.length < entries.length) signalResourceChange(this); return waiters;
  }
  pruneAndReadLeases() {
    const leases = []; let pruned = false;
    let entries = readdirSync(this.leasesDir, { withFileTypes: true });
    if (recoverResourceDirectoryStaging(this.leasesDir, entries, "lease")) entries = readdirSync(this.leasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !LEASE_FILE.test(entry.name)) throw new Error("resource coordinator lease directory contains an unexpected entry");
      const file = join(this.leasesDir, entry.name);
      const lease = this.readJson(file, 32 * 1024, "resource lease");
      validateLease(lease);
      if (this.leaseIsStale(lease)) {
        if (!removeOwnedJsonFileSync(file, { lease_id: lease.lease_id, token: lease.token }, { maxBytes: 32 * 1024 })) {
          throw new Error("resource lease changed during stale pruning");
        }
        pruned = true; continue;
      }
      leases.push(lease);
    }
    if (pruned) signalResourceChange(this); return leases;
  }

  leaseIsStale(lease) {
    const owner = lease.owner; const status = inspectLeaseOwnerProcess(lease);
    if (owner.kind === "process" && status.reason === "pid_reused") return true;
    if (owner.kind === "process" && owner.process_group_isolated === true && isProcessGroupAlive(owner.process_group_id)) return false;
    if (owner.kind === "provisional" && this.now() - Date.parse(lease.acquired_at) > PROVISIONAL_TTL_MS) return true;
    return status.reclaimable === true;
  }

  createLease(request, cwd) {
    const id = randomBytes(16).toString("hex"); const token = randomBytes(32).toString("hex");
    const nowIso = new Date(this.now()).toISOString();
    const lease = {
      schema_version: SCHEMA,
      lease_id: id,
      token,
      acquired_at: nowIso,
      bound_at: null,
      project_hash: resourceProjectHash(cwd || process.cwd()),
      owner: {
        kind: "provisional",
        pid: process.pid,
        process_started_at: new Date(currentProcessStartTimeMs()).toISOString(),
      },
      request: normalizedRequest(request),
    };
    createExclusiveFileSync(this.leasePath(id), `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    return lease;
  }

  leasePath(id) {
    if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("invalid resource lease id");
    return join(this.leasesDir, `lease_${id}.json`);
  }
  readJson(file, maxBytes, label, optional = false) {
    try {
      const text = readBoundedRegularFileSync(file, maxBytes, label, { verifyPathIdentity: true, rejectMultipleLinks: true }).toString("utf8");
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      if (optional && (error?.code === "ENOENT" || error?.cause?.code === "ENOENT")) return null;
      throw error;
    }
  }
  writeJson(file, value) { replaceFileAtomicallySync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
}

export class ResourceLease {
  constructor(coordinator, lease, request) { this.coordinator = coordinator; this.id = lease.lease_id; this.token = lease.token; this.request = request; this.released = false; }
  static light(request) { return new ResourceLease(null, { lease_id: null, token: null }, request); }
  get active() { return Boolean(this.coordinator && this.id && !this.released); }
  async bindProcess(child, options = {}) { if (this.active) await this.coordinator.bindLease(this.id, this.token, child, options); return this; }
  async release() {
    if (!this.active) return false;
    const released = await this.coordinator.releaseLease(this.id, this.token);
    this.released = true;
    return released;
  }
}

function normalizedRequest(request) {
  const allowed = ["family", "resource_class", "priority", "cpu", "io", "memory_mb", "disk_reserve_bytes", "heavy", "compiler_jobs", "unbounded", "serialize_project", "contention_key"];
  return Object.fromEntries(allowed.map((key) => [key, request[key] ?? null]));
}
function validateLease(lease) {
  if (lease?.schema_version !== SCHEMA || !/^[a-f0-9]{32}$/.test(String(lease.lease_id || "")) || !/^[a-f0-9]{64}$/.test(String(lease.token || ""))) throw new Error("resource coordinator lease is invalid");
  if (!Number.isFinite(Date.parse(String(lease.acquired_at || ""))) || !validOwner(lease.owner)) throw new Error("resource coordinator lease ownership is invalid");
  validateResourceRequest(lease.request);
  if (lease.owner.kind === "process") {
    if (!Number.isFinite(Date.parse(String(lease.bound_at || ""))) || typeof lease.owner.process_group_isolated !== "boolean") throw new Error("resource coordinator process lease is invalid");
    if (lease.owner.process_group_isolated && lease.owner.process_group_id !== lease.owner.pid) throw new Error("resource coordinator process group is invalid");
    if (!lease.owner.process_group_isolated && lease.owner.process_group_id !== null) throw new Error("resource coordinator process group is invalid");
  } else if (lease.bound_at !== null) throw new Error("resource coordinator provisional lease is invalid");
}
function validOwner(owner) { return ["provisional", "process"].includes(owner?.kind) && Number.isInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(Date.parse(String(owner.process_started_at || ""))); }
function assertLeaseToken(lease, token) { validateLease(lease); if (lease.token !== token) throw new Error("resource lease ownership changed"); }
function inspectLeaseOwnerProcess(lease) { return inspectProcessInstance({ pid: lease.owner.pid, startedAt: lease.acquired_at, processStartedAt: lease.owner.process_started_at }); }
function isProcessGroupAlive(value) {
  const pgid = Number(value); if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
function publicHost(host) {
  const {
    pageouts_total: _pageouts, swapouts_total: _swapouts,
    cpu_time_ms_total: _cpuTime, cpu_idle_ms_total: _cpuIdle,
    sample_scope: _sampleScope,
    ...value
  } = host || {};
  return value;
}
function abortIfNeeded(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("resource admission cancelled"); }
