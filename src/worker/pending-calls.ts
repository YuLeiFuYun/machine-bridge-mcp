import { toolCallCapacityConfig, type ToolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { type PendingCallOutcome, type PendingCallRecord, type PendingCallSettlement, type RegisterPendingCall } from "./pending-call-contract.ts";
import { boundedPendingDelayMs, PendingCallDeadlines, type PendingCallDeadlineOptions } from "./pending-call-deadlines.ts";
import { pendingReadJobCallsForAccount, pendingRegistrySnapshot } from "./pending-call-capacity.ts";
import { assertPendingCallRegistration, pendingCallTimeoutMaximumMs } from "./pending-call-registration.ts";
import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { DaemonChannel } from "./daemon-channel.ts";
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
  get size(): number { return this.byId.size; } hasRequestKey(requestKey?: string): boolean { return Boolean(requestKey && this.byRequestKey.has(requestKey)); }
  readJobCallsForAccount(accountId: string): number { return pendingReadJobCallsForAccount(this.byId.values(), accountId); }
  resultOwnership(id: string, socket: DaemonChannel): "owned" | "missing" | "stale" {
    const record = this.byId.get(id); return !record ? "missing" : record.socket === socket ? "owned" : "stale";
  }
  nextDeadlineDelayMs(): number { return Math.min(Number.POSITIVE_INFINITY, ...[...this.byId.values()].map((record) => this.deadlines.nextDelayMs(record))); }
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
  resolve(id: string, socket: DaemonChannel, value: unknown): Promise<boolean> {
    const record = this.byId.get(id); return !record || record.socket !== socket ? Promise.resolve(false) : this.finish(id, { ok: true, value });
  }
  reject(id: string, error: Error, socket?: DaemonChannel): Promise<boolean> {
    const record = this.byId.get(id); return !record || (socket && record.socket !== socket) ? Promise.resolve(false) : this.finish(id, { ok: false, error });
  }

  async cancelRequest(requestKey: string, onCancel: (record: PendingCallRecord) => Error): Promise<boolean> {
    const id = this.byRequestKey.get(requestKey); return id ? this.fail(id, onCancel, "pending daemon call was cancelled") : false;
  }

  async cancelAuthority(revocation: AuthorityRevocation, onCancel: (record: PendingCallRecord) => Error): Promise<number> {
    const ids = [...this.byId.values()].filter((record) => recordMatchesAuthorityRevocation(record, revocation)).map((record) => record.id);
    let cancelled = 0;
    for (const id of ids) cancelled += Number(await this.fail(id, onCancel, "pending daemon authority was revoked"));
    return cancelled;
  }

  async rejectSocket(socket: DaemonChannel, createError: (record: PendingCallRecord) => Error): Promise<number> {
    const ids = [...this.byId.values()].filter((record) => record.socket === socket).map((record) => record.id);
    return this.rejectSocketIds(ids, socket, createError, "pending daemon call failed");
  }

  async rejectSocketIds(ids: Iterable<string>, socket: DaemonChannel, createError: (record: PendingCallRecord) => Error, fallback = "pending daemon call was not received", beforeReject?: (record: PendingCallRecord) => boolean): Promise<number> {
    let rejected = 0;
    for (const id of ids) {
      const record = this.byId.get(id); if (record?.socket === socket && beforeReject?.(record) !== true) rejected += Number(await this.fail(id, createError, fallback));
    }
    return rejected;
  }

  detachSocket(socket: DaemonChannel, graceMs: number, createError: (record: PendingCallRecord) => Error): number {
    const records = [...this.byId.values()].filter((record) => record.socket === socket);
    const maximumGrace = boundedPendingDelayMs(graceMs, relayContract.reconnectGraceMs);
    for (const record of records) {
      record.socket = undefined;
      record.onReconnectTimeout = createError;
      this.deadlines.pauseOperation(record);
      const delay = Math.min(maximumGrace, record.remainingTimeoutMs);
      this.deadlines.armReconnect(record, delay, (id) => { void this.expireReconnect(id); });
    }
    return records.length;
  }

  rebindInstance(daemonInstanceId: string, socket: DaemonChannel): string[] {
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
    assertPendingCallRegistration(input, {
      records: this.byId.values(), active: snapshot.active, byTool: snapshot.by_tool, capacity: this.capacity,
      idExists: this.byId.has(input.id), requestKeyExists: Boolean(input.clientRequestKey && this.byRequestKey.has(input.clientRequestKey)),
    });
  }

  private add(input: RegisterPendingCall, settlement: PendingCallSettlement): void {
    const startedAt = this.deadlines.now();
    const timeoutMs = boundedPendingDelayMs(input.timeoutMs, pendingCallTimeoutMaximumMs(input.tool));
    const abortHandler = input.signal ? () => { void this.expire(input.id, input.onAbort, "pending daemon call was cancelled"); } : undefined;
    const record: PendingCallRecord = {
      id: input.id, socket: input.socket, daemonInstanceId: input.daemonInstanceId, clientRequestKey: input.clientRequestKey,
      ...(input.authority ? {
        owner_kind: "account" as const, owner_account_id: input.authority.accountId,
        owner_account_version: input.authority.accountVersion, owner_client_id: input.authority.clientId,
        owner_family_id: input.authority.familyId,
      } : {}),
      tool: String(input.tool || "unknown"), ...(input.recovery ? { recovery: input.recovery } : {}),
      startedAt, deadlineAt: startedAt + timeoutMs, remainingTimeoutMs: timeoutMs,
      onTimeout: input.onTimeout, redeliverAfterProvenMissing: input.redeliverAfterProvenMissing, settlement, signal: input.signal, abortHandler,
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
