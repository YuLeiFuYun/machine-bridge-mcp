import {
  MAXIMUM_STREAM_RECORDS,
  STREAM_KEY_PREFIX,
  streamKey,
  validRecord,
  type StreamRecord,
} from "./mcp-resumption-records.ts";

type ListStorage = {
  list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
};
type TransactionStorage = ListStorage & Pick<DurableObjectTransaction, "delete">;

export async function listStreamRecords(storage: ListStorage): Promise<StreamRecord[]> {
  const values = await storage.list<unknown>({ prefix: STREAM_KEY_PREFIX });
  if (values.size > MAXIMUM_STREAM_RECORDS) throw new Error("resumable MCP stream record set exceeds its limit");
  const records: StreamRecord[] = [];
  for (const [key, value] of values) {
    if (!validRecord(value) || key !== streamKey(value.stream_id)) {
      throw new Error("resumable MCP stream record set is corrupt");
    }
    records.push(value);
  }
  return records;
}

export async function pruneExpiredStreams(
  storage: TransactionStorage,
  records: StreamRecord[],
  now: number,
): Promise<{ records: StreamRecord[]; removedStreamIds: string[] }> {
  const retained: StreamRecord[] = [];
  const removedStreamIds: string[] = [];
  for (const record of records) {
    if (record.expires_at <= now) {
      await storage.delete(streamKey(record.stream_id));
      removedStreamIds.push(record.stream_id);
    } else retained.push(record);
  }
  return { records: retained, removedStreamIds };
}

export async function freeCompletedStreamSlots(
  storage: TransactionStorage,
  records: StreamRecord[],
  maximumRetained: number,
): Promise<{ available: boolean; records: StreamRecord[]; removedStreamIds: string[] }> {
  const retained = [...records];
  const removedStreamIds: string[] = [];
  const completed = retained.filter((record) => record.status === "ready")
    .sort((left, right) => left.created_at - right.created_at);
  for (const record of completed) {
    if (retained.length <= maximumRetained) break;
    await storage.delete(streamKey(record.stream_id));
    retained.splice(retained.findIndex((candidate) => candidate.stream_id === record.stream_id), 1);
    removedStreamIds.push(record.stream_id);
  }
  return { available: retained.length <= maximumRetained, records: retained, removedStreamIds };
}
