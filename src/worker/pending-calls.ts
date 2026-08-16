import { toolCallAdmission, toolCallCapacityConfig, type ToolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import { PendingCallRegistrationError, type PendingCallOutcome, type PendingCallRecord, type PendingCallSettlement, type RegisterPendingCall } from "./pending-call-contract.ts";
import { PendingCallDeadlines, type PendingCallDeadlineOptions } from "./pending-call-deadlines.ts";
import { pendingRegistrySnapshot } from "./pending-call-capacity.ts";
import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../shared/authority-revocation.mjs";
type PendingCallRegistryOptions = PendingCallDeadlineOptions & {
  reservedCapacity?: number;
  reservedTools?: Iterable<string>;
};
export class PendingCallRegistry {
  private readonly capacity: ToolCallCapacityConfig;
  private readonly byId = new Map<string, PendingCallRecord>();
  private readonly byRequestKey = new Map<string, string>();
  private readonly deadlines: PendingCallDeadlines;
  constructor(maximum: number, options: PendingCallRegistryOptions = {}) {
    this.capacity = toolCallCapacityConfig(maximum, options.reservedCapacity, options.reservedTools);
    this.deadlines = new PendingCallDeadlines(options);
  }
  get size(): number { return this.byId.size; }
  hasRequestKey(requestKey?: string): boolean { return Boolean(requestKey && this.byRequestKey.has(requestKey)); }
  resultOwnership(id: string, socket: WebSocket): "owned" | "missing" | "stale" {
    const record = this.byId.get(id); return !record ? "missing" : record.socket === socket ? "owned" : "stale";
  }
  nextDeadlineDelayMs(): number {
    return Math.min(Number.POSITIVE_INFINITY, ...[...this.byId.values()].map((record) => this.deadlines.nextDelayMs(record)));
  }
  async expireDue(now = this.deadlines.now()): Promise<number> {
    const due = [...this.byId.values()].filter((record) => this.deadlines.isDue(record, now));
    let expired = 0;
    for (const record of due) expired += Number(await this.expireRecord(record));
    return expired;
  }

  register(input: RegisterPendingCall): Promise<unknown> {
    this.assertCanRegister(input);
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.add(input, { resolve: resolveResult, reject: rejectResult });
    return result;
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

  async cancelAuthority(revocation: AuthorityRevocation, onCancel: (record: PendingCallRecord) => Error): Promise<number> {
    const ids = [...this.byId.values()].filter((record) => recordMatchesAuthorityRevocation(record, revocation)).map((record) => record.id);
    let cancelled = 0;
    for (const id of ids) cancelled += Number(await this.fail(id, onCancel, "pending daemon authority was revoked"));
    return cancelled;
  }

  async rejectSocket(socket: WebSocket, createError: (record: PendingCallRecord) => Error): Promise<number> {
    const ids = [...this.byId.values()].filter((record) => record.socket === socket).map((record) => record.id);
    let rejected = 0;
    for (const id of ids) rejected += Number(await this.fail(id, createError, "pending daemon call failed"));
    return rejected;
  }

  detachSocket(socket: WebSocket, graceMs: number, createError: (record: PendingCallRecord) => Error): number {
    const records = [...this.byId.values()].filter((record) => record.socket === socket);
    const maximumGrace = Math.max(1, Math.floor(Number(graceMs) || 1));
    for (const record of records) {
      record.socket = undefined;
      record.onReconnectTimeout = createError;
      this.deadlines.pauseOperation(record);
      const delay = Math.min(maximumGrace, record.remainingTimeoutMs);
      this.deadlines.armReconnect(record, delay, (id) => { void this.expireReconnect(id); });
    }
    return records.length;
  }

  rebindInstance(daemonInstanceId: string, socket: WebSocket): string[] {
    if (!daemonInstanceId) return [];
    const rebound: string[] = [];
    for (const record of this.byId.values()) {
      if (record.daemonInstanceId !== daemonInstanceId || record.socket === socket) continue;
      if (record.socket) this.deadlines.pauseOperation(record);
      else this.deadlines.clearReconnect(record);
      const remainingTimeoutMs = Math.max(1, Math.ceil(record.deadlineAt - this.deadlines.now()));
      record.onReconnectTimeout = undefined;
      record.socket = socket;
      this.deadlines.armOperation(record, remainingTimeoutMs, (id) => { void this.expireOperation(id); });
      rebound.push(record.id);
    }
    return rebound;
  }

  snapshot() {
    return pendingRegistrySnapshot(this.byId.values(), this.byRequestKey.size, this.deadlines.now(), this.capacity);
  }

  private assertCanRegister(input: RegisterPendingCall): void {
    const snapshot = this.snapshot();
    const decision = toolCallAdmission({ active: snapshot.active, byTool: snapshot.by_tool }, this.capacity, input.tool);
    if (!decision.allowed) {
      const message = decision.reason === "ordinary_capacity"
        ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
        : "too many concurrent daemon tool calls";
      throw new PendingCallRegistrationError("limit_exceeded", message, true);
    }
    if (this.byId.has(input.id)) throw new PendingCallRegistrationError("conflict", "duplicate internal daemon call id");
    if (input.clientRequestKey && this.byRequestKey.has(input.clientRequestKey)) {
      throw new PendingCallRegistrationError("conflict", "duplicate in-flight response-stream request key");
    }
  }

  private add(input: RegisterPendingCall, settlement: PendingCallSettlement): void {
    const startedAt = this.deadlines.now();
    const timeoutMs = Math.max(1, Math.floor(Number(input.timeoutMs) || 1));
    const abortHandler = input.signal ? () => { void this.expire(input.id, input.onAbort, "pending daemon call was cancelled"); } : undefined;
    const record: PendingCallRecord = {
      id: input.id, socket: input.socket, daemonInstanceId: input.daemonInstanceId, clientRequestKey: input.clientRequestKey,
      ...(input.authority ? {
        owner_kind: "account" as const, owner_account_id: input.authority.accountId,
        owner_account_version: input.authority.accountVersion, owner_client_id: input.authority.clientId,
        owner_family_id: input.authority.familyId,
      } : {}),
      tool: String(input.tool || "unknown"), startedAt, deadlineAt: startedAt + timeoutMs, remainingTimeoutMs: timeoutMs,
      onTimeout: input.onTimeout, settlement, signal: input.signal, abortHandler,
    };
    this.byId.set(input.id, record);
    if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
    this.deadlines.armOperation(record, timeoutMs, (id) => { void this.expireOperation(id); });
    if (input.signal?.aborted) void this.expire(input.id, input.onAbort, "pending daemon call was cancelled");
    else if (input.signal && abortHandler) input.signal.addEventListener("abort", abortHandler, { once: true });
  }

  private expireOperation(id: string): Promise<boolean> { return this.expireRecord(this.byId.get(id)); }
  private expireReconnect(id: string): Promise<boolean> {
    const record = this.byId.get(id); return record && !record.socket ? this.expireRecord(record) : Promise.resolve(false);
  }
  private expireRecord(record?: PendingCallRecord): Promise<boolean> {
    if (!record) return Promise.resolve(false);
    return record.socket
      ? this.fail(record.id, record.onTimeout, "pending daemon call timed out")
      : this.fail(record.id, record.onReconnectTimeout, "pending daemon reconnect expired");
  }
  private expire(id: string, createError: ((record: PendingCallRecord) => Error) | undefined, fallback: string): Promise<boolean> {
    const record = this.byId.get(id);
    const applicable = record && (fallback.includes("reconnect") ? !record.socket : true);
    return applicable ? this.fail(id, createError, fallback) : Promise.resolve(false);
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
    outcome.ok ? record.settlement.resolve(outcome.value) : record.settlement.reject(outcome.error);
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
