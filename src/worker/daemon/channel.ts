import { sanitizeDaemonChallengeAttachment } from "./auth.ts";
import type { DaemonRole } from "./liveness.ts";
import { sanitizeDaemonRelayDiagnostics, type DaemonRelayDiagnostics } from "./relay-diagnostics.ts";
import { sanitizeMetadataText } from "../room/http.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools, type DaemonPolicy } from "../room/policy.ts";

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
export interface DaemonAttachment {
  role: DaemonRole;
  connectedAt: string;
  lastSeenAt?: string;
  probeId?: string;
  instanceId?: string;
  connectionId?: string;
  draining?: boolean;
  policy?: DaemonPolicy;
  tools?: string[];
  relayDiagnostics?: DaemonRelayDiagnostics;
  authChallenge?: string;
  authIssuedAt?: number;
  authExpiresAt?: number;
  workerOrigin?: string;
  authSessionPublicKeyJson?: string;
  authSessionKeyId?: string;
  authCertificateExpiresAt?: number;
}

export function sanitizeDaemonAttachment(value: unknown): DaemonAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DaemonAttachment>;
  if (typeof candidate.role !== "string" || !["candidate", "probing", "expired", "daemon"].includes(candidate.role)) return undefined;
  const policy = sanitizeDaemonPolicy(candidate.policy);
  return {
    role: candidate.role as DaemonRole,
    connectedAt: sanitizeMetadataText(candidate.connectedAt, 64) ?? "",
    lastSeenAt: sanitizeMetadataText(candidate.lastSeenAt, 64),
    probeId: sanitizeProbeId(candidate.probeId),
    instanceId: sanitizeDaemonInstanceId(candidate.instanceId),
    connectionId: sanitizeConnectionId(candidate.connectionId),
    draining: candidate.draining === true ? true : undefined,
    policy,
    tools: sanitizeDaemonTools(candidate.tools, policy),
    relayDiagnostics: sanitizeDaemonRelayDiagnostics(candidate.relayDiagnostics),
    ...sanitizeDaemonChallengeAttachment(candidate as Record<string, unknown>),
  };
}

function sanitizeProbeId(value: unknown): string | undefined {
  return typeof value === "string" && /^probe_[A-Za-z0-9_-]{8,240}$/.test(value) ? value : undefined;
}

export function sanitizeDaemonInstanceId(value: unknown): string | undefined {
  return typeof value === "string" && /^daemon_[A-Za-z0-9_-]{16,96}$/.test(value) ? value : undefined;
}

export function sanitizeConnectionId(value: unknown): string | undefined {
  return typeof value === "string" && /^connection_[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
