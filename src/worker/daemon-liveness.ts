/**
 * Worker-side authenticated daemon liveness.
 *
 * Local daemons send an application heartbeat about every 25s so this attachment
 * stays fresh, while an independent protocol-level ping/pong watchdog detects a
 * black-holed transport on a much shorter interval without waking the Durable
 * Object. The Worker still applies a wider application-liveness bound:
 * role=daemon + readyState=OPEN is not enough after Durable Object hibernation or
 * a half-closed transport, because those sockets can still look connected while
 * tool_call never returns.
 */
export const DAEMON_LIVENESS_TIMEOUT_MS = 90_000;
export const DAEMON_READY_TIMEOUT_MS = 15_000;

export type DaemonRole = "candidate" | "probing" | "expired" | "daemon";

export interface DaemonLivenessFields {
  role?: DaemonRole | string;
  connectedAt?: string;
  lastSeenAt?: string;
}

export function daemonLastSeenMs(attachment: DaemonLivenessFields | undefined | null): number {
  return Date.parse(attachment?.lastSeenAt || "");
}

export function isLiveDaemonAttachment(
  attachment: DaemonLivenessFields | undefined | null,
  now = Date.now(),
): boolean {
  if (!attachment || attachment.role !== "daemon") return false;
  const lastSeen = daemonLastSeenMs(attachment);
  if (!Number.isFinite(lastSeen)) return false;
  const age = now - lastSeen;
  return age >= 0 && age <= DAEMON_LIVENESS_TIMEOUT_MS;
}

export function daemonLivenessDeadlineMs(attachment: DaemonLivenessFields | undefined | null): number {
  const lastSeen = daemonLastSeenMs(attachment);
  if (!Number.isFinite(lastSeen)) return Number.NaN;
  return lastSeen + DAEMON_LIVENESS_TIMEOUT_MS;
}

export function daemonReadyDeadlineMs(attachment: DaemonLivenessFields | undefined | null): number {
  if (!attachment || attachment.role !== "probing") return Number.NaN;
  const connectedAt = Date.parse(attachment.connectedAt || "");
  if (!Number.isFinite(connectedAt)) return Number.NaN;
  return connectedAt + DAEMON_READY_TIMEOUT_MS;
}

export function withDaemonLastSeenAt<T extends DaemonLivenessFields>(
  attachment: T,
  lastSeenAt = new Date().toISOString(),
): T & { lastSeenAt: string } {
  return { ...attachment, lastSeenAt };
}

export const DAEMON_HELLO_TIMEOUT_MS = 10_000;

export function isFreshDaemonCandidate(connectedAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= 0 && age <= DAEMON_HELLO_TIMEOUT_MS;
}
