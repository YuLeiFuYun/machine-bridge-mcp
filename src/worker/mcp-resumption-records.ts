import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { validPendingStreamCall, type PendingStreamCall } from "./mcp-pending-call-records.ts";
export type JsonRpcMessage = Record<string, unknown> | null;
export type StreamStatus = "pending" | "ready";
export type StreamIndexEntry = {
  stream_id: string;
  status: StreamStatus;
  created_at: number;
  expires_at: number;
  call?: PendingStreamCall;
};
export type StreamIndex = { schema_version: 1; entries: StreamIndexEntry[] };
export type StreamRecord = StreamIndexEntry & {
  schema_version: 1;
  token_key: string;
  session_id: string;
  request_id: string | number;
  message_json?: string;
  message_sha256?: string;
};

export const STREAM_INDEX_KEY = "mcp-stream-index";
const STREAM_KEY_PREFIX = "mcp-stream:";
const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAXIMUM_STREAMS = relayContract.maximumResumableStreams;
const DEFAULT_MAXIMUM_MESSAGE_BYTES = relayContract.maximumResumableMessageBytes;

export function isStreamId(value: string): boolean {
  return STREAM_ID_PATTERN.test(value);
}

export function streamKey(streamId: string): string {
  return `${STREAM_KEY_PREFIX}${streamId}`;
}

export function readIndex(value: unknown): StreamIndex {
  if (value === undefined) return { schema_version: 1, entries: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resumable MCP stream index is corrupt");
  const candidate = value as Partial<StreamIndex>;
  if (candidate.schema_version !== 1 || !Array.isArray(candidate.entries)) throw new Error("resumable MCP stream index is corrupt");
  if (candidate.entries.length > DEFAULT_MAXIMUM_STREAMS || !candidate.entries.every(validIndexEntry)) {
    throw new Error("resumable MCP stream index is corrupt");
  }
  const ids = new Set(candidate.entries.map((entry) => entry.stream_id));
  if (ids.size !== candidate.entries.length) throw new Error("resumable MCP stream index contains duplicate ids");
  return { schema_version: 1, entries: candidate.entries.map((entry) => ({ ...entry })) };
}

export function validRecord(value: unknown): value is StreamRecord {
  if (!validIndexEntry(value)) return false;
  const record = value as Partial<StreamRecord>;
  if (record.schema_version !== 1
      || typeof record.token_key !== "string" || !record.token_key || record.token_key.length > 256
      || typeof record.session_id !== "string" || record.session_id.length > 256
      || (typeof record.request_id !== "string" && (typeof record.request_id !== "number" || !Number.isFinite(record.request_id)))) {
    return false;
  }
  if (record.status === "pending") return record.message_json === undefined && record.message_sha256 === undefined;
  if (record.call !== undefined) return false;
  return typeof record.message_json === "string"
    && new TextEncoder().encode(record.message_json).byteLength <= DEFAULT_MAXIMUM_MESSAGE_BYTES
    && typeof record.message_sha256 === "string"
    && SHA256_PATTERN.test(record.message_sha256);
}

export function indexEntry(record: StreamRecord): StreamIndexEntry {
  return {
    stream_id: record.stream_id,
    status: record.status,
    created_at: record.created_at,
    expires_at: record.expires_at,
    ...(record.call ? { call: structuredClone(record.call) } : {}),
  };
}

export function validateStreamIdentity(
  streamId: string,
  tokenKey: string,
  sessionId: string,
  requestId: string | number,
): void {
  if (!isStreamId(streamId)) throw new Error("invalid MCP stream id");
  if (!tokenKey || tokenKey.length > 256) throw new Error("invalid MCP token binding");
  if (sessionId.length > 256) throw new Error("invalid MCP session binding");
  if (typeof requestId !== "string" && (typeof requestId !== "number" || !Number.isFinite(requestId))) {
    throw new Error("invalid MCP request id");
  }
}

export function readyRecord(
  record: StreamRecord,
  messageJson: string,
  messageSha256: string,
  expiresAt: number,
): StreamRecord {
  const { call: _call, ...base } = record;
  return {
    ...base,
    status: "ready",
    expires_at: expiresAt,
    message_json: messageJson,
    message_sha256: messageSha256,
  };
}

export function messageSha256(value: string): Promise<string> {
  return sha256Hex(value);
}

export function resumableMessageJson(
  message: JsonRpcMessage,
  requestId: string | number,
  maximumBytes: number,
): string {
  const serialized = JSON.stringify(message);
  if (typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= maximumBytes) return serialized;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: -32002,
      message: "Tool result exceeded the resumable delivery limit; use continuation-capable tools for large output",
    },
  });
}

export async function storedMessage(record: StreamRecord): Promise<JsonRpcMessage> {
  const serialized = record.message_json ?? "";
  if (await sha256Hex(serialized) !== record.message_sha256) return storedIntegrityMessage(record.request_id);
  try {
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : storedIntegrityMessage(record.request_id);
  } catch {
    return storedIntegrityMessage(record.request_id);
  }
}

export function workerRestartMessage(requestId: string | number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: -32003,
      message: "Tool execution may have completed, but its result was not persisted before Worker restart; reconcile side effects before retrying",
    },
  };
}

function validIndexEntry(value: unknown): value is StreamIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<StreamIndexEntry>;
  return typeof entry.stream_id === "string" && isStreamId(entry.stream_id)
    && (entry.status === "pending" || entry.status === "ready")
    && Number.isSafeInteger(entry.created_at) && Number.isSafeInteger(entry.expires_at)
    && entry.expires_at! > entry.created_at!
    && (entry.call === undefined || (entry.status === "pending" && validPendingStreamCall(entry.call)));
}

function storedIntegrityMessage(requestId: string | number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code: -32005, message: "Stored resumable tool result failed integrity validation" },
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
