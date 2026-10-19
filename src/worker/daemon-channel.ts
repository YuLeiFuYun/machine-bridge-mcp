export const DAEMON_CHANNEL_OPEN = 1;

export interface DaemonChannel {
  readonly readyState: number;
  send(data: string): void;
  readonly daemonTransport?: "https";
}

export interface ReadyDaemonRegistry {
  readyChannels?(): DaemonChannel[];
  readySockets?(): DaemonChannel[];
}

export function readyDaemonChannels(registry: ReadyDaemonRegistry): DaemonChannel[] {
  if (typeof registry.readyChannels === "function") return registry.readyChannels();
  if (typeof registry.readySockets === "function") return registry.readySockets();
  return [];
}

export function trySendDaemonChannel(channel: DaemonChannel | undefined, value: unknown): boolean {
  if (!channel || channel.readyState !== DAEMON_CHANNEL_OPEN) return false;
  try {
    channel.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
