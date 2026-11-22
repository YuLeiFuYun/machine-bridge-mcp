import { toolCallCapacityConfig, type ToolCallCapacityConfig, toolCallAdmission, CONTROL_PLANE_TOOL_NAMES, toolCallCapacityUsage, type ToolCallAdmission } from "../../shared/tool-call-capacity.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import type { DaemonChannel } from "../daemon/channel.ts";
import { WorkerToolError } from "./errors.ts";

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
      this.extendSettlementForReconnect(record);
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
      this.extendSettlementForReconnect(record);
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
      startedAt, originalDeadlineAt: startedAt + timeoutMs, deadlineAt: startedAt + timeoutMs, remainingTimeoutMs: timeoutMs,
      onTimeout: input.onTimeout, redeliverAfterProvenMissing: input.redeliverAfterProvenMissing, settlement, signal: input.signal, abortHandler,
    };
    this.byId.set(input.id, record);
    if (input.clientRequestKey) this.byRequestKey.set(input.clientRequestKey, input.id);
    this.deadlines.armOperation(record, timeoutMs, (id) => { void this.expireOperation(id); });
    if (input.signal?.aborted) void this.expire(input.id, input.onAbort, "pending daemon call was cancelled");
    else if (input.signal && abortHandler) input.signal.addEventListener("abort", abortHandler, { once: true });
  }

  private expireOperation(id: string): Promise<boolean> { return this.expireRecord(this.byId.get(id)); }
  private extendSettlementForReconnect(record: PendingCallRecord): void {
    Object.assign(record, pendingCallReconnectSettlement(record, this.deadlines.now()));
  }
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
export type PendingCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

export type PendingCallSettlement = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

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
  socket?: DaemonChannel;
  daemonInstanceId?: string;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  reconnectDeadlineAt?: number;
  onReconnectTimeout?: (record: PendingCallRecord) => Error;
  clientRequestKey?: string;
  owner_kind?: "account";
  owner_account_id?: string;
  owner_account_version?: number;
  owner_client_id?: string;
  owner_family_id?: string;
  tool: string;
  recovery?: Record<string, unknown>;
  startedAt: number;
  originalDeadlineAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  remainingTimeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  redeliverAfterProvenMissing?: (record: PendingCallRecord, channel: DaemonChannel) => boolean;
  provenMissingRedeliveryChannel?: DaemonChannel;
  settlement: PendingCallSettlement;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface RegisterPendingCall {
  id: string;
  socket: DaemonChannel;
  daemonInstanceId?: string;
  clientRequestKey?: string;
  authority?: AuthorityRevocation;
  tool: string;
  recovery?: Record<string, unknown>;
  timeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  redeliverAfterProvenMissing?: (record: PendingCallRecord, channel: DaemonChannel) => boolean;
  signal?: AbortSignal;
  onAbort?: (record: PendingCallRecord) => Error;
}
type TimerHandle = ReturnType<typeof setTimeout>;

export type PendingCallDeadlineOptions = {
  now?: () => number;
  scheduler?: {
    setTimeout: (callback: () => void, delay: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle) => void;
  };
};

export class PendingCallDeadlines {
  private readonly clock: () => number;
  private readonly scheduler: Required<PendingCallDeadlineOptions>["scheduler"];

  constructor(options: PendingCallDeadlineOptions = {}) {
    this.clock = options.now ?? (() => performance.now());
    this.scheduler = options.scheduler ?? { setTimeout, clearTimeout };
  }

  now(): number {
    return this.clock();
  }

  nextDelayMs(record: PendingCallRecord): number {
    const deadline = record.socket ? record.deadlineAt : record.reconnectDeadlineAt;
    return Number.isFinite(deadline) ? Math.max(0, Number(deadline) - this.clock()) : Number.POSITIVE_INFINITY;
  }

  isDue(record: PendingCallRecord, now = this.clock()): boolean {
    const deadline = record.socket ? record.deadlineAt : record.reconnectDeadlineAt;
    return Number.isFinite(deadline) && Number(deadline) <= now;
  }

  armOperation(record: PendingCallRecord, delayMs: number, expire: (id: string) => void): void {
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    const delay = boundedPendingDelayMs(delayMs);
    record.remainingTimeoutMs = delay;
    record.deadlineAt = this.clock() + delay;
    record.timeout = this.scheduler.setTimeout(() => expire(record.id), delay);
  }

  pauseOperation(record: PendingCallRecord): void {
    record.remainingTimeoutMs = Math.max(1, Math.ceil(record.deadlineAt - this.clock()));
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    record.timeout = undefined;
  }

  armReconnect(record: PendingCallRecord, delayMs: number, expire: (id: string) => void): void {
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    const delay = boundedPendingDelayMs(delayMs);
    record.reconnectDeadlineAt = this.clock() + delay;
    record.reconnectTimeout = this.scheduler.setTimeout(() => expire(record.id), delay);
  }

  clearReconnect(record: PendingCallRecord): void {
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    record.reconnectTimeout = undefined;
    record.reconnectDeadlineAt = undefined;
  }

  clear(record: PendingCallRecord): void {
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    record.reconnectDeadlineAt = undefined;
  }
}

export function boundedPendingDelayMs(value: unknown, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("pending-call delay maximum must be a positive safe integer");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`pending-call delay must be an integer from 1 to ${maximum}`);
  }
  return value;
}
type PendingRegistrationState = Readonly<{
  records: Iterable<PendingCallRecord>;
  active: number;
  byTool: Record<string, number>;
  capacity: ToolCallCapacityConfig;
  idExists: boolean;
  requestKeyExists: boolean;
}>;

export function assertPendingCallRegistration(input: RegisterPendingCall, state: PendingRegistrationState): void {
  boundedPendingDelayMs(input.timeoutMs, pendingCallTimeoutMaximumMs(input.tool));
  const decision = toolCallAdmission({ active: state.active, byTool: state.byTool }, state.capacity, input.tool);
  if (!decision.allowed) {
    const message = decision.reason === "ordinary_capacity"
      ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
      : "too many concurrent daemon tool calls";
    throw new PendingCallRegistrationError("limit_exceeded", message, true);
  }
  if (state.idExists) throw new PendingCallRegistrationError("conflict", "duplicate internal daemon call id");
  if (input.clientRequestKey && state.requestKeyExists) {
    throw new PendingCallRegistrationError("conflict", "duplicate in-flight response-stream request key");
  }
  if (input.tool === "read_job" && input.authority?.accountId
      && pendingReadJobCallsForAccount(state.records, input.authority.accountId) >= MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT) {
    throw new PendingCallRegistrationError(
      "limit_exceeded",
      `managed-job read capacity reached for this account (${MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT})`,
      true,
    );
  }
}

export function pendingCallTimeoutMaximumMs(tool: string): number {
  return tool === "read_job"
    ? relayContract.maximumRelayToolTimeoutMs
    : relayContract.maximumOrdinaryRelayToolTimeoutMs;
}
type ReconnectSettlementRecord = Pick<PendingCallRecord, "originalDeadlineAt" | "deadlineAt">;

export function pendingCallReconnectSettlement(record: ReconnectSettlementRecord, now: number): { deadlineAt: number; remainingTimeoutMs: number } {
  // Execution and redelivery authority are bounded separately by the original execution budget.
  // This deadline only governs terminal-result delivery after reconnect, so the one-time delivery
  // grace may extend beyond the initial settlement ceiling without extending execution authority.
  const recoveryDeadlineAt = record.originalDeadlineAt + relayContract.reconnectResultDeliveryGraceMs;
  const deadlineAt = Math.max(record.deadlineAt, recoveryDeadlineAt);
  return { deadlineAt, remainingTimeoutMs: Math.max(1, Math.ceil(deadlineAt - now)) };
}
export { CONTROL_PLANE_TOOL_NAMES };

export const MAX_PENDING_CALLS = 32;

export const RESERVED_CONTROL_PENDING_CALLS = 2;

export const MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT = 8;

export const WORKER_PENDING_CALL_CAPACITY = toolCallCapacityConfig(
  MAX_PENDING_CALLS,
  RESERVED_CONTROL_PENDING_CALLS,
  CONTROL_PLANE_TOOL_NAMES,
);

export const WORKER_PENDING_REGISTRY_OPTIONS = Object.freeze({
  reservedCapacity: RESERVED_CONTROL_PENDING_CALLS,
  reservedTools: CONTROL_PLANE_TOOL_NAMES,
});

export type PendingRegistrySnapshot = PendingCapacitySnapshot & {
  detached: number;
  request_keys: number;
  maximum: number;
  ordinary_capacity: number;
  reserved_capacity: number;
  active_reserved: number;
  active_ordinary: number;
  oldest_ms: number;
};

export function pendingRegistrySnapshot(
  records: Iterable<PendingCallRecord>,
  requestKeyCount: number,
  now: number,
  config: ToolCallCapacityConfig,
): PendingRegistrySnapshot {
  const byTool = Object.create(null) as Record<string, number>;
  let active = 0;
  let detached = 0;
  let oldestMs = 0;
  for (const record of records) {
    active += 1;
    byTool[record.tool] = (byTool[record.tool] ?? 0) + 1;
    detached += Number(!record.socket);
    oldestMs = Math.max(oldestMs, now - record.startedAt);
  }
  const usage = toolCallCapacityUsage({ active, byTool }, config);
  return {
    active,
    detached,
    request_keys: requestKeyCount,
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_capacity: usage.reserved,
    active_reserved: usage.activeReserved,
    active_ordinary: usage.activeOrdinary,
    oldest_ms: oldestMs,
    by_tool: byTool,
  };
}

export type PendingCapacitySnapshot = {
  active: number;
  by_tool: Record<string, number>;
};

export function pendingCallAdmission(
  pending: PendingCapacitySnapshot,
  tool: string,
  config: ToolCallCapacityConfig = WORKER_PENDING_CALL_CAPACITY,
): ToolCallAdmission {
  return toolCallAdmission(pending, config, tool);
}

export function pendingReadJobCallsForAccount(
  records: Iterable<Readonly<{ tool: string; owner_account_id?: string }>>,
  accountId: string,
): number {
  const key = typeof accountId === "string" ? accountId : "";
  if (!key) return 0;
  let active = 0;
  for (const record of records) {
    if (record.tool === "read_job" && record.owner_account_id === key) active += 1;
  }
  return active;
}

export function pendingCapacityProjection(
  pending: PendingRegistrySnapshot,
  preDispatch: PendingCapacitySnapshot,
): PendingRegistrySnapshot & Record<string, unknown> {
  const byTool = { ...pending.by_tool };
  for (const [tool, count] of Object.entries(preDispatch.by_tool)) byTool[tool] = (byTool[tool] ?? 0) + count;
  const usage = toolCallCapacityUsage({ active: pending.active + preDispatch.active, byTool }, WORKER_PENDING_CALL_CAPACITY);
  return Object.freeze({
    ...pending,
    pre_dispatch_waiters: preDispatch.active,
    capacity_active: usage.active,
    capacity_active_ordinary: usage.activeOrdinary,
    capacity_active_reserved: usage.activeReserved,
  });
}

export function assertWorkerPendingCallAdmission(
  pending: PendingCapacitySnapshot,
  tool: string,
): void {
  const decision = pendingCallAdmission(pending, tool);
  if (decision.allowed) return;
  const message = decision.reason === "ordinary_capacity"
    ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
    : "too many concurrent daemon tool calls";
  throw new WorkerToolError("limit_exceeded", message, true);
}
