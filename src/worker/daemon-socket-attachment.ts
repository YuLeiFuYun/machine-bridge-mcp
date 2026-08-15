import { sanitizeDaemonChallengeAttachment } from "./daemon-auth.ts";
import type { DaemonRole } from "./daemon-liveness.ts";
import { sanitizeDaemonRelayDiagnostics, type DaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import { sanitizeMetadataText } from "./http.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools, type DaemonPolicy } from "./policy.ts";

export interface DaemonAttachment {
  role: DaemonRole;
  connectedAt: string;
  lastSeenAt?: string;
  probeId?: string;
  instanceId?: string;
  connectionId?: string;
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
  if (!["candidate", "probing", "expired", "daemon"].includes(String(candidate.role))) return undefined;
  const policy = sanitizeDaemonPolicy(candidate.policy);
  return {
    role: candidate.role as DaemonRole,
    connectedAt: sanitizeMetadataText(candidate.connectedAt, 64) ?? "",
    lastSeenAt: sanitizeMetadataText(candidate.lastSeenAt, 64),
    probeId: sanitizeProbeId(candidate.probeId),
    instanceId: sanitizeDaemonInstanceId(candidate.instanceId),
    connectionId: sanitizeConnectionId(candidate.connectionId),
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

function sanitizeConnectionId(value: unknown): string | undefined {
  return typeof value === "string" && /^connection_[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
