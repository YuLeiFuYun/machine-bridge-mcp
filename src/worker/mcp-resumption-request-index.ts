import {
  STREAM_INDEX_KEY,
  readIndex,
  validateStreamIdentity,
  type StreamRecord,
  type StreamStatus,
} from "./mcp-resumption-records.ts";

type ReadStorage = Pick<DurableObjectStorage, "get">;

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
  const index = readIndex(await storage.get<unknown>(STREAM_INDEX_KEY));
  const entry = index.entries.find((candidate) => (
    candidate.client_request_key ?? candidate.call?.client_request_key
  ) === requestKey);
  if (!entry) return undefined;
  return {
    streamId: entry.stream_id,
    status: entry.status,
    tool: entry.tool ?? entry.call?.tool,
    requestFingerprint: entry.request_fingerprint ?? entry.call?.request_fingerprint,
  };
}
