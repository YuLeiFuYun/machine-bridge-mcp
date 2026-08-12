export const MCP_STREAM_PROXY_MODE_HEADER = "x-machine-bridge-internal-mcp-stream-mode";
export const MCP_STREAM_PROXY_ID_HEADER = "x-machine-bridge-internal-mcp-stream-id";
const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;

export type StreamProxyMode = "direct" | "cancel" | "";
export type BridgeFetcher = { fetch(request: Request): Promise<Response> };
export type StreamExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export function sanitizeBridgeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(MCP_STREAM_PROXY_MODE_HEADER);
  headers.delete(MCP_STREAM_PROXY_ID_HEADER);
  return new Request(request, { headers });
}

export function mcpStreamProxyMode(request: Pick<Request, "headers">): StreamProxyMode {
  const value = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER)?.trim().toLowerCase() ?? "";
  return value === "direct" || value === "cancel" ? value : "";
}

export function mcpStreamProxyId(request: Pick<Request, "headers">): string {
  const value = request.headers.get(MCP_STREAM_PROXY_ID_HEADER)?.trim() ?? "";
  return STREAM_ID_PATTERN.test(value) ? value : "";
}

export function mcpStreamRequestKey(streamId: string): string | undefined {
  return STREAM_ID_PATTERN.test(streamId) ? `stream:${streamId}` : undefined;
}

export function withProxyHeaders(
  request: Request,
  mode: Exclude<StreamProxyMode, "">,
  streamId = "",
  signal?: AbortSignal,
): Request {
  const sanitized = sanitizeBridgeRequest(request);
  const headers = new Headers(sanitized.headers);
  headers.set(MCP_STREAM_PROXY_MODE_HEADER, mode);
  if (streamId) {
    if (!STREAM_ID_PATTERN.test(streamId)) throw new Error("invalid MCP internal stream id");
    headers.set(MCP_STREAM_PROXY_ID_HEADER, streamId);
  }
  return new Request(sanitized, {
    method: mode === "cancel" ? "POST" : sanitized.method,
    headers,
    signal: signal ?? sanitized.signal,
  });
}
