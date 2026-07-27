import {
  streamKey,
  type StreamIndexEntry,
} from "./mcp-resumption-records.ts";

type TransactionStorage = Pick<DurableObjectTransaction, "delete">;

export async function pruneExpiredStreams(
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

export async function freeCompletedStreamSlots(
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
