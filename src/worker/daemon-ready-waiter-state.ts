import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { readyDaemonChannels, type DaemonChannel, type ReadyDaemonRegistry } from "./daemon-channel.ts";
import type { PendingCapacitySnapshot } from "./pending-call-capacity.ts";
import { readyWaiterMatchesRevocation, type ReadyWaiterPolicyRecord } from "./daemon-ready-waiter-policy.ts";

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
