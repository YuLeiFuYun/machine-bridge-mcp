import { DAEMON_LIVENESS_TIMEOUT_MS, DAEMON_READY_TIMEOUT_MS } from "./daemon-liveness.ts";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { DaemonRegistry } from "./daemon-registry.ts";
import { readyDaemonChannels } from "./daemon-channel.ts";

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
