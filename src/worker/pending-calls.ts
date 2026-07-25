import type { PendingCallOutcome, PendingCallRecord, PendingCallSettlement, RegisterEventPendingCall, RegisterPendingCall } from "./pending-call-contract.ts";
import { PendingCallDeadlines, type PendingCallDeadlineOptions } from "./pending-call-deadlines.ts";

export class PendingCallRegistrationError extends Error {
  readonly code: "conflict" | "limit_exceeded";
  readonly retryable: boolean;
  constructor(code: "conflict" | "limit_exceeded", message: string, retryable = false) {
    super(message);
    this.name = "PendingCallRegistrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class PendingCallRegistry {
  private readonly maximum: number;
  private readonly byId = new Map<string, PendingCallRecord>();
  private readonly byRequestKey = new Map<string, string>();
  private readonly deadlines: PendingCallDeadlines;

  constructor(maximum: number, options: PendingCallDeadlineOptions = {}) {
    this.maximum = maximum;
    this.deadlines = new PendingCallDeadlines(options);
  }
  get size(): number { return this.byId.size; }
  hasRequestKey(requestKey?: string): boolean { return Boolean(requestKey && this.byRequestKey.has(requestKey)); }

  register(input: RegisterPendingCall): Promise<unknown> {
    this.assertCanRegister(input);
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.add(input, { kind: "promise", resolve: resolveResult, reject: rejectResult });
    return result;
  }

  registerEvent(input: RegisterEventPendingCall): void {
    this.assertCanRegister(input);
    this.add(input, { kind: "event", settle: input.settle });
  }

  resolve(id: string, socket: WebSocket, value: unknown): Promise<boolean> {
    const record = this.byId.get(id);
    return !record || record.socket !== socket ? Promise.resolve(false) : this.finish(id, { ok: true, value });
  }

  reject(id: string, error: Error, socket?: WebSocket): Promise<boolean> {
    const record = this.byId.get(id);
    return !record || (socket && record.socket !== socket) ? Promise.resolve(false) : this.finish(id, { ok: false, error });
  }

  async cancelRequest(requestKey: string, onCancel: (record: PendingCallRecord) => Error): Promise<boolean> {
    const id = this.byRequestKey.get(requestKey);
    return id ? this.fail(id, onCancel, "pending daemon call was cancelled") : false;
  }

  async rejectSocket(socket: WebSocket, createError: (record: PendingCallRecord) => Error): Promise<number> {
    const ids = [...this.byId.values()].filter((record) => record.socket === socket).map((record) => record.id);
    let rejected = 0;
    for (const id of ids) rejected += Number(await this.fail(id, createError, "pending daemon call failed"));
    return rejected;
  }

  detachSocket(socket: WebSocket, graceMs: number, createError: (record: PendingCallRecord) => Error): number {
    const records = [...this.byId.values()].filter((record) => record.socket === socket);
    const delay = Math.max(1, Math.floor(Number(graceMs) || 1));
    for (const record of records) {
      record.socket = undefined;
      this.deadlines.pauseOperation(record);
      this.deadlines.armReconnect(record, delay, (id) => { void this.expire(id, createError, "pending daemon reconnect expired"); });
    }
    return records.length;
  }

  rebindInstance(daemonInstanceId: string, socket: WebSocket): string[] {
    if (!daemonInstanceId) return [];
    const rebound: string[] = [];
    for (const record of this.byId.values()) {
      if (record.socket || record.daemonInstanceId !== daemonInstanceId) continue;
      this.deadlines.clearReconnect(record);
      record.socket = socket;
      this.deadlines.armOperation(record, record.remainingTimeoutMs, (id) => { void this.expireOperation(id); });
      rebound.push(record.id);
    }
    return rebound;
  }

  snapshot(): { active: number; detached: number; request_keys: number; maximum: number; oldest_ms: number; by_tool: Record<string, number> } {
    const now = this.deadlines.now();
    const byTool: Record<string, number> = {};
    let detached = 0;
    let oldestMs = 0;
    for (const record of this.byId.values()) {
      byTool[record.tool] = (byTool[record.tool] || 0) + 1;
      detached += Number(!record.socket);
      oldestMs = Math.max(oldestMs, now - record.startedAt);
    }
    return { active: this.byId.size, detached, request_keys: this.byRequestKey.size, maximum: this.maximum, oldest_ms: oldestMs, by_tool: byTool };
  }

  private assertCanRegister(input: RegisterPendingCall): void {
    if (this.byId.size >= this.maximum) throw new PendingCallRegistrationError("limit_exceeded", "too many concurrent daemon tool calls", true);
    if (this.byId.has(input.id)) throw new PendingCallRegistrationError("conflict", "duplicate internal daemon call id");
    if (input.clientRequestKey && this.byRequestKey.has(input.clientRequestKey)) {
      throw new PendingCallRegistrationError("conflict", "duplicate in-flight JSON-RPC request id within this MCP session");
    }
  }

  private add(input: RegisterPendingCall, settlement: PendingCallSettlement): void {
    const startedAt = this.deadlines.now();
    const timeoutMs = Math.max(1, Math.floor(Number(input.timeoutMs) || 1));
    const abortHandler = input.signal ? () => { void this.expire(input.id, input.onAbort, "pending daemon call was cancelled"); } : undefined;
    const record: PendingCallRecord = {
      id: input.id, socket: input.socket, daemonInstanceId: input.daemonInstanceId, clientRequestKey: input.clientRequestKey,
      tool: String(input.tool || "unknown"), startedAt, deadlineAt: startedAt + timeoutMs, remainingTimeoutMs: timeoutMs,
      onTimeout: input.onTimeout, settlement, signal: input.signal, abortHandler,
    };
    this.byId.set(input.id, record);
    if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
    this.deadlines.armOperation(record, timeoutMs, (id) => { void this.expireOperation(id); });
    if (input.signal?.aborted) void this.expire(input.id, input.onAbort, "pending daemon call was cancelled");
    else if (input.signal && abortHandler) input.signal.addEventListener("abort", abortHandler, { once: true });
  }

  private expireOperation(id: string): Promise<boolean> {
    const record = this.byId.get(id);
    return record ? this.fail(id, record.onTimeout, "pending daemon call timed out") : Promise.resolve(false);
  }

  private expire(id: string, createError: ((record: PendingCallRecord) => Error) | undefined, fallback: string): Promise<boolean> {
    const record = this.byId.get(id);
    return record && !record.socket && fallback.includes("reconnect") ? this.fail(id, createError, fallback)
      : record && !fallback.includes("reconnect") ? this.fail(id, createError, fallback) : Promise.resolve(false);
  }

  private async fail(id: string, createError: ((record: PendingCallRecord) => Error) | undefined, fallback: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record) return false;
    let error: Error;
    try { error = createError?.(record) ?? new Error(fallback); } catch { error = new Error(fallback); }
    return this.finish(id, { ok: false, error });
  }

  private async finish(id: string, outcome: PendingCallOutcome): Promise<boolean> {
    const record = this.take(id);
    if (!record) return false;
    if (record.settlement.kind === "promise") outcome.ok ? record.settlement.resolve(outcome.value) : record.settlement.reject(outcome.error);
    else await record.settlement.settle(outcome);
    return true;
  }

  private take(id: string): PendingCallRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    this.deadlines.clear(record);
    if (record.signal && record.abortHandler) record.signal.removeEventListener("abort", record.abortHandler);
    this.byId.delete(id);
    if (record.clientRequestKey && this.byRequestKey.get(record.clientRequestKey) === id) this.byRequestKey.delete(record.clientRequestKey);
    return record;
  }
}
