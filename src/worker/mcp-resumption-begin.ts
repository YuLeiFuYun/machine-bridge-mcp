import { extendAttachedCallExpiry } from "./mcp-pending-call-expiry.ts";
import { pendingCallForActivation, type PendingCallActivationInput } from "./mcp-pending-call-store.ts";
import { freeCompletedStreamSlots, listStreamRecords, pruneExpiredStreams } from "./mcp-resumption-index.ts";
import {
  STREAM_INDEX_KEY,
  streamKey,
  type StreamRecord,
} from "./mcp-resumption-records.ts";
import { pendingStreamRecord, type BeginStreamInput } from "./mcp-resumption-request-index.ts";
import { ensureTransactionAlarmAtMost, type TransactionAlarmMutation } from "./mcp-transaction-alarm.ts";

export class McpStreamLimitError extends Error {
  constructor() {
    super("too many resumable MCP streams are active");
    this.name = "McpStreamLimitError";
  }
}

export type BeginStreamResult = Readonly<{
  kind: "initial" | "resume" | "conflict";
  streamId: string;
  rowsWritten: number;
  removedStreamIds: string[];
  operationDeadlineAt?: number;
  alarmMutation?: TransactionAlarmMutation;
}>;

type BeginStorage = Pick<DurableObjectStorage, "transaction">;
type BeginOptions = Readonly<{
  now: number;
  pendingRetentionMs: number;
  terminalRetentionMs: number;
  maximumStreams: number;
}>;

export async function beginResumableStream(
  storage: BeginStorage,
  input: BeginStreamInput,
  options: BeginOptions,
): Promise<BeginStreamResult> {
  const streamInput = requestStreamInput(input);
  const record = pendingStreamRecord(streamInput, options.now, options.pendingRetentionMs);
  return storage.transaction(async (transaction) => {
    const records = await listStreamRecords(transaction);
    const existing = existingRequestDecision(records, streamInput);
    if (existing) return existing;
    const prepared = await prepareStreamSlot(transaction, records, options.now, options.maximumStreams);
    const legacyIndex = await transaction.get<unknown>(STREAM_INDEX_KEY);
    await transaction.put(streamKey(input.streamId), record);
    if (legacyIndex !== undefined) await transaction.delete(STREAM_INDEX_KEY);
    return createdResult(input.streamId, prepared.removedStreamIds, legacyIndex !== undefined);
  });
}

export async function beginResumableStreamCall(
  storage: BeginStorage,
  input: BeginStreamInput & PendingCallActivationInput,
  options: BeginOptions,
): Promise<BeginStreamResult> {
  const streamInput = requestStreamInput(input);
  const record = pendingStreamRecord(streamInput, options.now, options.pendingRetentionMs);
  return storage.transaction(async (transaction) => {
    const records = await listStreamRecords(transaction);
    const existing = existingRequestDecision(records, streamInput);
    if (existing) return existing;
    const prepared = await prepareStreamSlot(transaction, records, options.now, options.maximumStreams);
    const call = pendingCallForActivation(prepared.records, input, options.now);
    const active: StreamRecord = {
      ...record,
      expires_at: extendAttachedCallExpiry(record.expires_at, call.operation_deadline_at, options.terminalRetentionMs),
      call,
    };
    const legacyIndex = await transaction.get<unknown>(STREAM_INDEX_KEY);
    await transaction.put(streamKey(input.streamId), active);
    if (legacyIndex !== undefined) await transaction.delete(STREAM_INDEX_KEY);
    const alarmMutation = await ensureTransactionAlarmAtMost(transaction, call.operation_deadline_at);
    return {
      ...createdResult(input.streamId, prepared.removedStreamIds, legacyIndex !== undefined),
      operationDeadlineAt: call.operation_deadline_at, alarmMutation,
    };
  });
}

function requestStreamInput(input: BeginStreamInput): BeginStreamInput {
  return {
    streamId: input.streamId, tokenKey: input.tokenKey, sessionId: input.sessionId, requestId: input.requestId,
    ...(input.clientRequestKey ? {
      clientRequestKey: input.clientRequestKey, requestFingerprint: input.requestFingerprint, tool: input.tool,
    } : {}),
  };
}

function existingRequestDecision(records: readonly StreamRecord[], input: BeginStreamInput): BeginStreamResult | undefined {
  if (!input.clientRequestKey) return undefined;
  const existing = records.find((record) => (
    record.client_request_key ?? record.call?.client_request_key
  ) === input.clientRequestKey);
  if (!existing) return undefined;
  const compatible = existing.tool === input.tool
    && (!existing.request_fingerprint || existing.request_fingerprint === input.requestFingerprint);
  return {
    kind: compatible ? "resume" : "conflict",
    streamId: existing.stream_id,
    rowsWritten: 0,
    removedStreamIds: [],
  };
}

async function prepareStreamSlot(
  transaction: DurableObjectTransaction,
  records: StreamRecord[],
  now: number,
  maximumStreams: number,
): Promise<{ records: StreamRecord[]; removedStreamIds: string[] }> {
  const pruned = await pruneExpiredStreams(transaction, records, now);
  const freed = await freeCompletedStreamSlots(transaction, pruned.records, maximumStreams - 1);
  if (!freed.available) throw new McpStreamLimitError();
  return { records: freed.records, removedStreamIds: [...pruned.removedStreamIds, ...freed.removedStreamIds] };
}

function createdResult(streamId: string, removedStreamIds: string[], migratedLegacyIndex: boolean): BeginStreamResult {
  return {
    kind: "initial",
    streamId,
    rowsWritten: 1 + removedStreamIds.length + Number(migratedLegacyIndex),
    removedStreamIds,
  };
}
