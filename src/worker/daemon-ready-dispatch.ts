import { waitForReadyDaemon } from "./daemon-ready-waiters.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";

type ReadyWaitOptions = Parameters<typeof waitForReadyDaemon>[1];
type ReadyDispatch = Readonly<{ socket: WebSocket; recoveryDelayMs: number }>;

export async function readyDaemonForDispatch(
  registry: DaemonSocketRegistry,
  options: ReadyWaitOptions = {},
  now: () => number = () => performance.now(),
): Promise<ReadyDispatch> {
  const immediate = registry.readySockets()[0];
  if (immediate) return Object.freeze({ socket: immediate, recoveryDelayMs: 0 });
  const startedAt = now();
  const socket = await waitForReadyDaemon(registry, options);
  return Object.freeze({ socket, recoveryDelayMs: Math.max(0, now() - startedAt) });
}
