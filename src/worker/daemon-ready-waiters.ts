import { WorkerToolError } from "./errors.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { assertWorkerPendingCallAdmission, type PendingCapacitySnapshot } from "./pending-call-capacity.ts";

type ReadyWaiter = Readonly<{ tool: string; resolve: (socket: WebSocket) => void }>;
type WaitOptions = Readonly<{ graceMs?: number; signal?: AbortSignal; tool?: string; pending?: PendingCapacitySnapshot }>;

const DEFAULT_GRACE_MS = 10_000;
const waitersByRegistry = new WeakMap<DaemonSocketRegistry, Set<ReadyWaiter>>();

export async function waitForReadyDaemon(
  registry: DaemonSocketRegistry,
  options: WaitOptions = {},
): Promise<WebSocket> {
  const immediate = registry.readySockets()[0];
  if (immediate) return immediate;
  const graceMs = positiveInteger(options.graceMs, DEFAULT_GRACE_MS);
  if (options.signal?.aborted) throw cancelledError();
  const waiters = waitersByRegistry.get(registry) ?? new Set<ReadyWaiter>();
  const tool = String(options.tool || "unknown");
  const byTool: Record<string, number> = { ...(options.pending?.by_tool ?? {}) };
  for (const waiter of waiters) byTool[waiter.tool] = (byTool[waiter.tool] ?? 0) + 1;
  assertWorkerPendingCallAdmission({ active: (options.pending?.active ?? 0) + waiters.size, by_tool: byTool }, tool);
  waitersByRegistry.set(registry, waiters);
  return new Promise<WebSocket>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (socket?: WebSocket, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      waiters.delete(waiter);
      if (waiters.size === 0) waitersByRegistry.delete(registry);
      options.signal?.removeEventListener("abort", abort);
      if (socket) resolvePromise(socket);
      else rejectPromise(error ?? unavailableError(graceMs));
    };
    const waiter: ReadyWaiter = { tool, resolve: (socket) => finish(socket) };
    const abort = () => finish(undefined, cancelledError());
    waiters.add(waiter);
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(registry.readySockets()[0]), graceMs);
    const raced = registry.readySockets()[0];
    if (raced) finish(raced);
  });
}

export function notifyReadyDaemon(registry: DaemonSocketRegistry): number {
  const socket = registry.readySockets()[0];
  const waiters = waitersByRegistry.get(registry);
  if (!socket || !waiters?.size) return 0;
  const count = waiters.size;
  waitersByRegistry.delete(registry);
  for (const waiter of [...waiters]) waiter.resolve(socket);
  return count;
}

export function readyDaemonWaiterSnapshot(registry: DaemonSocketRegistry): PendingCapacitySnapshot {
  const waiters = waitersByRegistry.get(registry) ?? new Set<ReadyWaiter>();
  const by_tool: Record<string, number> = {};
  for (const waiter of waiters) by_tool[waiter.tool] = (by_tool[waiter.tool] ?? 0) + 1;
  return { active: waiters.size, by_tool };
}

function unavailableError(graceMs: number): WorkerToolError {
  return new WorkerToolError(
    "unavailable",
    `local daemon did not reconnect within ${Math.ceil(graceMs / 1000)} seconds; keep the CLI start command running`,
    true,
  );
}

function cancelledError(): WorkerToolError {
  return new WorkerToolError("cancelled", "tool call cancelled while waiting for local daemon recovery");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}
