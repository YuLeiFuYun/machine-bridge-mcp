import type { DaemonChallenge, DaemonPreflightAuthorization } from "./daemon-auth.ts";
import type { DaemonChannel, ReadyDaemonRegistry } from "./daemon-channel.ts";
import { DaemonHttpChannel } from "./daemon-http-channel.ts";
import { DaemonHttpRegistry } from "./daemon-http-registry.ts";
import { DaemonLastObservation, type LastDaemonObservation } from "./daemon-last-observation.ts";
import type { DaemonAttachment } from "./daemon-socket-attachment.ts";
import { DaemonSocketRegistry, type DaemonSocketCleanup } from "./daemon-sockets.ts";
import type { DaemonPolicy } from "./policy.ts";
import type { DaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";

interface WebSocketContext { getWebSockets(): WebSocket[] }

export class DaemonRegistry implements ReadyDaemonRegistry {
  readonly http = new DaemonHttpRegistry();
  private readonly sockets: DaemonSocketRegistry;
  private readonly lastObservation = new DaemonLastObservation();
  private readonly draining = new WeakSet<DaemonChannel>();
  constructor(context: WebSocketContext) { this.sockets = new DaemonSocketRegistry(context); }

  readyChannels(now = Date.now()): DaemonChannel[] {
    const webSockets = this.sockets.readySockets(now);
    const selected = webSockets.length > 0 ? webSockets : this.http.readyChannels(now);
    return selected.filter((channel) => !this.draining.has(channel));
  }
  beginDrain(channel: DaemonChannel): boolean {
    if (!this.readyAttachment(channel) || this.draining.has(channel)) return false;
    this.draining.add(channel); return true;
  }
  isDraining(channel: DaemonChannel): boolean { return this.draining.has(channel); }
  readyAttachment(channel: DaemonChannel): DaemonAttachment | undefined {
    return channel.daemonTransport === "https"
      ? this.http.attachment(channel as DaemonHttpChannel)
      : this.sockets.readyAttachment(channel as WebSocket);
  }
  httpReadyChannels(now = Date.now()): DaemonHttpChannel[] { return this.http.readyChannels(now); }
  httpCandidates(now = Date.now()): DaemonHttpChannel[] { return this.http.candidates(now); }

  attachment(socket: WebSocket): DaemonAttachment | undefined { return this.sockets.attachment(socket); }
  candidateSockets(): WebSocket[] { return this.sockets.candidateSockets(); }
  probingSockets(): WebSocket[] { return this.sockets.probingSockets(); }
  readyRoleSockets(): WebSocket[] { return this.sockets.readyRoleSockets(); }
  readySockets(now = Date.now()): WebSocket[] { return this.sockets.readySockets(now); }
  nonReadySockets(): WebSocket[] { return this.sockets.nonReadySockets(); }
  beginCandidate(socket: WebSocket, challenge: DaemonChallenge, preflight: DaemonPreflightAuthorization, connectionId: string, connectedAt?: string): void {
    this.sockets.beginCandidate(socket, challenge, preflight, connectionId, connectedAt);
  }
  beginProbe(socket: WebSocket, values: {
    connectedAt: string; probeId: string; instanceId: string; connectionId: string;
    policy: DaemonPolicy; tools: string[]; relayDiagnostics?: DaemonRelayDiagnostics;
  }): void { this.sockets.beginProbe(socket, values); }
  promote(socket: WebSocket, lastSeenAt?: string): DaemonAttachment | undefined {
    const attachment = this.sockets.promote(socket, lastSeenAt); this.lastObservation.remember(socket, attachment, false); return attachment;
  }
  touch(socket: WebSocket, lastSeenAt?: string): DaemonAttachment | undefined {
    const attachment = this.sockets.touch(socket, lastSeenAt); this.lastObservation.remember(socket, attachment, false); return attachment;
  }
  beginCleanup(socket: WebSocket, operation: (attachment: DaemonAttachment) => Promise<unknown>): DaemonSocketCleanup | undefined {
    this.lastObservation.remember(socket, this.sockets.attachment(socket), true);
    return this.sockets.beginCleanup(socket, operation);
  }
  socketForConnectionId(connectionId: string): WebSocket | undefined { return this.sockets.socketForConnectionId(connectionId); }
  rememberReady(channel: DaemonChannel): void { this.lastObservation.remember(channel, this.readyAttachment(channel), false); }
  rememberDisconnected(channel: DaemonChannel): void { this.lastObservation.remember(channel, this.readyAttachment(channel), true); }
  lastDaemonObservation(): LastDaemonObservation | undefined { return this.lastObservation.snapshot(); }
}
