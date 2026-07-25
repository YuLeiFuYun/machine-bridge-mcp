import {
  STREAM_INDEX_KEY,
  indexEntry,
  isStreamId,
  messageSha256,
  readIndex,
  readyRecord,
  resumableMessageJson,
  storedMessage,
  streamKey,
  validRecord,
  validateStreamIdentity,
  workerRestartMessage,
  type JsonRpcMessage,
  type StreamIndex,
  type StreamIndexEntry,
  type StreamRecord,
} from "./mcp-resumption-records.ts";
import { resumptionLimits, type McpResumptionOptions } from "./mcp-resumption-config.ts";

export type { JsonRpcMessage } from "./mcp-resumption-records.ts";

type ResumptionStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type TransactionStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;

export type StreamResumeResult =
  | { kind: "invalid" | "not_found" | "expired" }
  | { kind: "complete"; streamId: string }
  | { kind: "message"; streamId: string; message: Promise<JsonRpcMessage> };

export class McpStreamLimitError extends Error {
  constructor() {
    super("too many resumable MCP streams are active");
    this.name = "McpStreamLimitError";
  }
}

const EVENT_ID_PATTERN = /^(stream_[A-Za-z0-9_-]{43}):([01])$/;

export class McpResumptionStore {
  private readonly storage: ResumptionStorage;
  private readonly live = new Map<string, Promise<JsonRpcMessage>>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly pendingRetentionMs: number;
  private readonly maximumStreams: number;
  private readonly maximumMessageBytes: number;

  constructor(
    storage: ResumptionStorage,
    options: McpResumptionOptions = {},
  ) {
    this.storage = storage;
    this.now = options.now ?? Date.now;
    const limits = resumptionLimits(options);
    this.retentionMs = limits.retentionMs;
    this.pendingRetentionMs = limits.pendingRetentionMs;
    this.maximumStreams = limits.maximumStreams;
    this.maximumMessageBytes = limits.maximumMessageBytes;
  }

  async begin(input: {
    streamId: string;
    tokenKey: string;
    sessionId: string;
    requestId: string | number;
  }): Promise<void> {
    validateStreamIdentity(input.streamId, input.tokenKey, input.sessionId, input.requestId);
    const now = this.now();
    const record: StreamRecord = {
      schema_version: 1,
      stream_id: input.streamId,
      token_key: input.tokenKey,
      session_id: input.sessionId,
      request_id: input.requestId,
      status: "pending",
      created_at: now,
      expires_at: now + this.pendingRetentionMs,
    };
    const removedStreamIds = await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const pruned = await pruneExpired(transaction, index.entries, now);
      const freed = await freeCompletedSlots(transaction, pruned.entries, this.maximumStreams - 1);
      if (!freed.available) throw new McpStreamLimitError();
      const entries = [...freed.entries, indexEntry(record)];
      await transaction.put(streamKey(input.streamId), record);
      await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
      return [...pruned.removedStreamIds, ...freed.removedStreamIds];
    });
    for (const removedStreamId of removedStreamIds) this.live.delete(removedStreamId);
  }

  attach(streamId: string, message: Promise<JsonRpcMessage>): void {
    if (!isStreamId(streamId)) throw new Error("invalid MCP stream id");
    this.live.set(streamId, message);
  }

  async complete(streamId: string, message: JsonRpcMessage): Promise<void> {
    const initial = await this.storage.get<unknown>(streamKey(streamId));
    if (initial === undefined) {
      this.live.delete(streamId);
      throw new Error("resumable MCP stream record disappeared before completion");
    }
    if (!validRecord(initial)) {
      this.live.delete(streamId);
      throw new Error("resumable MCP stream record is corrupt");
    }
    const messageJson = resumableMessageJson(message, initial.request_id, this.maximumMessageBytes);
    const digest = await messageSha256(messageJson);
    const expiresAt = this.now() + this.retentionMs;
    const completed = await this.storage.transaction(async (transaction) => {
      const record = await transaction.get<unknown>(streamKey(streamId));
      if (record === undefined) return false;
      if (!validRecord(record)) throw new Error("resumable MCP stream record is corrupt");
      if (record.status === "ready") return true;
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      if (!index.entries.some((candidate) => candidate.stream_id === streamId)) {
        throw new Error("resumable MCP stream index lost its record");
      }
      const ready = readyRecord(record, messageJson, digest, expiresAt);
      const entries = index.entries.map((candidate) => candidate.stream_id === streamId
        ? indexEntry(ready)
        : candidate);
      await transaction.put(streamKey(streamId), ready);
      await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
      return true;
    });
    if (!completed) {
      this.live.delete(streamId);
      throw new Error("resumable MCP stream record disappeared during completion");
    }
    this.live.delete(streamId);
  }

  async resume(input: {
    lastEventId: string;
    tokenKey: string;
    sessionId: string;
  }): Promise<StreamResumeResult> {
    const event = parseStreamEventId(input.lastEventId);
    if (!event) return { kind: "invalid" };
    const record = await this.storage.get<unknown>(streamKey(event.streamId));
    if (record === undefined) return { kind: "not_found" };
    if (!validRecord(record)) throw new Error("resumable MCP stream record is corrupt");
    if (record.token_key !== input.tokenKey || record.session_id !== input.sessionId) return { kind: "not_found" };
    if (record.expires_at <= this.now()) {
      await this.remove(event.streamId);
      return { kind: "expired" };
    }
    if (event.sequence >= 1) return { kind: "complete", streamId: event.streamId };
    if (record.status === "ready") {
      return { kind: "message", streamId: event.streamId, message: storedMessage(record) };
    }
    const live = this.live.get(event.streamId);
    if (live) return { kind: "message", streamId: event.streamId, message: live };

    const unavailable = workerRestartMessage(record.request_id);
    await this.complete(event.streamId, unavailable);
    return { kind: "message", streamId: event.streamId, message: Promise.resolve(unavailable) };
  }

  private async remove(streamId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const entries = index.entries.filter((entry) => entry.stream_id !== streamId);
      await transaction.delete(streamKey(streamId));
      if (entries.length === 0) await transaction.delete(STREAM_INDEX_KEY);
      else await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
    });
    this.live.delete(streamId);
  }
}

export function streamEventId(streamId: string, sequence: 0 | 1): string {
  if (!isStreamId(streamId)) throw new Error("invalid MCP stream id");
  return `${streamId}:${sequence}`;
}

export function parseStreamEventId(value: string): { streamId: string; sequence: 0 | 1 } | null {
  const match = String(value || "").trim().match(EVENT_ID_PATTERN);
  if (!match) return null;
  return { streamId: match[1], sequence: Number(match[2]) as 0 | 1 };
}

async function pruneExpired(
  storage: TransactionStorage,
  entries: StreamIndexEntry[],
  now: number,
): Promise<{ entries: StreamIndexEntry[]; removedStreamIds: string[] }> {
  const retained: StreamIndexEntry[] = [];
  const removedStreamIds: string[] = [];
  for (const entry of entries) {
    if (entry.expires_at <= now) {
      await storage.delete(streamKey(entry.stream_id));
      removedStreamIds.push(entry.stream_id);
    } else retained.push(entry);
  }
  return { entries: retained, removedStreamIds };
}

async function freeCompletedSlots(
  storage: TransactionStorage,
  entries: StreamIndexEntry[],
  maximumRetained: number,
): Promise<{ available: boolean; entries: StreamIndexEntry[]; removedStreamIds: string[] }> {
  const retained = [...entries];
  const removedStreamIds: string[] = [];
  const completed = retained
    .filter((entry) => entry.status === "ready")
    .sort((left, right) => left.created_at - right.created_at);
  for (const entry of completed) {
    if (retained.length <= maximumRetained) break;
    await storage.delete(streamKey(entry.stream_id));
    retained.splice(retained.findIndex((candidate) => candidate.stream_id === entry.stream_id), 1);
    removedStreamIds.push(entry.stream_id);
  }
  return { available: retained.length <= maximumRetained, entries: retained, removedStreamIds };
}
