import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "./errors.ts";
import { readyDaemonChannels, type DaemonChannel, type ReadyDaemonRegistry } from "./daemon-channel.ts";
import { assertWorkerPendingCallAdmission, type PendingCapacitySnapshot } from "./pending-call-capacity.ts";
import { assertReadyWaiterReadJobCapacity, readyWaiterAuthorityFields, type ReadyWaiterAuthority } from "./daemon-ready-waiter-policy.ts";
import { readyWaiterSet, releaseReadyWaiter, retainReadyWaiters, type ReadyWaiter } from "./daemon-ready-waiter-state.ts";
export { cancelReadyDaemonAuthority, notifyReadyDaemon, readyDaemonWaiterSnapshot } from "./daemon-ready-waiter-state.ts";

type WaitOptions = Readonly<{
  graceMs?: number; signal?: AbortSignal; tool?: string; pending?: PendingCapacitySnapshot;
  authority?: ReadyWaiterAuthority; activeReadJobCallsForAccount?: number;
}>;

export async function waitForReadyDaemon(registry: ReadyDaemonRegistry, options: WaitOptions = {}): Promise<DaemonChannel> {
  const waiters = readyWaiterSet(registry);
  const hadWaiters = waiters.size > 0;
  const immediate = readyDaemonChannels(registry)[0];
  if (immediate && !hadWaiters) return immediate;
  const graceMs = positiveInteger(options.graceMs, relayContract.newCallReconnectGraceMs);
  if (options.signal?.aborted) throw cancelledError();
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
