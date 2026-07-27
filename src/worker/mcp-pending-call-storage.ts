import {
  streamKey,
  validRecord,
  type StreamIndexEntry,
  type StreamRecord,
} from "./mcp-resumption-records.ts";
import type { PendingStreamCall } from "./mcp-pending-call-records.ts";

export async function requiredPendingCallRecord(
  transaction: Pick<DurableObjectTransaction, "get">,
  entry: StreamIndexEntry & { call: PendingStreamCall },
): Promise<StreamRecord & { call: PendingStreamCall }> {
  const record = await transaction.get<unknown>(streamKey(entry.stream_id));
  if (!validRecord(record) || !record.call || record.call.call_id !== entry.call.call_id) {
    throw new Error("persisted pending call record is corrupt");
  }
  return record as StreamRecord & { call: PendingStreamCall };
}
