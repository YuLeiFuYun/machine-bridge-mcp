import { isLiveDaemonAttachment, withDaemonLastSeenAt, type DaemonRole } from "./daemon-liveness.ts";
import { sanitizeMetadataText } from "./http.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools, type DaemonPolicy } from "./policy.ts";
import { sanitizeDaemonChallengeAttachment, type DaemonChallenge } from "./daemon-auth.ts";
export interface DaemonAttachment {
  role: DaemonRole;
  connectedAt: string;
  lastSeenAt?: string;
  probeId?: string;
  instanceId?: string;
  policy?: DaemonPolicy;
  tools?: string[];
  authChallenge?: string;
  authIssuedAt?: number;
  authExpiresAt?: number;
  workerOrigin?: string;
  authSessionPublicKeyJson?: string;
  authSessionKeyId?: string;
  authCertificateExpiresAt?: number;
}

interface WebSocketContext {
  getWebSockets(): WebSocket[];
}

export class DaemonSocketRegistry {
  constructor(private readonly context: WebSocketContext) {}

  attachment(socket: WebSocket): DaemonAttachment | undefined {
    const raw = socket.deserializeAttachment();
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as Partial<DaemonAttachment>;
    if (!["candidate", "probing", "expired", "daemon"].includes(String(candidate.role))) return undefined;
    const policy = sanitizeDaemonPolicy(candidate.policy);
    return {
      role: candidate.role as DaemonRole,
      connectedAt: sanitizeMetadataText(candidate.connectedAt, 64) ?? "",
      lastSeenAt: sanitizeMetadataText(candidate.lastSeenAt, 64),
      probeId: sanitizeProbeId(candidate.probeId),
      instanceId: sanitizeDaemonInstanceId(candidate.instanceId),
      policy,
      tools: sanitizeDaemonTools(candidate.tools, policy),
      ...sanitizeDaemonChallengeAttachment(candidate as Record<string, unknown>),
    };
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

  nonReadySockets(): WebSocket[] {
    return this.context.getWebSockets().filter((socket) => this.attachment(socket)?.role !== "daemon" && socket.readyState === WebSocket.OPEN);
  }

  beginCandidate(
    socket: WebSocket,
    challenge: DaemonChallenge,
    preflight: { sessionPublicKeyJson: string; sessionKeyId: string; certificateExpiresAt: number },
    connectedAt = new Date().toISOString(),
  ): void {
    socket.serializeAttachment({
      role: "candidate",
      connectedAt,
      authChallenge: challenge.challenge,
      authIssuedAt: challenge.issuedAt,
      authExpiresAt: challenge.expiresAt,
      workerOrigin: challenge.workerOrigin,
      authSessionPublicKeyJson: preflight.sessionPublicKeyJson,
      authSessionKeyId: preflight.sessionKeyId,
      authCertificateExpiresAt: preflight.certificateExpiresAt,
    } satisfies DaemonAttachment);
  }

  beginProbe(socket: WebSocket, values: { connectedAt: string; probeId: string; instanceId: string; policy: DaemonPolicy; tools: string[] }): void {
    socket.serializeAttachment({
      role: "probing",
      connectedAt: values.connectedAt,
      lastSeenAt: values.connectedAt,
      probeId: values.probeId,
      instanceId: values.instanceId,
      policy: values.policy,
      tools: values.tools,
    } satisfies DaemonAttachment);
  }

  promote(socket: WebSocket, lastSeenAt = new Date().toISOString()): DaemonAttachment | undefined {
    const attachment = this.attachment(socket);
    if (attachment?.role !== "probing") return undefined;
    const ready = { ...attachment, role: "daemon" as const, lastSeenAt };
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

  expire(socket: WebSocket): void {
    const attachment = this.attachment(socket);
    if (!attachment) return;
    socket.serializeAttachment({
      role: "expired",
      connectedAt: attachment.connectedAt,
      lastSeenAt: attachment.lastSeenAt,
      instanceId: attachment.instanceId,
    } satisfies DaemonAttachment);
  }

  private openSockets(role: DaemonRole): WebSocket[] {
    return this.context.getWebSockets().filter((socket) => this.attachment(socket)?.role === role && socket.readyState === WebSocket.OPEN);
  }

  private connectedAt(socket: WebSocket): number {
    return Date.parse(this.attachment(socket)?.connectedAt ?? "") || 0;
  }
}

function sanitizeProbeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^probe_[A-Za-z0-9_-]{8,240}$/.test(value)) return undefined;
  return value;
}

function sanitizeDaemonInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^daemon_[A-Za-z0-9_-]{16,96}$/.test(value)) return undefined;
  return value;
}
