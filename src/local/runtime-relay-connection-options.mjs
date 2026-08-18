import { createDaemonAuthentication, createDaemonPreflightHeaders } from "./device-identity.mjs";
import { relayHandshakeDiagnostics } from "./relay-peer-diagnostics.mjs";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS, SERVER_NAME } from "./tools.mjs";

export const MAX_RELAY_MESSAGE_BYTES = 8 * 1024 * 1024;

export function runtimeRelayConnectionOptions(runtime, input) {
  const { workerUrl, sessionIdentity, expectedVersion, onFatal, onMessage } = input;
  const version = String(expectedVersion || "");
  const common = { workerUrl, logger: runtime.logger, expectedServer: SERVER_NAME, expectedVersion: version };
  return {
    logger: runtime.logger,
    websocket: {
      ...common,
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
      connectionHeaders: () => createDaemonPreflightHeaders(sessionIdentity, workerUrl, SERVER_NAME, version),
      helloMessage: async (welcome, relayStatus) => ({
        type: "hello", instance_id: runtime.relayInstanceId, tools: runtime.tools(), policy: runtime.policy,
        protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        relay_diagnostics: relayHandshakeDiagnostics(relayStatus),
        authentication: await createDaemonAuthentication(sessionIdentity, welcome, runtime.relayInstanceId),
      }),
      onMessage,
      onSuperseded: async () => { await runtime.stop(); await runtime.onSuperseded?.(); },
      onFatal: async (error) => { await runtime.stop(); await onFatal?.(error); },
    },
    http: {
      ...common,
      deviceIdentity: sessionIdentity,
      instanceId: runtime.relayInstanceId,
      descriptor: () => ({
        tools: runtime.tools(), policy: runtime.policy,
        relayDiagnostics: {
          ...relayHandshakeDiagnostics(runtime.relay?.status?.() || {}),
          transport: "https",
        },
      }),
      ownedCallIds: () => runtime.relayOwnedCallIds(),
      onMessage,
    },
    onDisconnect: () => runtime.handleRelayDisconnect(),
    onReady: () => runtime.handleRelayReady(),
  };
}
