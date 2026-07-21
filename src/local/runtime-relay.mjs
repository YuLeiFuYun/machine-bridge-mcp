import { Buffer } from "node:buffer";
import { RelayConnection } from "./relay-connection.mjs";
import { createDaemonAuthentication, createDaemonPreflightHeaders } from "./device-identity.mjs";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS, SERVER_NAME } from "./tools.mjs";
import { normalizeAccountRole } from "./account-access.mjs";
import { clampInteger } from "./numbers.mjs";
import { isPlainRecord } from "./records.mjs";

export const MAX_RELAY_MESSAGE_BYTES = 8 * 1024 * 1024;

export function createRuntimeRelayConnection(runtime, { workerUrl, deviceIdentity, expectedVersion, onFatal }) {
  if (!workerUrl) return null;
  return new RelayConnection({
    workerUrl,
    logger: runtime.logger,
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    expectedServer: SERVER_NAME,
    expectedVersion: String(expectedVersion || ""),
    connectionHeaders: () => createDaemonPreflightHeaders(
      deviceIdentity,
      workerUrl,
      SERVER_NAME,
      String(expectedVersion || ""),
    ),
    helloMessage: async (welcome) => ({
      type: "hello",
      instance_id: runtime.relayInstanceId,
      tools: runtime.tools(),
      policy: runtime.policy,
      protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      authentication: await createDaemonAuthentication(deviceIdentity, welcome, runtime.relayInstanceId),
    }),
    onMessage: (data, relayContext) => handleRelayData(runtime, data, relayContext),
    onDisconnect: () => runtime.handleRelayDisconnect(),
    onReady: () => runtime.handleRelayReady(),
    onSuperseded: () => {
      runtime.terminateActiveProcesses("SIGKILL");
      runtime.processSessionManager.clear();
      runtime.onSuperseded?.();
    },
    onFatal: (error) => {
      runtime.terminateActiveProcesses("SIGKILL");
      runtime.processSessionManager.clear();
      onFatal?.(error);
    },
  });
}

export function normalizeRelayResumeCalls(message) {
  if (!Array.isArray(message?.ids) || message.ids.length > 32) return { ok: false, ids: [] };
  const ids = [];
  const seen = new Set();
  for (const value of message.ids) {
    if (typeof value !== "string" || !/^call_[A-Za-z0-9_-]{8,240}$/.test(value) || seen.has(value)) {
      return { ok: false, ids: [] };
    }
    seen.add(value);
    ids.push(value);
  }
  return { ok: true, ids };
}

export function normalizeRelayToolCall(message) {
  const id = typeof message.id === "string" && message.id.length <= 256 ? message.id : "";
  const tool = typeof message.tool === "string" && message.tool.length <= 128 ? message.tool : "";
  const argumentsValue = message.arguments === undefined ? {} : message.arguments;
  const authorization = normalizeRelayAuthorization(message.authorization);
  if (!id || !tool || !isPlainRecord(argumentsValue) || !authorization) return { ok: false, id };
  return {
    ok: true,
    id,
    tool,
    arguments: argumentsValue,
    authorization,
    timeoutMs: clampInteger(message.timeout_ms, 60_000, 1000, 610_000),
  };
}

function handleRelayData(runtime, data, relayContext = {}) {
  const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(raw) > MAX_RELAY_MESSAGE_BYTES) {
    runtime.handleRelayProtocolViolation("server_message_too_large");
    return;
  }
  return runtime.handleMessage(raw, relayContext);
}

function normalizeRelayAuthorization(value) {
  if (!isPlainRecord(value)) return null;
  const accountId = typeof value.account_id === "string" && /^acct_[A-Za-z0-9_-]{20,96}$/.test(value.account_id) ? value.account_id : "";
  const accountVersion = Number(value.account_version);
  const clientId = typeof value.client_id === "string" && /^mcp_client_[A-Za-z0-9_-]{43}$/.test(value.client_id) ? value.client_id : "";
  let role;
  try { role = normalizeAccountRole(value.role); } catch { return null; }
  if (!accountId || !clientId || !Number.isInteger(accountVersion) || accountVersion < 1) return null;
  return Object.freeze({ account_id: accountId, account_version: accountVersion, client_id: clientId, role });
}
