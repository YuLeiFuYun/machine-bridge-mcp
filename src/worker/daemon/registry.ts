import type { DaemonChallenge, DaemonPreflightAuthorization } from "./auth.ts";
import type { DaemonChannel, ReadyDaemonRegistry, DaemonAttachment } from "./channel.ts";
import { DaemonHttpChannel, DaemonHttpRegistry } from "./http-channel.ts";
import { DaemonLastObservation, type LastDaemonObservation, readyDaemonChannels } from "./channel.ts";
import { DaemonSocketRegistry, type DaemonSocketCleanup } from "./sockets.ts";
import type { DaemonPolicy } from "../room/policy.ts";
import type { DaemonRelayDiagnostics } from "./relay-diagnostics.ts";
import { DAEMON_LIVENESS_TIMEOUT_MS, DAEMON_READY_TIMEOUT_MS } from "./liveness.ts";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };

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
    return selected.filter((channel) => !this.isDraining(channel));
  }
  beginDrain(channel: DaemonChannel): boolean {
    if (!this.readyAttachment(channel) || this.isDraining(channel)) return false;
    this.draining.add(channel);
    if (channel.daemonTransport !== "https") {
      const socket = channel as WebSocket; const attachment = this.sockets.attachment(socket); if (attachment) socket.serializeAttachment({ ...attachment, draining: true } satisfies DaemonAttachment);
    }
    return true;
  }
  isDraining(channel: DaemonChannel): boolean {
    return this.draining.has(channel) || (channel.daemonTransport !== "https" && this.sockets.attachment(channel as WebSocket)?.draining === true);
  }
  readyAttachment(channel: DaemonChannel): DaemonAttachment | undefined {
    return channel.daemonTransport === "https"
      ? (channel.readyState === 1 ? this.http.attachment(channel as DaemonHttpChannel) : undefined)
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
export function daemonStatusSnapshot(registry: DaemonRegistry, detail: boolean): Record<string, unknown> {
  const sockets = readyDaemonChannels(registry);
  const attachment = sockets[0] ? registry.readyAttachment(sockets[0]) : undefined;
  const previous = sockets.length === 0 ? registry.lastDaemonObservation?.() : undefined;
  const tools = attachment?.tools ?? [];
  const transport = sockets[0]?.daemonTransport === "https" ? "https" : "websocket";
  const base = {
    connected: sockets.length > 0,
    count: sockets.length,
    tool_count: tools.length,
    connected_at: attachment?.connectedAt ?? null,
    last_seen_at: attachment?.lastSeenAt ?? attachment?.connectedAt ?? null,
    readiness_verified: sockets.length > 0,
    readiness_timeout_ms: DAEMON_READY_TIMEOUT_MS,
    liveness_timeout_ms: transport === "https"
      ? relayContract.httpFallbackLivenessTimeoutMs
      : DAEMON_LIVENESS_TIMEOUT_MS,
    previous_connection: previous ? {
      transport: previous.transport,
      connected_at: previous.connectedAt,
      last_seen_at: previous.lastSeenAt,
      disconnected_at: previous.disconnectedAt,
      relay_transport: previous.relayDiagnostics ?? null,
    } : null,
  };
  if (!detail) return base;
  return {
    ...base,
    policy: attachment?.policy ?? null,
    tools,
    relay_transport: attachment?.relayDiagnostics ?? null,
  };
}
