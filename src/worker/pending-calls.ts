export interface PendingCallRecord {
  id: string;
  socket: WebSocket;
  clientRequestKey?: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface RegisterPendingCall {
  id: string;
  socket: WebSocket;
  clientRequestKey?: string;
  timeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
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
    if (this.byId.size >= this.maximum) throw new Error("too many concurrent daemon tool calls");
    if (this.byId.has(input.id)) throw new Error("duplicate internal daemon call id");
    if (input.clientRequestKey && this.byRequestKey.has(input.clientRequestKey)) {
      throw new Error("duplicate in-flight JSON-RPC request id for this access token");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const record = this.take(input.id);
        if (!record) return;
        let error: unknown;
        try { error = input.onTimeout(record); }
        catch { error = new Error("pending daemon call timed out"); }
        reject(error instanceof Error ? error : new Error("pending daemon call timed out"));
      }, input.timeoutMs);
      const record: PendingCallRecord = {
        id: input.id,
        socket: input.socket,
        clientRequestKey: input.clientRequestKey,
        timeout,
        resolve,
        reject,
      };
      this.byId.set(input.id, record);
      if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
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

  snapshot(): { active: number; request_keys: number; maximum: number } {
    return { active: this.byId.size, request_keys: this.byRequestKey.size, maximum: this.maximum };
  }

  private take(id: string): PendingCallRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    clearTimeout(record.timeout);
    this.byId.delete(id);
    if (record.clientRequestKey && this.byRequestKey.get(record.clientRequestKey) === id) {
      this.byRequestKey.delete(record.clientRequestKey);
    }
    return record;
  }
}
