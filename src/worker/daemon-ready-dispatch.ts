import { readyDaemonWaiterSnapshot, waitForReadyDaemon } from "./daemon-ready-waiters.ts";
import { readyDaemonChannels, type DaemonChannel, type ReadyDaemonRegistry } from "./daemon-channel.ts";

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
  const immediate = immediateReadyDaemonForDispatch(registry);
  if (immediate) return immediate;
  const startedAt = now();
  const socket = await waitForReadyDaemon(registry, options);
  return Object.freeze({ socket, recoveryDelayMs: Math.max(0, now() - startedAt) });
}
