import {
  validateStreamIdentity,
  type StreamRecord,
  type StreamStatus,
} from "./mcp-resumption-records.ts";
import { listStreamRecords } from "./mcp-resumption-index.ts";

type ReadStorage = { list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>> };

export type BeginStreamInput = Readonly<{
  streamId: string;
  tokenKey: string;
  sessionId: string;
  requestId: string | number;
  clientRequestKey?: string;
  requestFingerprint?: string;
  tool?: string;
}>;

export type StreamRequestIdentity = Readonly<{
  streamId: string;
  status: StreamStatus;
  tool?: string;
  requestFingerprint?: string;
}>;

export function pendingStreamRecord(
  input: BeginStreamInput,
  now: number,
  pendingRetentionMs: number,
): StreamRecord {
  validateStreamIdentity(input.streamId, input.tokenKey, input.sessionId, input.requestId);
  const identityFields = [input.clientRequestKey, input.requestFingerprint, input.tool];
  if (identityFields.some((value) => value !== undefined)) {
    if (typeof input.clientRequestKey !== "string" || input.clientRequestKey.length === 0 || input.clientRequestKey.length > 1024
        || typeof input.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)
        || typeof input.tool !== "string" || input.tool.length === 0 || input.tool.length > 128) {
      throw new Error("invalid MCP request identity");
    }
  }
  return {
    schema_version: 1,
    stream_id: input.streamId,
    token_key: input.tokenKey,
    session_id: input.sessionId,
    request_id: input.requestId,
    ...(input.clientRequestKey ? { client_request_key: input.clientRequestKey } : {}),
    ...(input.requestFingerprint ? { request_fingerprint: input.requestFingerprint } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    status: "pending",
    created_at: now,
    expires_at: now + pendingRetentionMs,
  };
}

export async function findStreamByRequestKey(
  storage: ReadStorage,
  requestKey: string,
): Promise<StreamRequestIdentity | undefined> {
  const record = (await listStreamRecords(storage)).find((candidate) => (
    candidate.client_request_key ?? candidate.call?.client_request_key
  ) === requestKey);
  if (!record) return undefined;
  return {
    streamId: record.stream_id,
    status: record.status,
    tool: record.tool ?? record.call?.tool,
    requestFingerprint: record.request_fingerprint ?? record.call?.request_fingerprint,
  };
}
