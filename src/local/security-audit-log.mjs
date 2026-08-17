import { createHmac, randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  SECURITY_AUDIT_MAX_BYTES,
  SECURITY_AUDIT_MAX_EVENTS,
  auditFilePath,
  unhealthyAuditSnapshot,
} from "./security-audit-storage.mjs";

const MAX_PENDING_RECORDS = 1024;
const CLOSE_TIMEOUT_MS = 5000;

export class SecurityAuditLog {
  constructor({ root = "", now = Date.now, WorkerClass = Worker, identityKey = null } = {}) {
    this.root = root ? String(root) : "";
    this.file = this.root ? auditFilePath(this.root) : "";
    this.now = typeof now === "function" ? now : Date.now;
    this.identityKey = identityKey ? Buffer.from(identityKey) : randomBytes(32);
    this.worker = null;
    this.workerReady = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.droppedRecords = 0;
    this.cachedSnapshot = this.file ? initializingSnapshot() : disabledSnapshot();
    if (!this.file) return;
    try {
      const worker = new WorkerClass(new URL("./security-audit-worker.mjs", import.meta.url), {
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
        this.worker.postMessage({ type: "record", id, input: projectAuditInput(input, this.identityKey), nowMs: Number(this.now()) });
      } catch (error) {
        this.pending.delete(id);
        this.droppedRecords += 1;
        this.cachedSnapshot = unhealthyAuditSnapshot(error);
        resolvePromise(false);
      }
    });
  }

  flush() {
    return this.barrier("flush");
  }

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
          timer = setTimeout(() => resolvePromise(false), Math.max(1, Number(timeoutMs) || CLOSE_TIMEOUT_MS));
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

  barrier(type, allowClosed = false) {
    if (!this.worker || (this.closed && !allowClosed)) return Promise.resolve(false);
    const id = this.nextId++;
    return new Promise((resolvePromise) => {
      this.pending.set(id, { resolve: resolvePromise, kind: type });
      try { this.worker.postMessage({ type, id }); }
      catch {
        this.pending.delete(id);
        resolvePromise(false);
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
    if (message.type === "flushed" || message.type === "closed") pending.resolve(true);
  }

  handleWorkerFailure(error) {
    this.workerReady = false;
    this.cachedSnapshot = unhealthyAuditSnapshot(error);
    this.droppedRecords += [...this.pending.values()].filter((entry) => entry.kind === "record").length;
    const worker = this.worker;
    this.worker = null;
    this.failPending(false);
    if (!this.closed) void worker?.terminate?.().catch?.(() => {});
  }

  failPending(value) {
    for (const pending of this.pending.values()) pending.resolve(value);
    this.pending.clear();
  }
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

function projectAuditInput(input, identityKey) {
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
  if (!value) return null;
  return createHmac("sha256", key).update(String(value)).digest("hex");
}
