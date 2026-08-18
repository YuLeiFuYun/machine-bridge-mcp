import { isLiveDaemonAttachment, withDaemonLastSeenAt, type DaemonRole } from "./daemon-liveness.ts";
import type { DaemonPolicy } from "./policy.ts";
import { relayDiagnosticsAfterReady, type DaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import type { DaemonChallenge } from "./daemon-auth.ts";
import { sanitizeDaemonAttachment, type DaemonAttachment } from "./daemon-socket-attachment.ts";
interface WebSocketContext {
  getWebSockets(): WebSocket[];
}
export interface DaemonSocketCleanup { task: Promise<void>; first: boolean }
export class DaemonSocketRegistry {
  private readonly context: WebSocketContext;
  private readonly cleanupTasks = new WeakMap<WebSocket, Promise<void>>();
  constructor(context: WebSocketContext) { this.context = context; }

  attachment(socket: WebSocket): DaemonAttachment | undefined {
    return sanitizeDaemonAttachment(socket.deserializeAttachment());
  }

  readyAttachment(socket: WebSocket): DaemonAttachment | undefined {
    const attachment = this.attachment(socket);
    return attachment?.role === "daemon" ? attachment : undefined;
  }

  candidateSockets(): WebSocket[] { return this.openSockets("candidate"); }
  probingSockets(): WebSocket[] { return this.openSockets("probing"); }
  readyRoleSockets(): WebSocket[] { return this.openSockets("daemon").sort((left, right) => this.connectedAt(right) - this.connectedAt(left)); }
  readySockets(now = Date.now()): WebSocket[] {
    return this.readyRoleSockets().filter((socket) => isLiveDaemonAttachment(this.readyAttachment(socket), now));
  }
  readyChannels(now = Date.now()): WebSocket[] { return this.readySockets(now); }

  nonReadySockets(): WebSocket[] {
    return this.context.getWebSockets().filter((socket) => {
      const role = this.attachment(socket)?.role;
      return Boolean(role && role !== "daemon" && socket.readyState === WebSocket.OPEN);
    });
  }

  beginCandidate(
    socket: WebSocket,
    challenge: DaemonChallenge,
    preflight: { sessionPublicKeyJson: string; sessionKeyId: string; certificateExpiresAt: number },
    connectionId: string,
    connectedAt = new Date().toISOString(),
  ): void {
    socket.serializeAttachment({
      role: "candidate",
      connectedAt,
      connectionId,
      authChallenge: challenge.challenge,
      authIssuedAt: challenge.issuedAt,
      authExpiresAt: challenge.expiresAt,
      workerOrigin: challenge.workerOrigin,
      authSessionPublicKeyJson: preflight.sessionPublicKeyJson,
      authSessionKeyId: preflight.sessionKeyId,
      authCertificateExpiresAt: preflight.certificateExpiresAt,
    } satisfies DaemonAttachment);
  }

  beginProbe(socket: WebSocket, values: {
    connectedAt: string; probeId: string; instanceId: string; connectionId: string;
    policy: DaemonPolicy; tools: string[]; relayDiagnostics?: DaemonRelayDiagnostics;
  }): void {
    socket.serializeAttachment({
      role: "probing", connectedAt: values.connectedAt, lastSeenAt: values.connectedAt,
      probeId: values.probeId, instanceId: values.instanceId, connectionId: values.connectionId,
      policy: values.policy, tools: values.tools, relayDiagnostics: values.relayDiagnostics,
    } satisfies DaemonAttachment);
  }

  promote(socket: WebSocket, lastSeenAt = new Date().toISOString()): DaemonAttachment | undefined {
    const attachment = this.attachment(socket);
    if (attachment?.role !== "probing") return undefined;
    const ready = {
      ...attachment,
      role: "daemon" as const,
      lastSeenAt,
      relayDiagnostics: relayDiagnosticsAfterReady(attachment.relayDiagnostics, lastSeenAt),
    };
    delete ready.probeId;
    socket.serializeAttachment(ready satisfies DaemonAttachment);
    return ready;
  }

  touch(socket: WebSocket, lastSeenAt = new Date().toISOString()): DaemonAttachment | undefined {
    const attachment = this.attachment(socket);
    if (!attachment || (attachment.role !== "probing" && attachment.role !== "daemon")) return undefined;
    const touched = withDaemonLastSeenAt(attachment, lastSeenAt);
    socket.serializeAttachment(touched satisfies DaemonAttachment);
    return touched;
  }

  expire(socket: WebSocket): DaemonAttachment | undefined {
    const attachment = this.attachment(socket);
    if (!attachment || attachment.role === "expired") return undefined;
    socket.serializeAttachment({
      role: "expired", connectedAt: attachment.connectedAt, lastSeenAt: attachment.lastSeenAt,
      instanceId: attachment.instanceId, connectionId: attachment.connectionId,
      relayDiagnostics: attachment.relayDiagnostics,
    } satisfies DaemonAttachment);
    return attachment;
  }

  beginCleanup(
    socket: WebSocket,
    operation: (attachment: DaemonAttachment) => Promise<unknown>,
  ): DaemonSocketCleanup | undefined {
    const existing = this.cleanupTasks.get(socket);
    if (existing) return { task: existing, first: false };
    const attachment = this.attachment(socket);
    if (!attachment) return undefined;
    const first = attachment.role !== "expired";
    if (first) this.expire(socket);
    let task!: Promise<void>;
    task = Promise.resolve().then(() => operation(attachment)).catch(() => operation(attachment)).then(
      () => undefined,
      (error) => {
        if (this.cleanupTasks.get(socket) === task) this.cleanupTasks.delete(socket);
        throw error;
      },
    );
    this.cleanupTasks.set(socket, task);
    return { task, first };
  }

  socketForConnectionId(connectionId: string): WebSocket | undefined {
    if (!connectionId) return undefined;
    return this.context.getWebSockets().find((socket) =>
      this.attachment(socket)?.connectionId === connectionId && socket.readyState === WebSocket.OPEN);
  }

  private openSockets(role: DaemonRole): WebSocket[] {
    return this.context.getWebSockets().filter((socket) => this.attachment(socket)?.role === role && socket.readyState === WebSocket.OPEN);
  }

  private connectedAt(socket: WebSocket): number {
    return Date.parse(this.attachment(socket)?.connectedAt ?? "") || 0;
  }
}
