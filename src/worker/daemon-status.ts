import { DAEMON_LIVENESS_TIMEOUT_MS, DAEMON_READY_TIMEOUT_MS } from "./daemon-liveness.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";

export function daemonStatusSnapshot(registry: DaemonSocketRegistry, detail: boolean): Record<string, unknown> {
  const sockets = registry.readySockets();
  const attachment = sockets[0] ? registry.readyAttachment(sockets[0]) : undefined;
  const tools = attachment?.tools ?? [];
  const base = {
    connected: sockets.length > 0,
    count: sockets.length,
    tool_count: tools.length,
    connected_at: attachment?.connectedAt ?? null,
    last_seen_at: attachment?.lastSeenAt ?? attachment?.connectedAt ?? null,
    readiness_verified: sockets.length > 0,
    readiness_timeout_ms: DAEMON_READY_TIMEOUT_MS,
    liveness_timeout_ms: DAEMON_LIVENESS_TIMEOUT_MS,
  };
  if (!detail) return base;
  return {
    ...base,
    policy: attachment?.policy ?? null,
    tools,
    relay_transport: attachment?.relayDiagnostics ?? null,
  };
}
