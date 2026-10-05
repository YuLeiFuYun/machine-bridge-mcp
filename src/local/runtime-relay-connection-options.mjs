import { createDaemonAuthentication, createDaemonPreflightHeaders } from "./device-identity.mjs";
import { relayHandshakeDiagnostics } from "./relay-peer-diagnostics.mjs";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS, SERVER_NAME } from "./tools.mjs";

export const MAX_RELAY_MESSAGE_BYTES = 8 * 1024 * 1024;

export function runtimeRelayConnectionOptions(runtime, input) {
  const { workerUrl, sessionIdentity, expectedVersion, onFatal, onMessage } = input;
  const version = String(expectedVersion || "");
  const currentSessionIdentity = typeof sessionIdentity === "function" ? sessionIdentity : () => sessionIdentity;
  const common = { workerUrl, logger: runtime.logger, expectedServer: SERVER_NAME, expectedVersion: version };
  return {
    logger: runtime.logger,
    websocket: {
      ...common,
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
      connectionHeaders: () => createDaemonPreflightHeaders(currentSessionIdentity(), workerUrl, SERVER_NAME, version),
      helloMessage: async (welcome, relayStatus) => ({
        type: "hello", instance_id: runtime.relayInstanceId, tools: runtime.tools(), policy: runtime.policy,
        protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        relay_diagnostics: handshakeDiagnostics(runtime, relayStatus, "websocket"),
        authentication: await createDaemonAuthentication(currentSessionIdentity(), welcome, runtime.relayInstanceId),
      }),
      onMessage,
      onSuperseded: async () => { await runtime.stop(); await runtime.onSuperseded?.(); },
      onFatal: async (error) => { await runtime.stop(); await onFatal?.(error); },
    },
    http: {
      ...common,
      deviceIdentity: currentSessionIdentity(),
      deviceIdentityProvider: currentSessionIdentity,
      instanceId: runtime.relayInstanceId,
      descriptor: (relayStatus) => ({
        tools: runtime.tools(), policy: runtime.policy,
        relayDiagnostics: handshakeDiagnostics(runtime, relayStatus, "https"),
      }),
      ownedCallIds: () => runtime.relayOwnedCallIds(),
      onMessage,
    },
    onDisconnect: (event) => runtime.handleRelayDisconnect(event),
    onReady: (event) => runtime.handleRelayReady(event),
  };
}

function handshakeDiagnostics(runtime, relayStatus = {}, transport) {
  const aggregate = runtime.relay?.status?.() || {};
  return relayHandshakeDiagnostics({
    ...aggregate, ...relayStatus, transport,
    recent_outages: aggregate.recent_outages ?? relayStatus.recent_outages,
    https_fallback_last_takeover_ms: aggregate.https_fallback_last_takeover_ms ?? relayStatus.https_fallback_last_takeover_ms,
    https_fallback_last_takeover_outage_number: aggregate.https_fallback_last_takeover_outage_number ?? relayStatus.https_fallback_last_takeover_outage_number,
  });
}
