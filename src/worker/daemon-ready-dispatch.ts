import { waitForReadyDaemon } from "./daemon-ready-waiters.ts";
import { readyDaemonChannels, type DaemonChannel, type ReadyDaemonRegistry } from "./daemon-channel.ts";

type ReadyWaitOptions = Parameters<typeof waitForReadyDaemon>[1];
type ReadyDispatch = Readonly<{ socket: DaemonChannel; recoveryDelayMs: number }>;

export async function readyDaemonForDispatch(
  registry: ReadyDaemonRegistry,
  options: ReadyWaitOptions = {},
  now: () => number = () => performance.now(),
): Promise<ReadyDispatch> {
  const immediate = readyDaemonChannels(registry)[0];
  if (immediate) return Object.freeze({ socket: immediate, recoveryDelayMs: 0 });
  const startedAt = now();
  const socket = await waitForReadyDaemon(registry, options);
  return Object.freeze({ socket, recoveryDelayMs: Math.max(0, now() - startedAt) });
}
