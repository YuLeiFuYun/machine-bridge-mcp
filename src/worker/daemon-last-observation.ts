import type { DaemonChannel } from "./daemon-channel.ts";
import type { DaemonAttachment } from "./daemon-socket-attachment.ts";
import type { DaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";

export interface LastDaemonObservation {
  transport: "websocket" | "https";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
  relayDiagnostics?: DaemonRelayDiagnostics;
}

export class DaemonLastObservation {
  private value: LastDaemonObservation | undefined;

  remember(channel: DaemonChannel, attachment: DaemonAttachment | undefined, disconnected: boolean): void {
    if (attachment?.role !== "daemon") return;
    this.value = {
      transport: channel.daemonTransport === "https" ? "https" : "websocket",
      connectedAt: attachment.connectedAt,
      lastSeenAt: attachment.lastSeenAt ?? attachment.connectedAt,
      disconnectedAt: disconnected ? new Date().toISOString() : null,
      relayDiagnostics: attachment.relayDiagnostics && { ...attachment.relayDiagnostics },
    };
  }

  snapshot(): LastDaemonObservation | undefined {
    return this.value ? { ...this.value, relayDiagnostics: this.value.relayDiagnostics && { ...this.value.relayDiagnostics } } : undefined;
  }
}
