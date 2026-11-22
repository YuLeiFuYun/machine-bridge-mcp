import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { createExclusiveFileSync, removeOwnedJsonFileSync, replaceFileAtomicallySync, repairExclusivePublicationLinksSync, isPublicationStagingArtifactName, sweepPublicationStagingArtifactsSync } from "../core/exclusive-file.mjs";
import { resourceChangeSignal, resourceRetryDelayMs, resourceSleep, signalResourceChange, waitForResourceChange, withResourceTransactionLock, isIgnorableCoordinatorMetadata, recoverResourceDirectoryStaging, RESOURCE_STAGING_BUSY_CODE, createResourceWaiter, pruneAndReadResourceWaiters, removeResourceWaiter, selectedResourceWaiter, resourceWaiterDiagnosticSnapshot } from "./resource-waiters.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { currentProcessStartTimeMs, processStartTimeMsAsync, sampleProcessStartTimesAsync } from "./identity.mjs";
import { freshResourceHostSnapshot, resourceHostNeedsFreshIo, sampleResourceHostAsync, cachedResourceProcessParentSamplerAsync, cachedResourceProcessSnapshotSamplerAsync, sampleResourceProcessParentsAsync } from "./resource-host.mjs";
import { readResourceHostSample } from "./resource-host-window.mjs";
import { readResourceStateJson, fitElasticRequestToPressure, resourceCoordinatorAccounting, resourceCoordinatorEvaluator, resourceLeaseIsStale, resourceLeaseOwnerStatusFromStart, resourceProcessGroupAlive } from "./resource-leases.mjs";
import { normalizeResourceRequest, validateResourceRequest } from "./resource-metrics.mjs";
import { deriveHostRates, evaluateResourceAdmission, resourceAdmissionDecisionRetryable, resourcePressureSnapshot } from "./resource-admission-policy.mjs";
import { resourceProjectHash, resourceRequestForProject } from "./resource-command-profile.mjs";

const SCHEMA = 1;

const PROVISIONAL_TTL_MS = 30_000;

const PROCESS_OWNERSHIP_LOCK_WAIT_MS = 30_000;

const LEASE_FILE = /^lease_[a-f0-9]{32}\.json$/;

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
    this.sampleProcessStarts = cachedResourceProcessSnapshotSamplerAsync(options.sampleProcessStarts || sampleProcessStartTimesAsync, this.now, options.processStartCacheMs);
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
        const processStarts = await this.sampleProcessStarts();
        const result = await this.withLock(() => {
          const leases = this.pruneAndReadLeases(processStarts);
          const previous = readResourceHostSample(this.hostSampleFile, { optional: true });
          const enrichedHost = deriveHostRates(host, previous);
          this.writeJson(this.hostSampleFile, enrichedHost);
          const accounting = resourceCoordinatorAccounting(leases, processParents, waiter.owner.pid);
          const pressure = resourcePressureSnapshot(enrichedHost, leases, coordinatedRequest.priority, this.now(), accounting.accounting, coordinatedRequest);
          const effectiveRequest = fitElasticRequestToPressure(coordinatedRequest, pressure);
          if (waiter.request.cpu !== effectiveRequest.cpu || waiter.request.memory_mb !== effectiveRequest.memory_mb || waiter.request.compiler_jobs !== effectiveRequest.compiler_jobs) {
            waiter.request = normalizeResourceRequest(effectiveRequest); this.writeJson(join(this.waitersDir, `wait_${waiter.waiter_id}.json`), waiter);
          }
          const waiters = this.pruneAndReadWaiters(processStarts);
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
    const processStarts = await this.sampleProcessStarts();
    return this.withLock(() => {
      const leases = this.pruneAndReadLeases(processStarts);
      const waiters = this.pruneAndReadWaiters(processStarts);
      const previous = readResourceHostSample(this.hostSampleFile, { optional: true });
      const enrichedHost = deriveHostRates(host, previous);
      this.writeJson(this.hostSampleFile, enrichedHost);
      const accounting = resourceCoordinatorAccounting(leases, processParents); const evaluate = resourceCoordinatorEvaluator(this.evaluate, processParents); const now = this.now();
      return {
        schema_version: SCHEMA,
        healthy: true,
        root_scope: "machine_user",
        admission_model: "work_conserving_multi_resource",
        hard_resource_quota: false,
        host: publicHost(enrichedHost),
        pressure: resourcePressureSnapshot(enrichedHost, leases, options.priority || "ordinary", now, accounting.accounting),
        active_leases: leases.length,
        resources: accounting.resources,
        waiters: resourceWaiterDiagnosticSnapshot(waiters, leases, enrichedHost, evaluate, now),
      };
    });
  }

  async bindLease(leaseId, token, child, options = {}) {
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw new Error("resource lease requires a spawned child pid");
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
    const file = this.leasePath(leaseId);
    const observedLease = this.readJson(file, 32 * 1024, "resource lease", true);
    if (!observedLease) return false;
    assertLeaseToken(observedLease, token);
    const observedPid = observedLease.owner?.kind === "process" ? observedLease.owner.pid : null;
    const observedStart = observedPid ? await processStartTimeMsAsync(observedPid) : null;
    return this.withLock(() => {
      const lease = this.readJson(file, 32 * 1024, "resource lease", true);
      if (!lease) return false;
      assertLeaseToken(lease, token);
      const owner = lease.owner;
      const ownerStatus = owner?.kind === "process"
        ? resourceLeaseOwnerStatusFromStart(lease, owner.pid === observedPid ? observedStart : null) : null;
      if (owner?.kind === "process" && owner.process_group_isolated === true && ownerStatus?.reason !== "pid_reused" && resourceProcessGroupAlive(owner.process_group_id)) return true;
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
    // A committed marker can retain its exact `.tmp` staging alias after a cleanup fault.
    // Repair only that attributable residue before the strict read; external links stay
    // fail-closed and are left for doctor.
    repairExclusivePublicationLinksSync(this.markerFile);
    const marker = this.readJson(this.markerFile, 4096, "resource coordinator protocol", true);
    if (!marker) {
      try {
        const publication = createExclusiveFileSync(this.markerFile, `${JSON.stringify({ schema_version: SCHEMA, protocol: "agent-resource-coordinator" })}\n`, { mode: 0o600 });
        // A post-commit cleanup failure leaves the internal `.tmp` alias behind. Repair only
        // that attributable residue; an external hard link stays fail-closed for doctor.
        if (publication.publicationComplete === false) repairExclusivePublicationLinksSync(this.markerFile);
      }
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
  pruneAndReadWaiters(processStarts) {
    let entries = readdirSync(this.waitersDir, { withFileTypes: true });
    if (recoverResourceDirectoryStaging(this.waitersDir, entries, "wait", processStarts)) entries = readdirSync(this.waitersDir, { withFileTypes: true });
    const waiters = pruneAndReadResourceWaiters(this.waitersDir, entries, this.now(), processStarts); if (waiters.length < entries.length) signalResourceChange(this); return waiters;
  }
  pruneAndReadLeases(processStarts) {
    const leases = []; let pruned = false;
    let entries = readdirSync(this.leasesDir, { withFileTypes: true });
    if (recoverResourceDirectoryStaging(this.leasesDir, entries, "lease", processStarts)) entries = readdirSync(this.leasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isIgnorableCoordinatorMetadata(entry.name)) continue;
      if (!entry.isFile() || !LEASE_FILE.test(entry.name)) throw new Error("resource coordinator lease directory contains an unexpected entry");
      const file = join(this.leasesDir, entry.name);
      const lease = this.readJson(file, 32 * 1024, "resource lease");
      validateLease(lease);
      if (resourceLeaseIsStale(lease, processStarts, this.now(), PROVISIONAL_TTL_MS)) {
        if (!removeOwnedJsonFileSync(file, { lease_id: lease.lease_id, token: lease.token }, { maxBytes: 32 * 1024 })) {
          throw new Error("resource lease changed during stale pruning");
        }
        pruned = true; continue;
      }
      leases.push(lease);
    }
    if (pruned) signalResourceChange(this); return leases;
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
      request: normalizeResourceRequest(request),
    };
    createExclusiveFileSync(this.leasePath(id), `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    return lease;
  }

  leasePath(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid resource lease id");
    return join(this.leasesDir, `lease_${id}.json`);
  }
  readJson(file, maxBytes, label, optional = false) {
    return readResourceStateJson(file, maxBytes, label, { optional });
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

function validateLease(lease) {
  if (lease?.schema_version !== SCHEMA || typeof lease.lease_id !== "string" || !/^[a-f0-9]{32}$/.test(lease.lease_id)
      || typeof lease.token !== "string" || !/^[a-f0-9]{64}$/.test(lease.token)) throw new Error("resource coordinator lease is invalid");
  if (typeof lease.acquired_at !== "string" || !Number.isFinite(Date.parse(lease.acquired_at))
      || !validOwner(lease.owner)) throw new Error("resource coordinator lease ownership is invalid");
  validateResourceRequest(lease.request);
  if (lease.owner.kind === "process") {
    if (typeof lease.bound_at !== "string" || !Number.isFinite(Date.parse(lease.bound_at))
        || typeof lease.owner.process_group_isolated !== "boolean") throw new Error("resource coordinator process lease is invalid");
    if (lease.owner.process_group_isolated && lease.owner.process_group_id !== lease.owner.pid) throw new Error("resource coordinator process group is invalid");
    if (!lease.owner.process_group_isolated && lease.owner.process_group_id !== null) throw new Error("resource coordinator process group is invalid");
  } else if (lease.bound_at !== null) throw new Error("resource coordinator provisional lease is invalid");
}

function validOwner(owner) {
  return ["provisional", "process"].includes(owner?.kind)
    && Number.isSafeInteger(owner?.pid) && owner.pid > 0
    && typeof owner.process_started_at === "string" && Number.isFinite(Date.parse(owner.process_started_at));
}

function assertLeaseToken(lease, token) { validateLease(lease); if (lease.token !== token) throw new Error("resource lease ownership changed"); }

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
const WAITER_FILE = /^wait_[a-f0-9]{32}\.json$/;

const ROOT_STATE_FILE = /^(?:protocol|host-sample)\.json$/;

const MAX_STATE_BYTES = 64 * 1024;

/**
 * Report, and optionally repair, local state that can make every resource-coordinator
 * operation fail: a published lock, lease, waiter, or protocol marker that kept a second hard
 * link, malformed JSON, or an unexpected directory entry. Strict readers reject that state,
 * so without this check the failure looks like a generic `execution_failed` on every command.
 *
 * Metadata written by desktop indexers is reported but ignored by the coordinator itself;
 * only known metadata names are removed during an explicit repair.
 */
export function inspectResourceCoordinatorSync(root = null, options = {}) {
  const coordinatorRoot = root || defaultResourceCoordinatorRoot(options.env);
  const inspect = options.lstatSync || lstatSync;
  const read = options.readdirSync || readdirSync;
  const remove = options.unlink || unlinkSync;
  const repair = options.repair === true;
  const multiplyLinked = [];
  const repaired = [];
  const swept = [];
  const invalid = [];
  const unexpected = [];
  const metadata = [];
  const scan = coordinatorEntries(coordinatorRoot, { inspect, read });
  for (const file of scan.files) {
    const info = inspectIfPresent(file, inspect);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      unexpected.push(relative(coordinatorRoot, file));
      continue;
    }
    if (info.nlink > 1n) {
      multiplyLinked.push(relative(coordinatorRoot, file));
      if (!repair) continue;
      const outcome = repairExclusivePublicationLinksSync(file, {
        allowUnattributable: true,
        ...(options.repairOptions || {}),
      });
      if (outcome.repaired) {
        if (isValidCoordinatorState(file)) repaired.push(`${relative(coordinatorRoot, file)} (${outcome.kind})`);
        else invalid.push(relative(coordinatorRoot, file));
      }
      continue;
    }
    if (!isValidCoordinatorState(file)) invalid.push(relative(coordinatorRoot, file));
  }
  for (const file of scan.metadata) {
    if (repair) {
      try { remove(file); continue; } catch (error) { if (error?.code !== "ENOENT") unexpected.push(relative(coordinatorRoot, file)); continue; }
    }
    metadata.push(relative(coordinatorRoot, file));
  }
  for (const file of scan.unexpected) unexpected.push(relative(coordinatorRoot, file));
  if (repair) {
    for (const directory of [coordinatorRoot, join(coordinatorRoot, "waiters"), join(coordinatorRoot, "leases")]) {
      for (const name of sweepPublicationStagingArtifactsSync(directory, {
        lstatSync: inspect, readdirSync: read, now: options.now, minAgeMs: 60_000,
      })) swept.push(`${relative(coordinatorRoot, join(directory, name))}`);
    }
  }
  const unresolved = multiplyLinked.length - repaired.length;
  return {
    ok: unresolved === 0 && invalid.length === 0 && unexpected.length === 0,
    detail: coordinatorDetail({ multiplyLinked, repaired, swept, unresolved, repair, invalid, unexpected, metadata }),
    multiplyLinked,
    repaired,
    swept,
    invalid,
    unexpected,
    metadata,
  };
}

function isValidCoordinatorState(file) {
  try {
    const value = JSON.parse(readBoundedRegularFileSync(file, MAX_STATE_BYTES, "resource coordinator state", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).toString("utf8"));
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  } catch (error) {
    return error?.code === "ENOENT" || error?.cause?.code === "ENOENT";
  }
}

function coordinatorDetail({ multiplyLinked, repaired, swept, unresolved, repair, invalid, unexpected, metadata }) {
  if (!multiplyLinked.length && !swept.length && !repaired.length && !invalid.length && !unexpected.length) {
    return metadata.length ? `state files are single-linked; ignored desktop metadata in ${metadata.join(", ")}` : "state files are single-linked";
  }
  const parts = [];
  if (multiplyLinked.length) parts.push(`${multiplyLinked.length} multiply-linked state files`);
  if (repaired.length) parts.push(`${repaired.length} repaired`);
  if (swept.length) parts.push(`${swept.length} stale staging artifacts removed`);
  if (invalid.length) parts.push(`${invalid.length} invalid state files: ${invalid.join(", ")}`);
  if (unexpected.length) parts.push(`${unexpected.length} unexpected entries: ${unexpected.join(", ")}`);
  if (metadata.length) parts.push(`${metadata.length} ignored desktop metadata entries`);
  if (unresolved > 0) parts.push(repair ? `${unresolved} could not be repaired` : "run doctor --repair-resource-coordinator");
  return parts.join("; ");
}

function coordinatorEntries(root, io) {
  const files = [];
  const metadata = [];
  const unexpected = [];
  for (const directory of [root, join(root, "waiters"), join(root, "leases")]) {
    let names;
    try { names = io.read(directory); } catch { continue; }
    for (const name of names) {
      const file = join(directory, name);
      if (directory === root && (name === "leases" || name === "waiters")) {
        const info = inspectIfPresent(file, io.inspect || lstatSync);
        if (info?.isDirectory()) continue;
      }
      if (isIgnorableCoordinatorMetadata(name)) { metadata.push(file); continue; }
      if (isPublicationStagingArtifactName(name)) continue;
      const allowed = directory === root
        ? ROOT_STATE_FILE.test(name) || name.endsWith(".lock")
        : directory.endsWith("waiters") ? WAITER_FILE.test(name) : LEASE_FILE.test(name);
      if (allowed) files.push(file);
      else unexpected.push(file);
    }
  }
  return { files, metadata, unexpected };
}

function inspectIfPresent(target, inspect) {
  try {
    return inspect(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
