import { streamKey, type JsonRpcMessage, type StreamRecord } from "./mcp-resumption-records.ts";
import { listStreamRecords } from "./mcp-resumption-index.ts";
import { toolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import {
  pendingCallIdentityConflict,
  type PendingStreamCall,
  type PendingStreamTransform,
} from "./mcp-pending-call-records.ts";
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

type PendingCallStorage = Pick<DurableObjectStorage, "list" | "put" | "transaction">;
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
    requestFingerprint?: string;
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
      ...(input.requestFingerprint ? { request_fingerprint: input.requestFingerprint } : {}),
      tool: input.tool,
      state: "attached",
      started_at: now,
      operation_deadline_at: now + timeoutMs,
      remaining_timeout_ms: timeoutMs,
      ...(input.transform ? { transform: structuredClone(input.transform) } : {}),
    };
    await this.storage.transaction(async (transaction) => {
      const records = await listStreamRecords(transaction);
      const durable = pendingCallSnapshot(records, now, maximum);
      const transient = input.transientSnapshot ?? { active: 0, by_tool: Object.create(null) as Record<string, number> };
      const capacity = toolCallCapacityConfig(maximum, input.reservedPendingCalls, CONTROL_PLANE_TOOL_NAMES);
      const decision = pendingCallAdmission(transient, durable, input.tool, capacity);
      if (!decision.allowed) {
        throw new McpPendingCallLimitError(decision.reason === "ordinary_capacity"
          ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
          : undefined);
      }
      if (records.some((record) => record.call?.call_id === input.callId)) {
        throw new McpPendingCallConflictError("duplicate internal daemon call id");
      }
      if (input.clientRequestKey && records.some((record) => record.stream_id !== input.streamId
        && (record.client_request_key ?? record.call?.client_request_key) === input.clientRequestKey)) {
        throw new McpPendingCallConflictError("duplicate in-flight JSON-RPC request id within this MCP session");
      }
      const record = records.find((candidate) => candidate.stream_id === input.streamId);
      if (!record || record.status !== "pending") throw new Error("resumable MCP stream record is unavailable for activation");
      if (record.call) throw new McpPendingCallConflictError("resumable MCP stream already has an active daemon call");
      const identityConflict = pendingCallIdentityConflict(record, input);
      if (identityConflict) throw new McpPendingCallConflictError(identityConflict);
      await transaction.put(streamKey(input.streamId), {
        ...record,
        expires_at: extendAttachedCallExpiry(record.expires_at, call.operation_deadline_at, this.terminalRetentionMs),
        call,
      } satisfies StreamRecord);
    });
    this.onRowsWritten(1);
    this.activateStream(input.streamId);
  }

  async get(callId: string): Promise<PendingStreamCallView | undefined> {
    const record = (await listStreamRecords(this.storage)).find((candidate) => candidate.call?.call_id === callId);
    return record ? this.callView(record) : undefined;
  }

  async getByRequestKey(requestKey: string): Promise<PendingStreamCallView | undefined> {
    const record = (await listStreamRecords(this.storage)).find((candidate) => candidate.call
      && (candidate.client_request_key ?? candidate.call.client_request_key) === requestKey);
    return record ? this.callView(record) : undefined;
  }

  async snapshot(maximum = DEFAULT_MAXIMUM_PENDING_CALLS): Promise<PendingStreamCallSnapshot> {
    return pendingCallSnapshot(await listStreamRecords(this.storage), this.now(), maximum);
  }

  async nextDeadlineDelayMs(): Promise<number> {
    const now = this.now();
    return Math.min(Number.POSITIVE_INFINITY, ...(await listStreamRecords(this.storage)).flatMap((record) => {
      if (!record.call) return [];
      const deadline = record.call.state === "attached" ? record.call.operation_deadline_at : record.call.reconnect_deadline_at;
      return Number.isSafeInteger(deadline) ? [Math.max(0, Number(deadline) - now)] : [];
    }));
  }

  async due(now = this.now()): Promise<PendingStreamCallView[]> {
    return (await listStreamRecords(this.storage)).flatMap((record) => {
      const call = record.call;
      if (!call) return [];
      const deadline = call.state === "attached" ? call.operation_deadline_at : call.reconnect_deadline_at;
      return Number.isSafeInteger(deadline) && Number(deadline) <= now ? [this.callView(record)] : [];
    });
  }

  async detach(connectionId: string, graceMs: number): Promise<number> {
    const now = this.now();
    const reconnectDeadline = now + positiveDelay(graceMs);
    const count = await this.storage.transaction(async (transaction) => {
      let changed = 0;
      for (const value of await listStreamRecords(transaction)) {
        const call = value.call;
        if (call?.state !== "attached" || call.connection_id !== connectionId) continue;
        const record = requiredPendingCallRecord(value, call.call_id);
        const remaining = Math.max(1, record.call.operation_deadline_at - now);
        const updated: StreamRecord = {
          ...record,
          expires_at: extendDetachedCallExpiry(record.expires_at, reconnectDeadline, remaining, this.terminalRetentionMs),
          call: { ...record.call, state: "detached", remaining_timeout_ms: remaining, reconnect_deadline_at: reconnectDeadline },
        };
        await transaction.put(streamKey(record.stream_id), updated);
        changed += 1;
      }
      return changed;
    });
    this.onRowsWritten(count);
    return count;
  }

  async rebind(daemonInstanceId: string, connectionId: string): Promise<string[]> {
    if (!daemonInstanceId || !connectionId) return [];
    const now = this.now();
    const ids = await this.storage.transaction(async (transaction) => {
      const rebound: string[] = [];
      for (const value of await listStreamRecords(transaction)) {
        const call = value.call;
        if (!call || call.daemon_instance_id !== daemonInstanceId || call.connection_id === connectionId) continue;
        const record = requiredPendingCallRecord(value, call.call_id);
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
        await transaction.put(streamKey(record.stream_id), {
          ...record,
          expires_at: extendAttachedCallExpiry(record.expires_at, updatedCall.operation_deadline_at, this.terminalRetentionMs),
          call: updatedCall,
        } satisfies StreamRecord);
        rebound.push(updatedCall.call_id);
      }
      return rebound;
    });
    this.onRowsWritten(ids.length);
    return ids;
  }

  async complete(callId: string, connectionId: string | undefined, message: JsonRpcMessage): Promise<boolean> {
    const view = await this.get(callId);
    if (!view || (connectionId && view.connection_id !== connectionId)) return false;
    return this.completeStream(view.streamId, message, { callId, connectionId });
  }

  private callView(record: StreamRecord): PendingStreamCallView {
    const current = requiredPendingCallRecord(record, record.call?.call_id ?? "");
    return { ...structuredClone(current.call), streamId: current.stream_id, requestId: current.request_id };
  }
}
