import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "../room/errors.ts";
import { readyDaemonChannels, type DaemonChannel, type ReadyDaemonRegistry } from "./channel.ts";
import { assertWorkerPendingCallAdmission, type PendingCapacitySnapshot, MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, pendingReadJobCallsForAccount } from "../room/pending-calls.ts";
import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import type { PendingCallRecord } from "../room/pending-calls.ts";
import type { DaemonToolTimeoutBudget } from "../room/tool-timeout.ts";

type WaitOptions = Readonly<{
  graceMs?: number; signal?: AbortSignal; tool?: string; pending?: PendingCapacitySnapshot;
  authority?: ReadyWaiterAuthority; activeReadJobCallsForAccount?: number;
}>;

export async function waitForReadyDaemon(registry: ReadyDaemonRegistry, options: WaitOptions = {}): Promise<DaemonChannel> {
  if (options.signal?.aborted) throw cancelledError();
  const waiters = readyWaiterSet(registry);
  const hadWaiters = waiters.size > 0;
  const immediate = readyDaemonChannels(registry)[0];
  if (immediate && !hadWaiters) return immediate;
  const graceMs = positiveInteger(options.graceMs, relayContract.newCallReconnectGraceMs);
  const tool = String(options.tool || "unknown");
  assertReadyWaiterReadJobCapacity(waiters, tool, options.authority, options.activeReadJobCallsForAccount);
  const byTool: Record<string, number> = { ...(options.pending?.by_tool ?? {}) };
  for (const waiter of waiters) byTool[waiter.tool] = (byTool[waiter.tool] ?? 0) + 1;
  assertWorkerPendingCallAdmission({ active: (options.pending?.active ?? 0) + waiters.size, by_tool: byTool }, tool);
  retainReadyWaiters(registry, waiters);
  return new Promise<DaemonChannel>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (socket?: DaemonChannel, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      releaseReadyWaiter(registry, waiters, waiter);
      options.signal?.removeEventListener("abort", abort);
      if (socket) resolvePromise(socket); else rejectPromise(error ?? unavailableError(graceMs));
    };
    const waiter = {
      tool, ...readyWaiterAuthorityFields(options.authority),
      resolve: (socket: DaemonChannel) => finish(socket), revoke: () => finish(undefined, revokedError()),
    } as ReadyWaiter;
    const abort = () => finish(undefined, cancelledError());
    waiters.add(waiter);
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(undefined, unavailableError(graceMs)), graceMs);
    const raced = readyDaemonChannels(registry)[0];
    if (raced && !hadWaiters) finish(raced);
  });
}

function unavailableError(graceMs: number): WorkerToolError {
  return new WorkerToolError("unavailable", `local daemon did not reconnect within ${Math.ceil(graceMs / 1000)} seconds; keep the CLI start command running`, true);
}

function cancelledError(): WorkerToolError {
  return new WorkerToolError("cancelled", "tool call cancelled while waiting for local daemon recovery");
}

function revokedError(): WorkerToolError {
  return new WorkerToolError("authorization_denied", "tool call authorization was revoked while waiting for local daemon recovery");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}
export type ReadyWaiterAuthority = Readonly<{
  accountId: string;
  accountVersion: number;
  clientId: string;
  familyId: string;
}>;

export type ReadyWaiterPolicyRecord = Readonly<{
  tool: string;
  owner_kind?: "account";
  owner_account_id?: string;
  owner_account_version?: number;
  owner_client_id?: string;
  owner_family_id?: string;
}>;

export function readyWaiterAuthorityFields(authority?: ReadyWaiterAuthority): Record<string, unknown> {
  if (!authority?.accountId) return {};
  return {
    owner_kind: "account",
    owner_account_id: authority.accountId,
    owner_account_version: authority.accountVersion,
    owner_client_id: authority.clientId,
    owner_family_id: authority.familyId,
  };
}

export function assertReadyWaiterReadJobCapacity(
  waiters: Iterable<ReadyWaiterPolicyRecord>,
  tool: string,
  authority?: ReadyWaiterAuthority,
  activeReadJobCallsForAccount = 0,
): void {
  if (tool !== "read_job" || !authority?.accountId) return;
  const waiting = pendingReadJobCallsForAccount(waiters, authority.accountId);
  const active = Number.isFinite(activeReadJobCallsForAccount)
    ? Math.max(0, Math.floor(activeReadJobCallsForAccount)) : 0;
  if (active + waiting < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT) return;
  throw new WorkerToolError(
    "limit_exceeded",
    `managed-job read capacity reached for this account (${MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT})`,
    true,
  );
}

export function readyWaiterMatchesRevocation(
  waiter: ReadyWaiterPolicyRecord,
  revocation: AuthorityRevocation,
): boolean {
  return recordMatchesAuthorityRevocation(waiter, revocation);
}
export type ReadyWaiter = ReadyWaiterPolicyRecord & Readonly<{
  resolve: (socket: DaemonChannel) => void;
  revoke: () => void;
}>;

const waitersByRegistry = new WeakMap<ReadyDaemonRegistry, Set<ReadyWaiter>>();

export function readyWaiterSet(registry: ReadyDaemonRegistry): Set<ReadyWaiter> {
  return waitersByRegistry.get(registry) ?? new Set<ReadyWaiter>();
}

export function retainReadyWaiters(registry: ReadyDaemonRegistry, waiters: Set<ReadyWaiter>): void {
  waitersByRegistry.set(registry, waiters);
}

export function releaseReadyWaiter(
  registry: ReadyDaemonRegistry,
  waiters: Set<ReadyWaiter>,
  waiter: ReadyWaiter,
): void {
  waiters.delete(waiter);
  if (waiters.size === 0) waitersByRegistry.delete(registry);
}

export function notifyReadyDaemon(registry: ReadyDaemonRegistry): number {
  const socket = readyDaemonChannels(registry)[0];
  const waiters = waitersByRegistry.get(registry);
  if (!socket || !waiters?.size) return 0;
  const count = waiters.size;
  waitersByRegistry.delete(registry);
  for (const waiter of [...waiters]) waiter.resolve(socket);
  return count;
}

export function cancelReadyDaemonAuthority(registry: ReadyDaemonRegistry, revocation: AuthorityRevocation): number {
  const waiters = waitersByRegistry.get(registry);
  if (!waiters?.size) return 0;
  const matching = [...waiters].filter((waiter) => readyWaiterMatchesRevocation(waiter, revocation));
  for (const waiter of matching) waiter.revoke();
  return matching.length;
}

export function readyDaemonWaiterSnapshot(registry: ReadyDaemonRegistry): PendingCapacitySnapshot {
  const waiters = waitersByRegistry.get(registry) ?? new Set<ReadyWaiter>();
  const by_tool: Record<string, number> = {};
  for (const waiter of waiters) by_tool[waiter.tool] = (by_tool[waiter.tool] ?? 0) + 1;
  return { active: waiters.size, by_tool };
}
type ReadyWaitOptions = Parameters<typeof waitForReadyDaemon>[1];

type ReadyDispatch = Readonly<{ socket: DaemonChannel; recoveryDelayMs: number }>;

export function immediateReadyDaemonForDispatch(registry: ReadyDaemonRegistry): ReadyDispatch | null {
  if (readyDaemonWaiterSnapshot(registry).active > 0) return null;
  const socket = readyDaemonChannels(registry)[0];
  return socket ? Object.freeze({ socket, recoveryDelayMs: 0 }) : null;
}

export async function readyDaemonForDispatch(
  registry: ReadyDaemonRegistry,
  options: ReadyWaitOptions = {},
  now: () => number = () => performance.now(),
): Promise<ReadyDispatch> {
  if (options.signal?.aborted) throw new WorkerToolError("cancelled", "tool call cancelled before local daemon dispatch");
  const immediate = immediateReadyDaemonForDispatch(registry);
  if (immediate) return immediate;
  const startedAt = now();
  const socket = await waitForReadyDaemon(registry, options);
  return Object.freeze({ socket, recoveryDelayMs: Math.max(0, now() - startedAt) });
}
export function daemonToolTimeoutBudgetAfterDelay(budget: DaemonToolTimeoutBudget, elapsedMs: number): DaemonToolTimeoutBudget {
  const elapsed = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  const settlementTimeoutMs = Math.max(0, budget.settlementTimeoutMs - elapsed);
  const executionTimeoutMs = Math.min(budget.executionTimeoutMs, settlementTimeoutMs - relayContract.workerSettlementOverheadMs);
  if (executionTimeoutMs < 1) {
    throw new WorkerToolError("unavailable", "local daemon recovery consumed the tool execution window; retry the call", true, { side_effects_started: false });
  }
  return Object.freeze({ executionTimeoutMs: Math.floor(executionTimeoutMs), settlementTimeoutMs: Math.floor(settlementTimeoutMs) });
}

export function daemonReconnectExpiry(
  record: Pick<PendingCallRecord, "remainingTimeoutMs" | "originalDeadlineAt" | "deadlineAt">, reconnectGraceMs: number,
) {
  const grace = Math.min(relayContract.reconnectGraceMs, Math.max(1, Math.floor(reconnectGraceMs)));
  if (record.remainingTimeoutMs < grace && record.deadlineAt > record.originalDeadlineAt) {
    return {
      reason: "terminal_result_delivery_grace_expired",
      message: "terminal result delivery grace expired during reconnect",
    };
  }
  return record.remainingTimeoutMs < grace
    ? { reason: "original_call_deadline_expired_during_reconnect", message: "original call deadline expired during reconnect" }
    : { reason: "reconnect_grace_expired", message: "reconnect grace expired" };
}
