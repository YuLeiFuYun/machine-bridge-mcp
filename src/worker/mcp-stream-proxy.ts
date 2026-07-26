import { applyCors, baseUrl, json } from "./http.ts";
import { acceptsEventStream, resumeJsonRpcResponse, streamJsonRpcResponse } from "./mcp-stream.ts";
import type { McpStreamChannel } from "./mcp-stream-channel.ts";
import { DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS, subscribeTerminalMessage } from "./mcp-stream-subscription.ts";

export const MCP_STREAM_PROXY_MODE_HEADER = "x-machine-bridge-internal-mcp-stream-mode";
export const MCP_STREAM_PROXY_ID_HEADER = "x-machine-bridge-internal-mcp-stream-id";
const MCP_STREAM_DESCRIPTOR_HEADER = "x-machine-bridge-mcp-stream-descriptor";
const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;

type StreamProxyMode = "prepare" | "subscribe" | "";
type StreamDescriptorKind = "initial" | "resume" | "complete";
type StreamDescriptor = { kind: StreamDescriptorKind; stream_id: string };
type BridgeFetcher = { fetch(request: Request): Promise<Response> };
type StreamExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export async function proxyMcpEventStream(input: {
  request: Request;
  bridge: BridgeFetcher;
  extraOrigins: string;
  ctx: StreamExecutionContext;
  subscribeRetryDelaysMs?: readonly number[];
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  const eligible = input.request.method === "GET"
    || (input.request.method === "POST" && acceptsEventStream(input.request));
  if (url.pathname !== "/mcp" || !eligible) return null;

  const prepared = await input.bridge.fetch(withProxyHeaders(input.request, "prepare"));
  if (prepared.headers.get(MCP_STREAM_DESCRIPTOR_HEADER) !== "1") return stripInternalResponseHeaders(prepared);
  const descriptor = await readDescriptor(prepared);
  if (descriptor.kind === "complete") {
    return applyCors(
      resumeJsonRpcResponse(null, { streamId: descriptor.stream_id }),
      input.request,
      baseUrl(input.request),
      input.extraOrigins,
    );
  }

  const terminal = subscribeTerminalMessage(
    input.bridge,
    () => withProxyHeaders(new Request(input.request.url, { method: "GET" }), "subscribe", descriptor.stream_id),
    input.subscribeRetryDelaysMs ?? DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS,
  );
  const options = {
    streamId: descriptor.stream_id,
    keepAlive: (promise: Promise<void>) => input.ctx.waitUntil(promise),
  };
  const response = descriptor.kind === "initial"
    ? streamJsonRpcResponse(terminal, options)
    : resumeJsonRpcResponse(terminal, options);
  return applyCors(response, input.request, baseUrl(input.request), input.extraOrigins);
}

export async function handleMcpStreamSubscribeRequest(
  request: Request,
  channel: McpStreamChannel,
  resumption: Parameters<McpStreamChannel["subscribe"]>[2],
): Promise<Response | null> {
  if (mcpStreamProxyMode(request) !== "subscribe") return null;
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const streamId = mcpStreamProxyId(request);
  if (!streamId) return json({ error: "invalid_internal_stream_id" }, 400);
  return await channel.subscribe(request, streamId, resumption);
}

export function sanitizeBridgeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(MCP_STREAM_PROXY_MODE_HEADER);
  headers.delete(MCP_STREAM_PROXY_ID_HEADER);
  return new Request(request, { headers });
}

export function mcpStreamProxyMode(request: Request): StreamProxyMode {
  const value = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER)?.trim().toLowerCase() ?? "";
  return value === "prepare" || value === "subscribe" ? value : "";
}

export function mcpStreamProxyId(request: Request): string {
  const value = request.headers.get(MCP_STREAM_PROXY_ID_HEADER)?.trim() ?? "";
  return STREAM_ID_PATTERN.test(value) ? value : "";
}

export function mcpStreamDescriptorResponse(kind: StreamDescriptorKind, streamId: string): Response {
  if (!STREAM_ID_PATTERN.test(streamId)) throw new Error("invalid MCP stream descriptor id");
  return json({ kind, stream_id: streamId }, 200, { [MCP_STREAM_DESCRIPTOR_HEADER]: "1" });
}

function withProxyHeaders(request: Request, mode: Exclude<StreamProxyMode, "">, streamId = ""): Request {
  const sanitized = sanitizeBridgeRequest(request);
  const headers = new Headers(sanitized.headers);
  headers.set(MCP_STREAM_PROXY_MODE_HEADER, mode);
  if (streamId) headers.set(MCP_STREAM_PROXY_ID_HEADER, streamId);
  if (mode === "subscribe") headers.set("Upgrade", "websocket");
  return new Request(sanitized, { method: mode === "subscribe" ? "GET" : sanitized.method, headers });
}

async function readDescriptor(response: Response): Promise<StreamDescriptor> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP stream descriptor is invalid");
  const kind = (value as { kind?: unknown }).kind;
  const streamId = (value as { stream_id?: unknown }).stream_id;
  if ((kind !== "initial" && kind !== "resume" && kind !== "complete") || typeof streamId !== "string" || !STREAM_ID_PATTERN.test(streamId)) {
    throw new Error("MCP stream descriptor is invalid");
  }
  return { kind, stream_id: streamId };
}

function stripInternalResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(MCP_STREAM_DESCRIPTOR_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
