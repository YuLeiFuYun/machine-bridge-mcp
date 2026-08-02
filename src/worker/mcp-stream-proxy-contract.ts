import { json } from "./http.ts";

export const MCP_STREAM_PROXY_MODE_HEADER = "x-machine-bridge-internal-mcp-stream-mode";
export const MCP_STREAM_PROXY_ID_HEADER = "x-machine-bridge-internal-mcp-stream-id";
export const MCP_STREAM_PROXY_RETRY_HEADER = "x-machine-bridge-internal-mcp-retry-id";
export const MCP_STREAM_DESCRIPTOR_HEADER = "x-machine-bridge-mcp-stream-descriptor";
const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;
const RETRY_ID_PATTERN = /^retry_[A-Za-z0-9_-]{43}$/;

export type StreamProxyMode = "prepare" | "subscribe" | "modern-direct" | "modern-cancel" | "";
export type StreamDescriptorKind = "initial" | "resume" | "complete";
export type StreamDescriptor = { kind: StreamDescriptorKind; stream_id: string };
export type BridgeFetcher = { fetch(request: Request): Promise<Response> };
export type StreamExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export function sanitizeBridgeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(MCP_STREAM_PROXY_MODE_HEADER);
  headers.delete(MCP_STREAM_PROXY_ID_HEADER);
  headers.delete(MCP_STREAM_PROXY_RETRY_HEADER);
  return new Request(request, { headers });
}

export function mcpStreamProxyMode(request: Pick<Request, "headers">): StreamProxyMode {
  const value = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER)?.trim().toLowerCase() ?? "";
  return value === "prepare" || value === "subscribe" || value === "modern-direct" || value === "modern-cancel" ? value : "";
}

export function mcpStreamProxyRetryId(request: Pick<Request, "headers">): string {
  const value = request.headers.get(MCP_STREAM_PROXY_RETRY_HEADER)?.trim() ?? "";
  return RETRY_ID_PATTERN.test(value) ? value : "";
}

export function mcpStreamProxyId(request: Pick<Request, "headers">): string {
  const value = request.headers.get(MCP_STREAM_PROXY_ID_HEADER)?.trim() ?? "";
  return STREAM_ID_PATTERN.test(value) ? value : "";
}

export function mcpStreamDescriptorResponse(kind: StreamDescriptorKind, streamId: string): Response {
  if (!STREAM_ID_PATTERN.test(streamId)) throw new Error("invalid MCP stream descriptor id");
  return json({ kind, stream_id: streamId }, 200, { [MCP_STREAM_DESCRIPTOR_HEADER]: "1" });
}

export function withProxyHeaders(
  request: Request,
  mode: Exclude<StreamProxyMode, "">,
  streamId = "",
  signal?: AbortSignal,
  retryId = "",
): Request {
  const sanitized = sanitizeBridgeRequest(request);
  const headers = new Headers(sanitized.headers);
  headers.set(MCP_STREAM_PROXY_MODE_HEADER, mode);
  if (streamId) headers.set(MCP_STREAM_PROXY_ID_HEADER, streamId);
  if (retryId) {
    if (!RETRY_ID_PATTERN.test(retryId)) throw new Error("invalid MCP internal retry id");
    headers.set(MCP_STREAM_PROXY_RETRY_HEADER, retryId);
  }
  if (mode === "subscribe") headers.set("Upgrade", "websocket");
  const method = mode === "subscribe" ? "GET" : mode === "modern-cancel" ? "POST" : sanitized.method;
  return new Request(sanitized, { method, headers, signal: signal ?? sanitized.signal });
}

export async function readDescriptor(response: Response): Promise<StreamDescriptor> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP stream descriptor is invalid");
  const kind = (value as { kind?: unknown }).kind;
  const streamId = (value as { stream_id?: unknown }).stream_id;
  if ((kind !== "initial" && kind !== "resume" && kind !== "complete")
    || typeof streamId !== "string" || !STREAM_ID_PATTERN.test(streamId)) {
    throw new Error("MCP stream descriptor is invalid");
  }
  return { kind, stream_id: streamId };
}

export function stripInternalResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(MCP_STREAM_DESCRIPTOR_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
