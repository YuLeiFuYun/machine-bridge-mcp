import type { PendingCallRecord, RegisterPendingCall } from "./pending-call-contract.ts";
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
  get size(): number {
    return this.byId.size;
  }

  hasRequestKey(requestKey?: string): boolean {
    return Boolean(requestKey && this.byRequestKey.has(requestKey));
  }

  register(input: RegisterPendingCall): Promise<unknown> {
    if (this.byId.size >= this.maximum) throw new PendingCallRegistrationError("limit_exceeded", "too many concurrent daemon tool calls", true);
    if (this.byId.has(input.id)) throw new PendingCallRegistrationError("conflict", "duplicate internal daemon call id");
    if (input.clientRequestKey && this.byRequestKey.has(input.clientRequestKey)) {
      throw new PendingCallRegistrationError("conflict", "duplicate in-flight JSON-RPC request id within this MCP session");
    }
    const startedAt = this.deadlines.now();
    const timeoutMs = Math.max(1, Math.floor(Number(input.timeoutMs) || 1));
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        const record = this.take(input.id);
        if (!record) return;
        let error: unknown;
        try { error = input.onAbort?.(record); }
        catch { error = new Error("pending daemon call was cancelled"); }
        reject(error instanceof Error ? error : new Error("pending daemon call was cancelled"));
      };
      const record: PendingCallRecord = {
        id: input.id,
        socket: input.socket,
        daemonInstanceId: input.daemonInstanceId,
        clientRequestKey: input.clientRequestKey,
        tool: String(input.tool || "unknown"),
        startedAt,
        deadlineAt: startedAt + timeoutMs,
        remainingTimeoutMs: timeoutMs,
        onTimeout: input.onTimeout,
        resolve,
        reject,
        signal: input.signal,
        abortHandler: input.signal ? abortHandler : undefined,
      };
      this.byId.set(input.id, record);
      if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
      this.deadlines.armOperation(record, timeoutMs, (id) => this.expireOperation(id));
      if (input.signal?.aborted) abortHandler();
      else input.signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  resolve(id: string, socket: WebSocket, value: unknown): boolean {
    const record = this.byId.get(id);
    if (!record || record.socket !== socket) return false;
    this.take(id)?.resolve(value);
    return true;
  }

  reject(id: string, error: Error, socket?: WebSocket): boolean {
    const record = this.byId.get(id);
    if (!record || (socket && record.socket !== socket)) return false;
    this.take(id)?.reject(error);
    return true;
  }

  cancelRequest(requestKey: string, onCancel: (record: PendingCallRecord) => Error): boolean {
    const id = this.byRequestKey.get(requestKey);
    if (!id) return false;
    const record = this.take(id);
    if (!record) return false;
    record.reject(onCancel(record));
    return true;
  }

  rejectSocket(socket: WebSocket, createError: (record: PendingCallRecord) => Error): number {
    const ids = [...this.byId.values()].filter((record) => record.socket === socket).map((record) => record.id);
    for (const id of ids) {
      const record = this.take(id);
      if (record) record.reject(createError(record));
    }
    return ids.length;
  }

  detachSocket(
    socket: WebSocket,
    graceMs: number,
    createError: (record: PendingCallRecord) => Error,
  ): number {
    const records = [...this.byId.values()].filter((record) => record.socket === socket);
    const delay = Math.max(1, Math.floor(Number(graceMs) || 1));
    for (const record of records) {
      record.socket = undefined;
      this.deadlines.pauseOperation(record);
      this.deadlines.armReconnect(record, delay, (id) => {
        const current = this.byId.get(id);
        if (!current || current.socket) return;
        const expired = this.take(id);
        if (expired) expired.reject(createError(expired));
      });
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
      this.deadlines.armOperation(record, record.remainingTimeoutMs, (id) => this.expireOperation(id));
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
      if (!record.socket) detached += 1;
      oldestMs = Math.max(oldestMs, now - record.startedAt);
    }
    return {
      active: this.byId.size,
      detached,
      request_keys: this.byRequestKey.size,
      maximum: this.maximum,
      oldest_ms: oldestMs,
      by_tool: byTool,
    };
  }

  private expireOperation(id: string): void {
    const record = this.take(id);
    if (!record) return;
    let error: unknown;
    try { error = record.onTimeout(record); }
    catch { error = new Error("pending daemon call timed out"); }
    record.reject(error instanceof Error ? error : new Error("pending daemon call timed out"));
  }

  private take(id: string): PendingCallRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    this.deadlines.clear(record);
    if (record.signal && record.abortHandler) record.signal.removeEventListener("abort", record.abortHandler);
    this.byId.delete(id);
    if (record.clientRequestKey && this.byRequestKey.get(record.clientRequestKey) === id) {
      this.byRequestKey.delete(record.clientRequestKey);
    }
    return record;
  }
}
