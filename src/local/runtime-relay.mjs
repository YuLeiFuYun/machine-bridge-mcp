import { Buffer } from "node:buffer";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { ResilientRelayConnection } from "./resilient-relay-connection.mjs";
import { createDeviceSessionIdentity, validateDeviceSessionIdentity } from "./device-identity.mjs";
import { SERVER_NAME } from "./tools.mjs";
import { normalizeAccountRole } from "./account-access.mjs";
import { isPlainRecord } from "./records.mjs";
import { MAX_RELAY_MESSAGE_BYTES, runtimeRelayConnectionOptions } from "./runtime-relay-connection-options.mjs";
export { MAX_RELAY_MESSAGE_BYTES } from "./runtime-relay-connection-options.mjs";
const RELAY_CALL_ID = /^call_[A-Za-z0-9_-]{8,240}$/; const RELAY_TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/;
export function createRuntimeRelayConnection(runtime, { workerUrl, deviceIdentity, expectedVersion, onFatal }) {
  if (!workerUrl || !deviceIdentity) return null;
  const sessionIdentity = deviceIdentity?.certificate ? validateDeviceSessionIdentity(deviceIdentity)
    : createDeviceSessionIdentity(deviceIdentity, workerUrl, SERVER_NAME, String(expectedVersion || ""));
  return new ResilientRelayConnection(runtimeRelayConnectionOptions(runtime, {
    workerUrl, sessionIdentity, expectedVersion, onFatal,
    onMessage: (data, relayContext) => handleRelayData(runtime, data, relayContext),
  }));
}

export function normalizeRelayResumeCalls(message) {
  if (!Array.isArray(message?.ids) || message.ids.length > 32) return { ok: false, ids: [] };
  const ids = [];
  const seen = new Set();
  for (const value of message.ids) {
    if (typeof value !== "string" || !RELAY_CALL_ID.test(value) || seen.has(value)) {
      return { ok: false, ids: [] };
    }
    seen.add(value);
    ids.push(value);
  }
  return { ok: true, ids };
}

export function normalizeRelayToolCall(message) {
  const id = typeof message.id === "string" && RELAY_CALL_ID.test(message.id) ? message.id : "";
  const tool = typeof message.tool === "string" && RELAY_TOOL_NAME.test(message.tool) ? message.tool : "";
  const argumentsValue = message.arguments === undefined ? {} : message.arguments;
  const authorization = normalizeRelayAuthorization(message.authorization);
  const timeoutMs = message.timeout_ms;
  if (!id || !tool || !isPlainRecord(argumentsValue) || !authorization
      || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1000 || timeoutMs > relayContract.maximumRelayToolTimeoutMs) return { ok: false, id };
  return {
    ok: true,
    id,
    tool,
    arguments: argumentsValue,
    authorization,
    timeoutMs,
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
  const accountVersion = value.account_version;
  const clientId = typeof value.client_id === "string" && /^mcp_client_[A-Za-z0-9_-]{43}$/.test(value.client_id) ? value.client_id : "";
  const familyId = typeof value.family_id === "string" && /^mcp_family_[A-Za-z0-9_-]{43}$/.test(value.family_id) ? value.family_id : "";
  let role;
  try { role = typeof value.role === "string" ? normalizeAccountRole(value.role) : null; } catch { return null; }
  if (!accountId || !clientId || !familyId || !role || !Number.isSafeInteger(accountVersion) || accountVersion < 1) return null;
  return Object.freeze({ account_id: accountId, account_version: accountVersion, client_id: clientId, family_id: familyId, role });
}
