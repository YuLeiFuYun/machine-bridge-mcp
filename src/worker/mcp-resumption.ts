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
  type StreamRecord,
} from "./mcp-resumption-records.ts";
import { McpPendingCallStore } from "./mcp-pending-call-store.ts";
import { freeCompletedStreamSlots, pruneExpiredStreams } from "./mcp-resumption-index.ts";
import { resumptionLimits, type McpResumptionOptions } from "./mcp-resumption-config.ts";
export type { JsonRpcMessage } from "./mcp-resumption-records.ts";

type ResumptionStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type StreamReadyListener = (streamId: string, message: JsonRpcMessage) => void;
type StorageRowsWrittenListener = (rows: number) => void;
export type StreamResumeResult =
  | { kind: "invalid" | "not_found" | "expired" }
  | { kind: "complete"; streamId: string }
  | { kind: "message"; streamId: string };

export class McpStreamLimitError extends Error {
  constructor() {
    super("too many resumable MCP streams are active");
    this.name = "McpStreamLimitError";
  }
}

const EVENT_ID_PATTERN = /^(stream_[A-Za-z0-9_-]{43}):([01])$/;

export class McpResumptionStore {
  readonly calls: McpPendingCallStore;
  private readonly active = new Set<string>();
  private readonly transientReady = new Map<string, JsonRpcMessage>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly pendingRetentionMs: number;
  private readonly maximumStreams: number;
  private readonly maximumMessageBytes: number;
  private readonly storage: ResumptionStorage;
  private readonly onReady: StreamReadyListener;
  private readonly onRowsWritten: StorageRowsWrittenListener;

  constructor(
    storage: ResumptionStorage,
    options: McpResumptionOptions = {},
    onReady: StreamReadyListener = () => {},
    onRowsWritten: StorageRowsWrittenListener = () => {},
  ) {
    this.storage = storage;
    this.onReady = onReady;
    this.onRowsWritten = onRowsWritten;
    this.now = options.now ?? Date.now;
    const limits = resumptionLimits(options);
    this.retentionMs = limits.retentionMs;
    this.pendingRetentionMs = limits.pendingRetentionMs;
    this.maximumStreams = limits.maximumStreams;
    this.maximumMessageBytes = limits.maximumMessageBytes;
    this.calls = new McpPendingCallStore(
      storage,
      this.now,
      (streamId) => this.activate(streamId),
      (streamId, message, expected) => this.completeInternal(streamId, message, expected),
      onRowsWritten,
      this.retentionMs,
    );
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
      const pruned = await pruneExpiredStreams(transaction, index.entries, now);
      const freed = await freeCompletedStreamSlots(transaction, pruned.entries, this.maximumStreams - 1);
      if (!freed.available) throw new McpStreamLimitError();
      const entries = [...freed.entries, indexEntry(record)];
      await transaction.put(streamKey(input.streamId), record);
      await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
      return [...pruned.removedStreamIds, ...freed.removedStreamIds];
    });
    this.onRowsWritten(2 + removedStreamIds.length);
    for (const removedStreamId of removedStreamIds) this.clearMemory(removedStreamId);
  }

  activate(streamId: string): void {
    if (!isStreamId(streamId)) throw new Error("invalid MCP stream id");
    this.transientReady.delete(streamId);
    this.active.add(streamId);
  }

  async complete(streamId: string, message: JsonRpcMessage): Promise<void> {
    await this.completeInternal(streamId, message);
  }

  async pollMessage(streamId: string): Promise<
    { kind: "pending" } | { kind: "not_found" } | { kind: "message"; message: JsonRpcMessage }
  > {
    if (!isStreamId(streamId)) return { kind: "not_found" };
    const transient = this.transientReady.get(streamId);
    if (transient) return { kind: "message", message: transient };
    const record = await this.storage.get<unknown>(streamKey(streamId));
    if (record === undefined) return { kind: "not_found" };
    if (!validRecord(record)) throw new Error("resumable MCP stream record is corrupt");
    if (record.expires_at <= this.now()) {
      await this.remove(streamId);
      return { kind: "not_found" };
    }
    if (record.status === "ready") return { kind: "message", message: await storedMessage(record) };
    if (record.call || this.active.has(streamId)) return { kind: "pending" };
    const unavailable = workerRestartMessage(record.request_id);
    await this.complete(streamId, unavailable);
    return { kind: "message", message: unavailable };
  }

  async resume(input: { lastEventId: string; tokenKey: string; sessionId: string }): Promise<StreamResumeResult> {
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
    if (record.status === "ready" || this.transientReady.has(event.streamId) || record.call || this.active.has(event.streamId)) {
      return { kind: "message", streamId: event.streamId };
    }
    const unavailable = workerRestartMessage(record.request_id);
    await this.complete(event.streamId, unavailable);
    return { kind: "message", streamId: event.streamId };
  }

  private async completeInternal(
    streamId: string,
    message: JsonRpcMessage,
    expected?: { callId: string; connectionId?: string },
  ): Promise<boolean> {
    try {
      const initial = await this.storage.get<unknown>(streamKey(streamId));
      if (initial === undefined) throw new Error("resumable MCP stream record disappeared before completion");
      if (!validRecord(initial)) throw new Error("resumable MCP stream record is corrupt");
      const messageJson = resumableMessageJson(message, initial.request_id, this.maximumMessageBytes);
      const digest = await messageSha256(messageJson);
      const expiresAt = this.now() + this.retentionMs;
      const rowsWritten = await this.storage.transaction(async (transaction) => {
        const record = await transaction.get<unknown>(streamKey(streamId));
        if (record === undefined) return -1;
        if (!validRecord(record)) throw new Error("resumable MCP stream record is corrupt");
        if (record.status === "ready") return 0;
        if (expected && (
          record.call?.call_id !== expected.callId
          || (expected.connectionId && record.call.connection_id !== expected.connectionId)
        )) return -2;
        const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
        if (!index.entries.some((candidate) => candidate.stream_id === streamId)) {
          throw new Error("resumable MCP stream index lost its record");
        }
        const ready = readyRecord(record, messageJson, digest, expiresAt);
        const entries = index.entries.map((candidate) => candidate.stream_id === streamId ? indexEntry(ready) : candidate);
        await transaction.put(streamKey(streamId), ready);
        await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
        return 2;
      });
      if (rowsWritten < -1) return false;
      if (rowsWritten < 0) throw new Error("resumable MCP stream record disappeared during completion");
      this.onRowsWritten(rowsWritten);
      if (rowsWritten === 0) return false;
      this.clearMemory(streamId);
      try { this.onReady(streamId, message); } catch { /* Persistent state remains authoritative. */ }
      return true;
    } catch (error) {
      this.transientReady.set(streamId, message);
      try { this.onReady(streamId, message); } catch { /* In-memory terminal state remains available. */ }
      throw error;
    }
  }

  private async remove(streamId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const entries = index.entries.filter((entry) => entry.stream_id !== streamId);
      await transaction.delete(streamKey(streamId));
      if (entries.length === 0) await transaction.delete(STREAM_INDEX_KEY);
      else await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
    });
    this.onRowsWritten(2);
    this.clearMemory(streamId);
  }

  private clearMemory(streamId: string): void {
    this.active.delete(streamId);
    this.transientReady.delete(streamId);
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
