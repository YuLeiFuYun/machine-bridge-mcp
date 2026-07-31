import type { StreamIndexEntry } from "./mcp-resumption-records.ts";

export type PendingStreamCallSnapshot = {
  active: number;
  detached: number;
  request_keys: number;
  maximum: number;
  oldest_ms: number;
  by_tool: Record<string, number>;
};

export function pendingCallSnapshot(
  entries: StreamIndexEntry[],
  now: number,
  maximum: number,
): PendingStreamCallSnapshot {
  const calls = entries.flatMap((entry) => entry.call ? [entry.call] : []);
  const byTool = Object.create(null) as Record<string, number>;
  let detached = 0;
  let oldestMs = 0;
  let requestKeys = 0;
  for (const call of calls) {
    byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
    detached += Number(call.state === "detached");
    requestKeys += Number(Boolean(call.client_request_key));
    oldestMs = Math.max(oldestMs, now - call.started_at);
  }
  return { active: calls.length, detached, request_keys: requestKeys, maximum, oldest_ms: oldestMs, by_tool: byTool };
}
