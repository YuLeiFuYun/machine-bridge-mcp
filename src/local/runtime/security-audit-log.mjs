import { createHmac, randomBytes } from "node:crypto";
import { Worker, parentPort, workerData } from "node:worker_threads";
import { SECURITY_AUDIT_MAX_BYTES, SECURITY_AUDIT_MAX_EVENTS, auditFilePath, unhealthyAuditSnapshot, auditErrorClass, createAuditStorageSession } from "./security-audit-store.mjs";
import { BridgeError } from "../core/errors.mjs";
import { operationMayHaveSideEffects } from "../core/operation-risk.mjs";

const MAX_PENDING_RECORDS = 1024;

const CLOSE_TIMEOUT_MS = 5000;

export class SecurityAuditLog {
  constructor({ root = "", now = Date.now, WorkerClass = Worker, identityKey = null } = {}) {
    this.root = root ? String(root) : "";
    this.file = this.root ? auditFilePath(this.root) : "";
    this.now = typeof now === "function" ? now : Date.now;
    this.identityKey = identityKey ? Buffer.from(identityKey) : randomBytes(32);
    this.pseudonymEpoch = randomBytes(32).toString("hex");
    this.worker = null;
    this.workerReady = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.droppedRecords = 0;
    this.cachedSnapshot = this.file ? initializingSnapshot() : disabledSnapshot();
    if (!this.file) return;
    try {
      const worker = new WorkerClass(new URL("./security-audit-log.mjs", import.meta.url), {
        workerData: { root: this.root },
      });
      this.worker = worker;
      worker.on("message", (message) => { if (this.worker === worker) this.handleMessage(message); });
      worker.on("error", (error) => { if (this.worker === worker) this.handleWorkerFailure(error); });
      worker.on("exit", (code) => {
        if (this.worker === worker && !this.closed) {
          this.handleWorkerFailure(Object.assign(new Error("security audit worker exited"), {
            code: code === 0 ? "audit_worker_unexpected_exit" : "audit_worker_exit",
          }));
        }
      });
    } catch (error) {
      this.cachedSnapshot = unhealthyAuditSnapshot(error);
    }
  }

  record(input = {}) {
    if (!this.file || this.closed || !this.worker) return Promise.resolve(false);
    if (this.pending.size >= MAX_PENDING_RECORDS) {
      this.droppedRecords += 1;
      this.cachedSnapshot = { ...this.cachedSnapshot, healthy: false, last_error_class: "audit_queue_full" };
      return Promise.resolve(false);
    }
    const id = this.nextId++;
    return new Promise((resolvePromise) => {
      this.pending.set(id, { resolve: resolvePromise, kind: "record" });
      try {
        this.worker.postMessage({ type: "record", id, input: projectAuditInput(input, this.identityKey, this.pseudonymEpoch), nowMs: this.now() });
      } catch (error) {
        this.handleWorkerFailure(error);
      }
    });
  }

  flush() { return this.barrier("flush"); }

  async close({ timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
    if (this.closed) return true;
    this.closed = true;
    if (!this.worker) return false;
    const worker = this.worker;
    const closing = this.barrier("close", true);
    let timer;
    try {
      return await Promise.race([
        closing,
        new Promise((resolvePromise) => {
          timer = setTimeout(() => resolvePromise(false), normalizeCloseTimeoutMs(timeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await worker.terminate().catch(() => { /* Audit shutdown already owns the terminal state; worker termination is best-effort cleanup. */ });
      if (this.worker === worker) this.worker = null;
      this.failPending(false);
    }
  }

  snapshot() {
    return {
      ...this.cachedSnapshot,
      persistence: this.file ? "worker-thread-batched-atomic" : "disabled",
      worker_ready: this.workerReady,
      queue_depth: [...this.pending.values()].filter((entry) => entry.kind === "record").length,
      queue_capacity: MAX_PENDING_RECORDS,
      dropped_records: this.droppedRecords,
    };
  }

  markUnavailable(error) { if (this.worker) this.handleWorkerFailure(error); }

  barrier(type, allowClosed = false) {
    if (!this.worker || (this.closed && !allowClosed)) return Promise.resolve(false);
    const id = this.nextId++;
    return new Promise((resolvePromise) => {
      this.pending.set(id, { resolve: resolvePromise, kind: type });
      try { this.worker.postMessage({ type, id }); }
      catch (error) {
        this.handleWorkerFailure(error);
      }
    });
  }

  handleMessage(message) {
    if (message?.snapshot) this.cachedSnapshot = message.snapshot;
    if (message?.type === "ready") {
      this.workerReady = message.snapshot?.healthy === true;
      return;
    }
    if (message?.type === "record_batch_result" && Array.isArray(message.ids)) {
      for (const rawId of message.ids) {
        const id = Number(rawId);
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        if (message.recorded !== true) this.droppedRecords += 1;
        pending.resolve(message.recorded === true);
      }
      return;
    }
    const id = Number(message?.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.type === "flushed" || message.type === "closed") {
      pending.resolve(this.droppedRecords === 0 && this.cachedSnapshot.healthy === true);
    }
  }

  handleWorkerFailure(error) {
    this.workerReady = false;
    this.cachedSnapshot = unhealthyAuditSnapshot(error);
    this.droppedRecords += [...this.pending.values()].filter((entry) => entry.kind === "record").length;
    const worker = this.worker;
    this.worker = null;
    this.failPending(false);
    if (!this.closed) void worker?.terminate?.().catch?.(() => {
      // The audit worker has already failed and pending records were settled false;
      // termination is best-effort cleanup and cannot restore audit availability.
    });
  }

  failPending(value) {
    for (const pending of this.pending.values()) pending.resolve(value);
    this.pending.clear();
  }
}

function normalizeCloseTimeoutMs(value) {
  let numeric;
  try { numeric = Number(value); } catch { return CLOSE_TIMEOUT_MS; }
  if (!Number.isFinite(numeric) || numeric <= 0) return CLOSE_TIMEOUT_MS;
  return Math.min(CLOSE_TIMEOUT_MS, Math.max(1, numeric));
}

function initializingSnapshot() {
  return {
    enabled: true, healthy: false, retained: 0, maximum: SECURITY_AUDIT_MAX_EVENTS, maximum_bytes: SECURITY_AUDIT_MAX_BYTES,
    last_event_at: null, last_error_class: "audit_initializing",
    content_logged: false, chain_verified: false,
  };
}

function disabledSnapshot() {
  return {
    enabled: false,
    healthy: true,
    retained: 0,
    maximum: SECURITY_AUDIT_MAX_EVENTS,
    maximum_bytes: SECURITY_AUDIT_MAX_BYTES,
    last_event_at: null,
    last_error_class: null,
    content_logged: false,
    chain_verified: true,
  };
}

function projectAuditInput(input, identityKey, pseudonymEpoch) {
  const principal = input?.principal && typeof input.principal === "object" ? input.principal : {};
  return {
    outcome: input?.outcome,
    tool: input?.tool,
    riskCategory: input?.riskCategory,
    targetHash: input?.targetHash,
    durationMs: input?.durationMs,
    inputBytes: input?.inputBytes,
    outputBytes: input?.outputBytes,
    errorCode: input?.errorCode,
    requestDelivery: input?.requestDelivery,
    sideEffectsStarted: input?.sideEffectsStarted,
    effectSettlement: input?.effectSettlement,
    terminationRequested: input?.terminationRequested,
    pseudonymEpoch,
    operationRef: runtimePrivateReference(identityKey, input?.operationId),
    principal: {
      kind: principal.kind,
      accountId: runtimePrivateReference(identityKey, principal.accountId),
      accountVersion: principal.accountVersion,
      clientId: runtimePrivateReference(identityKey, principal.clientId),
      familyId: runtimePrivateReference(identityKey, principal.familyId),
      role: principal.role,
    },
  };
}

function runtimePrivateReference(key, value) {
  if (typeof value !== "string" || !value) return null;
  return createHmac("sha256", key).update(value).digest("hex");
}
export function enqueueSecurityAudit(securityAudit, operation, outcome, failureReporter) {
  if (!securityAudit?.record || operation.context.origin !== "relay") return;
  let persistence;
  try {
    persistence = securityAudit.record(auditInput(operation, outcome));
  } catch (error) {
    failureReporter.report("security.audit.enqueue.failed", { error_class: dispatchAuditErrorClass(error) }, "Security audit event could not be queued");
    return;
  }
  Promise.resolve(persistence).then((recorded) => {
    if (recorded) return;
    failureReporter.report("security.audit.persist.failed", { tool: operation.tool }, "Security audit event could not be persisted");
  }).catch((error) => {
    failureReporter.report("security.audit.persist.failed", {
      error_class: dispatchAuditErrorClass(error), tool: operation.tool,
    }, "Security audit event could not be persisted");
  });
}

export async function persistSecurityAuditDispatchIntent(securityAudit, operation) {
  if (!securityAudit?.record || !securityAudit?.flush || operation.context.origin !== "relay") return false;
  if (await securityAudit.flush() !== true) return false;
  return await securityAudit.record(auditInput(operation, {
    outcome: "dispatch_intent",
    sideEffectsStarted: false,
    terminationRequested: false,
  })) === true;
}

function auditInput(operation, outcome) {
  return {
    ...outcome,
    tool: operation.tool,
    riskCategory: operation.context.operationAuthorization?.category || "ordinary operation",
    targetHash: operation.context.operationAuthorization?.targetHash || "",
    principal: operation.context.authority?.principal || {},
    operationId: operation.context.callId,
    inputBytes: safeByteLength(operation.args),
  };
}

function safeByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function dispatchAuditErrorClass(error) {
  return String(error?.code || error?.name || "audit_error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
const AUDIT_DISPATCH_TIMEOUT_MS = 5_000;

export function securityAuditPreDispatchMiddleware(securityAudit) {
  return async (operation, next) => {
    if (operation.context.origin !== "relay" || !operationMayHaveSideEffects(operation.tool)) {
      return next(operation);
    }
    let recorded = false;
    try { recorded = await boundedAuditIntent(securityAudit, operation); }
    catch { recorded = false; }
    if (!recorded) {
      throw new BridgeError("unavailable", "security audit is unavailable; remote operation was not dispatched", {
        retryable: true,
        details: { reason: "security_audit_unavailable" },
      });
    }
    return next(operation);
  };
}

async function boundedAuditIntent(securityAudit, operation) {
  let timer;
  try {
    return await Promise.race([
      persistSecurityAuditDispatchIntent(securityAudit, operation),
      new Promise((resolve) => { timer = setTimeout(() => {
          securityAudit.markUnavailable?.(Object.assign(new Error("security audit pre-dispatch timed out"), { code: "audit_dispatch_timeout" }));
          resolve(false);
        }, AUDIT_DISPATCH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}
if (parentPort) runAuditWorkerThread();

function runAuditWorkerThread() {
  const root = String(workerData?.root || "");
  const state = {
    maxBatch: 128,
    batchDelayMs: 5,
    storage: createAuditStorageSession(root),
    pending: [],
    timer: null,
    draining: false,
    closeRequested: false,
  };
  try {
    parentPort.postMessage({ type: "ready", snapshot: state.storage.snapshot() });
  } catch (error) {
    parentPort.postMessage({ type: "ready", snapshot: unhealthyAuditSnapshot(error) });
  }
  parentPort.on("message", (message) => {
    if (message?.type === "record") {
      state.pending.push(message);
      scheduleAuditWorkerDrain(state);
      return;
    }
    if (message?.type === "flush") {
      state.pending.push({ type: "barrier", id: message.id });
      scheduleAuditWorkerDrain(state, true);
      return;
    }
    if (message?.type === "close") {
      state.closeRequested = true;
      state.pending.push({ type: "barrier", id: message.id, close: true });
      scheduleAuditWorkerDrain(state, true);
    }
  });
}

function scheduleAuditWorkerDrain(state, immediate = false) {
  if (state.draining || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void drainAuditWorkerQueue(state);
  }, immediate ? 0 : state.batchDelayMs);
  state.timer.unref?.();
}

async function drainAuditWorkerQueue(state) {
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.pending.length > 0) {
      const records = [];
      const barriers = [];
      while (state.pending.length > 0 && records.length < state.maxBatch) {
        const item = state.pending.shift();
        if (item.type === "record") records.push(item);
        else barriers.push(item);
        if (barriers.length > 0 && records.length === 0) break;
      }
      if (records.length > 0) {
        try {
          const snapshot = await state.storage.recordBatch(records.map(({ input, nowMs }) => ({ input, nowMs })));
          parentPort.postMessage({
            type: "record_batch_result", ids: records.map((item) => item.id), recorded: true, snapshot,
          });
        } catch (error) {
          const errorClass = auditErrorClass(error);
          const snapshot = unhealthyAuditSnapshot(error);
          parentPort.postMessage({
            type: "record_batch_result", ids: records.map((item) => item.id), recorded: false,
            error_class: errorClass, snapshot,
          });
        }
      }
      for (const barrier of barriers) {
        parentPort.postMessage({ type: barrier.close ? "closed" : "flushed", id: barrier.id });
      }
    }
  } finally {
    state.draining = false;
    if (state.pending.length > 0) scheduleAuditWorkerDrain(state, true);
    else if (state.closeRequested) parentPort.close();
  }
}
