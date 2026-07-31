import {
  STREAM_INDEX_KEY,
  indexEntry,
  readIndex,
  streamKey,
  validRecord,
  type JsonRpcMessage,
  type StreamIndex,
  type StreamIndexEntry,
  type StreamRecord,
} from "./mcp-resumption-records.ts";
import { toolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import type { PendingStreamCall, PendingStreamTransform } from "./mcp-pending-call-records.ts";
import {
  extendAttachedCallExpiry,
  extendDetachedCallExpiry,
  positiveDelay,
} from "./mcp-pending-call-expiry.ts";
import { requiredPendingCallRecord } from "./mcp-pending-call-storage.ts";
import {
  pendingCallSnapshot,
  type PendingStreamCallSnapshot,
} from "./mcp-pending-call-inspection.ts";
import { CONTROL_PLANE_TOOL_NAMES, pendingCallAdmission } from "./pending-call-capacity.ts";

type PendingCallStorage = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
type CompleteStream = (
  streamId: string,
  message: JsonRpcMessage,
  expected: { callId: string; connectionId?: string },
) => Promise<boolean>;
type StorageRowsWrittenListener = (rows: number) => void;

export type PendingStreamCallView = PendingStreamCall & {
  streamId: string;
  requestId: string | number;
};

export class McpPendingCallLimitError extends Error {
  constructor(message = "too many concurrent daemon tool calls") {
    super(message);
    this.name = "McpPendingCallLimitError";
  }
}

export class McpPendingCallConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPendingCallConflictError";
  }
}

const DEFAULT_MAXIMUM_PENDING_CALLS = 32;

export class McpPendingCallStore {
  private readonly storage: PendingCallStorage;
  private readonly now: () => number;
  private readonly activateStream: (streamId: string) => void;
  private readonly completeStream: CompleteStream;
  private readonly onRowsWritten: StorageRowsWrittenListener;
  private readonly terminalRetentionMs: number;

  constructor(
    storage: PendingCallStorage,
    now: () => number,
    activateStream: (streamId: string) => void,
    completeStream: CompleteStream,
    onRowsWritten: StorageRowsWrittenListener,
    terminalRetentionMs: number,
  ) {
    this.storage = storage;
    this.now = now;
    this.activateStream = activateStream;
    this.completeStream = completeStream;
    this.onRowsWritten = onRowsWritten;
    this.terminalRetentionMs = positiveDelay(terminalRetentionMs);
  }

  async activate(input: {
    streamId: string;
    callId: string;
    daemonInstanceId: string;
    connectionId: string;
    clientRequestKey?: string;
    tool: string;
    timeoutMs: number;
    transform?: PendingStreamTransform;
    transientSnapshot?: { active: number; by_tool: Record<string, number> };
    maximumPendingCalls?: number;
    reservedPendingCalls?: number;
  }): Promise<void> {
    const now = this.now();
    const timeoutMs = positiveDelay(input.timeoutMs);
    const maximum = Math.max(1, Math.floor(input.maximumPendingCalls ?? DEFAULT_MAXIMUM_PENDING_CALLS));
    const call: PendingStreamCall = {
      call_id: input.callId,
      daemon_instance_id: input.daemonInstanceId,
      connection_id: input.connectionId,
      ...(input.clientRequestKey ? { client_request_key: input.clientRequestKey } : {}),
      tool: input.tool,
      state: "attached",
      started_at: now,
      operation_deadline_at: now + timeoutMs,
      remaining_timeout_ms: timeoutMs,
      ...(input.transform ? { transform: structuredClone(input.transform) } : {}),
    };
    await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const durable = pendingCallSnapshot(index.entries, now, maximum);
      const transient = input.transientSnapshot ?? { active: 0, by_tool: Object.create(null) as Record<string, number> };
      const capacity = toolCallCapacityConfig(maximum, input.reservedPendingCalls, CONTROL_PLANE_TOOL_NAMES);
      const decision = pendingCallAdmission(transient, durable, input.tool, capacity);
      if (!decision.allowed) {
        throw new McpPendingCallLimitError(decision.reason === "ordinary_capacity"
          ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
          : undefined);
      }
      if (index.entries.some((entry) => entry.call?.call_id === input.callId)) {
        throw new McpPendingCallConflictError("duplicate internal daemon call id");
      }
      if (input.clientRequestKey && index.entries.some((entry) => entry.call?.client_request_key === input.clientRequestKey)) {
        throw new McpPendingCallConflictError("duplicate in-flight JSON-RPC request id within this MCP session");
      }
      const record = await transaction.get<unknown>(streamKey(input.streamId));
      if (!validRecord(record) || record.status !== "pending") {
        throw new Error("resumable MCP stream record is unavailable for activation");
      }
      if (record.call) throw new McpPendingCallConflictError("resumable MCP stream already has an active daemon call");
      const updated: StreamRecord = {
        ...record,
        expires_at: extendAttachedCallExpiry(record.expires_at, call.operation_deadline_at, this.terminalRetentionMs),
        call,
      };
      const entries = index.entries.map((entry) => entry.stream_id === input.streamId ? indexEntry(updated) : entry);
      if (!entries.some((entry) => entry.stream_id === input.streamId)) {
        throw new Error("resumable MCP stream index lost its record");
      }
      await transaction.put(streamKey(input.streamId), updated);
      await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
    });
    this.onRowsWritten(2);
    this.activateStream(input.streamId);
  }

  async get(callId: string): Promise<PendingStreamCallView | undefined> {
    const index = readIndex(await this.storage.get<unknown>(STREAM_INDEX_KEY));
    const entry = index.entries.find((candidate) => candidate.call?.call_id === callId);
    return entry ? this.callView(entry) : undefined;
  }

  async getByRequestKey(requestKey: string): Promise<PendingStreamCallView | undefined> {
    const index = readIndex(await this.storage.get<unknown>(STREAM_INDEX_KEY));
    const entry = index.entries.find((candidate) => candidate.call?.client_request_key === requestKey);
    return entry ? this.callView(entry) : undefined;
  }

  async snapshot(maximum = DEFAULT_MAXIMUM_PENDING_CALLS): Promise<PendingStreamCallSnapshot> {
    const index = readIndex(await this.storage.get<unknown>(STREAM_INDEX_KEY));
    return pendingCallSnapshot(index.entries, this.now(), maximum);
  }

  async nextDeadlineDelayMs(): Promise<number> {
    const index = readIndex(await this.storage.get<unknown>(STREAM_INDEX_KEY));
    const now = this.now();
    return Math.min(Number.POSITIVE_INFINITY, ...index.entries.flatMap((entry) => {
      if (!entry.call) return [];
      const deadline = entry.call.state === "attached"
        ? entry.call.operation_deadline_at
        : entry.call.reconnect_deadline_at;
      return Number.isSafeInteger(deadline) ? [Math.max(0, Number(deadline) - now)] : [];
    }));
  }

  async due(now = this.now()): Promise<PendingStreamCallView[]> {
    const index = readIndex(await this.storage.get<unknown>(STREAM_INDEX_KEY));
    const due: PendingStreamCallView[] = [];
    for (const entry of index.entries) {
      const call = entry.call;
      if (!call) continue;
      const deadline = call.state === "attached" ? call.operation_deadline_at : call.reconnect_deadline_at;
      if (Number.isSafeInteger(deadline) && Number(deadline) <= now) due.push(await this.callView(entry));
    }
    return due;
  }

  async detach(connectionId: string, graceMs: number): Promise<number> {
    const now = this.now();
    const reconnectDeadline = now + positiveDelay(graceMs);
    let rows = 0;
    const count = await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const entries = [...index.entries];
      let changed = 0;
      for (let position = 0; position < entries.length; position += 1) {
        const entry = entries[position];
        if (entry.call?.state !== "attached" || entry.call.connection_id !== connectionId) continue;
        const record = await requiredPendingCallRecord(transaction, entry as StreamIndexEntry & { call: PendingStreamCall });
        const remaining = Math.max(1, record.call.operation_deadline_at - now);
        const updated: StreamRecord = {
          ...record,
          expires_at: extendDetachedCallExpiry(
            record.expires_at,
            reconnectDeadline,
            remaining,
            this.terminalRetentionMs,
          ),
          call: {
            ...record.call,
            state: "detached",
            remaining_timeout_ms: remaining,
            reconnect_deadline_at: reconnectDeadline,
          },
        };
        await transaction.put(streamKey(entry.stream_id), updated);
        entries[position] = indexEntry(updated);
        changed += 1;
      }
      if (changed > 0) {
        await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
        rows = changed + 1;
      }
      return changed;
    });
    this.onRowsWritten(rows);
    return count;
  }

  async rebind(daemonInstanceId: string, connectionId: string): Promise<string[]> {
    if (!daemonInstanceId || !connectionId) return [];
    const now = this.now();
    let rows = 0;
    const rebound = await this.storage.transaction(async (transaction) => {
      const index = readIndex(await transaction.get<unknown>(STREAM_INDEX_KEY));
      const entries = [...index.entries];
      const ids: string[] = [];
      for (let position = 0; position < entries.length; position += 1) {
        const entry = entries[position];
        if (!entry.call || entry.call.daemon_instance_id !== daemonInstanceId || entry.call.connection_id === connectionId) continue;
        const record = await requiredPendingCallRecord(transaction, entry as StreamIndexEntry & { call: PendingStreamCall });
        const remaining = record.call.state === "detached"
          ? record.call.remaining_timeout_ms
          : Math.max(1, record.call.operation_deadline_at - now);
        const updatedCall: PendingStreamCall = {
          ...record.call,
          connection_id: connectionId,
          state: "attached",
          operation_deadline_at: now + remaining,
          remaining_timeout_ms: remaining,
        };
        delete updatedCall.reconnect_deadline_at;
        const updated: StreamRecord = {
          ...record,
          expires_at: extendAttachedCallExpiry(
            record.expires_at,
            updatedCall.operation_deadline_at,
            this.terminalRetentionMs,
          ),
          call: updatedCall,
        };
        await transaction.put(streamKey(entry.stream_id), updated);
        entries[position] = indexEntry(updated);
        ids.push(updatedCall.call_id);
      }
      if (ids.length > 0) {
        await transaction.put(STREAM_INDEX_KEY, { schema_version: 1, entries } satisfies StreamIndex);
        rows = ids.length + 1;
      }
      return ids;
    });
    this.onRowsWritten(rows);
    return rebound;
  }

  async complete(callId: string, connectionId: string | undefined, message: JsonRpcMessage): Promise<boolean> {
    const view = await this.get(callId);
    if (!view || (connectionId && view.connection_id !== connectionId)) return false;
    return this.completeStream(view.streamId, message, { callId, connectionId });
  }

  private async callView(entry: StreamIndexEntry): Promise<PendingStreamCallView> {
    if (!entry.call) throw new Error("stream index entry has no pending call");
    const record = await this.storage.get<unknown>(streamKey(entry.stream_id));
    if (!validRecord(record) || !record.call || record.call.call_id !== entry.call.call_id) {
      throw new Error("persisted pending call record is corrupt");
    }
    return { ...structuredClone(record.call), streamId: record.stream_id, requestId: record.request_id };
  }
}
