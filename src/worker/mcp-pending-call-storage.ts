import { validRecord, type StreamRecord } from "./mcp-resumption-records.ts";
import type { PendingStreamCall } from "./mcp-pending-call-records.ts";

export function requiredPendingCallRecord(
  value: unknown,
  callId: string,
): StreamRecord & { call: PendingStreamCall } {
  if (!validRecord(value) || !value.call || value.call.call_id !== callId) {
    throw new Error("persisted pending call record is corrupt");
  }
  return value as StreamRecord & { call: PendingStreamCall };
}
