const STREAM_ID_PATTERN = /^stream_([A-Za-z0-9_-]{43})$/;
const CALL_ID_PATTERN = /^call_([A-Za-z0-9_-]{43})$/;

export function callIdForStreamId(streamId: string): string {
  const match = String(streamId || "").match(STREAM_ID_PATTERN);
  if (!match) throw new Error("invalid MCP stream id for durable call identity");
  return `call_${match[1]}`;
}

export function streamIdForCallId(callId: string): string | undefined {
  const match = String(callId || "").match(CALL_ID_PATTERN);
  return match ? `stream_${match[1]}` : undefined;
}
