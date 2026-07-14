import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BridgeError } from "./errors.mjs";

export class CallRegistry {
  constructor(options = {}) {
    this.maximum = positiveInteger(options.maximum, 16);
    this.now = typeof options.now === "function" ? options.now : () => performance.now();
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.onCancel = typeof options.onCancel === "function" ? options.onCancel : () => {};
    this.onFinish = typeof options.onFinish === "function" ? options.onFinish : () => {};
    this.calls = new Map();
  }

  open({ callId = "", tool = "", origin = "local", timeoutMs = 0 } = {}) {
    const id = String(callId || `call_${randomBytes(16).toString("hex")}`);
    if (this.calls.has(id)) throw new BridgeError("conflict", "duplicate in-flight call id");
    if (this.calls.size >= this.maximum) throw new BridgeError("limit_exceeded", `too many concurrent tool calls (${this.maximum})`, { retryable: true });
    const controller = new AbortController();
    const startedAt = this.now();
    const timeout = positiveInteger(timeoutMs, 0);
    const record = {
      id,
      tool: String(tool || ""),
      origin: String(origin || "local"),
      startedAt,
      deadlineAt: timeout ? startedAt + timeout : null,
      controller,
      cancelReason: "",
      timer: null,
    };
    if (timeout) {
      record.timer = this.scheduler.setTimeout(() => this.cancel(id, "deadline exceeded", "timeout"), timeout);
      record.timer?.unref?.();
    }
    this.calls.set(id, record);
    return Object.freeze({
      callId: id,
      tool: record.tool,
      origin: record.origin,
      startedAt,
      deadlineAt: record.deadlineAt,
      signal: controller.signal,
    });
  }

  cancel(callId, reason = "cancelled", code = "cancelled") {
    const record = this.calls.get(String(callId || ""));
    if (!record || record.controller.signal.aborted) return false;
    record.cancelReason = String(reason || "cancelled").slice(0, 256);
    record.controller.abort(new BridgeError(code, code === "timeout" ? "tool call timed out" : "tool call cancelled"));
    this.onCancel(record);
    return true;
  }

  finish(callId) {
    const id = String(callId || "");
    const record = this.calls.get(id);
    if (!record) return false;
    if (record.timer) this.scheduler.clearTimeout(record.timer);
    this.calls.delete(id);
    this.onFinish(record);
    return true;
  }

  cancelOrigin(origin, reason = "transport disconnected") {
    const expected = String(origin || "");
    let cancelled = 0;
    for (const [id, record] of this.calls) {
      if (record.origin !== expected) continue;
      if (this.cancel(id, reason)) cancelled += 1;
    }
    return cancelled;
  }

  cancelAll(reason = "runtime stopped") {
    for (const id of [...this.calls.keys()]) {
      this.cancel(id, reason);
      this.finish(id);
    }
  }

  context(callId) {
    const record = this.calls.get(String(callId || ""));
    if (!record) return null;
    return {
      callId: record.id,
      tool: record.tool,
      origin: record.origin,
      startedAt: record.startedAt,
      deadlineAt: record.deadlineAt,
      signal: record.controller.signal,
    };
  }

  throwIfCancelled(context = {}) {
    const signal = context.signal || this.calls.get(String(context.callId || ""))?.controller.signal;
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new BridgeError("cancelled", "tool call cancelled");
  }

  snapshot() {
    const now = this.now();
    const byOrigin = {};
    let oldestMs = 0;
    for (const call of this.calls.values()) {
      byOrigin[call.origin] = (byOrigin[call.origin] || 0) + 1;
      oldestMs = Math.max(oldestMs, now - call.startedAt);
    }
    return {
      active: this.calls.size,
      maximum: this.maximum,
      by_origin: byOrigin,
      oldest_ms: oldestMs,
    };
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
