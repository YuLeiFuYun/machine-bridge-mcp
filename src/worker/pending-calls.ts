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

export interface PendingCallRecord {
  id: string;
  socket: WebSocket;
  clientRequestKey?: string;
  tool: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface RegisterPendingCall {
  id: string;
  socket: WebSocket;
  clientRequestKey?: string;
  tool: string;
  timeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  signal?: AbortSignal;
  onAbort?: (record: PendingCallRecord) => Error;
}

export class PendingCallRegistry {
  private readonly maximum: number;
  private readonly byId = new Map<string, PendingCallRecord>();
  private readonly byRequestKey = new Map<string, string>();

  constructor(maximum: number) {
    this.maximum = maximum;
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
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const record = this.take(input.id);
        if (!record) return;
        let error: unknown;
        try { error = input.onTimeout(record); }
        catch { error = new Error("pending daemon call timed out"); }
        reject(error instanceof Error ? error : new Error("pending daemon call timed out"));
      }, input.timeoutMs);
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
        clientRequestKey: input.clientRequestKey,
        tool: String(input.tool || "unknown"),
        startedAt,
        timeout,
        resolve,
        reject,
        signal: input.signal,
        abortHandler: input.signal ? abortHandler : undefined,
      };
      this.byId.set(input.id, record);
      if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
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

  snapshot(): { active: number; request_keys: number; maximum: number; oldest_ms: number; by_tool: Record<string, number> } {
    const now = performance.now();
    const byTool: Record<string, number> = {};
    let oldestMs = 0;
    for (const record of this.byId.values()) {
      byTool[record.tool] = (byTool[record.tool] || 0) + 1;
      oldestMs = Math.max(oldestMs, now - record.startedAt);
    }
    return {
      active: this.byId.size,
      request_keys: this.byRequestKey.size,
      maximum: this.maximum,
      oldest_ms: oldestMs,
      by_tool: byTool,
    };
  }

  private take(id: string): PendingCallRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    clearTimeout(record.timeout);
    if (record.signal && record.abortHandler) record.signal.removeEventListener("abort", record.abortHandler);
    this.byId.delete(id);
    if (record.clientRequestKey && this.byRequestKey.get(record.clientRequestKey) === id) {
      this.byRequestKey.delete(record.clientRequestKey);
    }
    return record;
  }
}
