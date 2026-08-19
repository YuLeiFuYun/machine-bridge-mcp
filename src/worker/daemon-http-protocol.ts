import { sanitizeConnectionId, sanitizeDaemonInstanceId } from "./daemon-socket-attachment.ts";

const SESSION_ID = /^relay_http_[A-Za-z0-9_-]{43}$/;
const ACTIVATION_TOKEN = /^activate_[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^call_[A-Za-z0-9_-]{8,240}$/;

export interface DaemonHttpExchange {
  sessionId: string;
  instanceId: string;
  activationToken: string;
  ackWorkerSeq: number;
  takeoverWebSocket: boolean;
  takeoverWebSocketConnectionId: string;
  ownedCallIds: string[];
  messages: Array<{ seq: number; payload: Record<string, unknown> }>;
  tools: unknown;
  policy: unknown;
  relayDiagnostics: unknown;
}

export function normalizeDaemonHttpExchange(value: unknown): DaemonHttpExchange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.protocol !== 1) return null;
  const sessionId = typeof body.session_id === "string" && SESSION_ID.test(body.session_id) ? body.session_id : "";
  const instanceId = sanitizeDaemonInstanceId(body.instance_id) ?? "";
  const activationToken = body.activation_token === undefined ? ""
    : typeof body.activation_token === "string" && ACTIVATION_TOKEN.test(body.activation_token) ? body.activation_token : "invalid";
  const ackWorkerSeq = Number(body.ack_worker_seq);
  const takeoverWebSocket = body.takeover_websocket === undefined ? false : body.takeover_websocket;
  const takeoverWebSocketConnectionId = body.takeover_websocket_connection_id === undefined ? ""
    : sanitizeConnectionId(body.takeover_websocket_connection_id) ?? "invalid";
  const ownedCallIds = normalizeCallIds(body.owned_call_ids);
  const messages = normalizeMessages(body.messages);
  if (!sessionId || !instanceId || activationToken === "invalid" || !Number.isSafeInteger(ackWorkerSeq) || ackWorkerSeq < 0
      || typeof takeoverWebSocket !== "boolean" || takeoverWebSocketConnectionId === "invalid"
      || (!takeoverWebSocket && Boolean(takeoverWebSocketConnectionId)) || !ownedCallIds || !messages) return null;
  return {
    sessionId, instanceId, activationToken, ackWorkerSeq, takeoverWebSocket, takeoverWebSocketConnectionId, ownedCallIds, messages,
    tools: body.tools, policy: body.policy, relayDiagnostics: body.relay_diagnostics,
  };
}

function normalizeCallIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CALL_ID.test(item) || seen.has(item)) return null;
    seen.add(item); result.push(item);
  }
  return result;
}

function normalizeMessages(value: unknown): Array<{ seq: number; payload: Record<string, unknown> }> | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.seq) || Number(record.seq) <= 0
        || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return null;
    result.push({ seq: Number(record.seq), payload: record.payload as Record<string, unknown> });
  }
  return result;
}
