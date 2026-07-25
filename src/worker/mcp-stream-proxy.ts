import { applyCors, baseUrl, json } from "./http.ts";
import { acceptsEventStream, resumeJsonRpcResponse, streamJsonRpcResponse } from "./mcp-stream.ts";
import type { JsonRpcMessage, McpResumptionStore } from "./mcp-resumption.ts";

export const MCP_STREAM_PROXY_MODE_HEADER = "x-machine-bridge-internal-mcp-stream-mode";
export const MCP_STREAM_PROXY_ID_HEADER = "x-machine-bridge-internal-mcp-stream-id";
const MCP_STREAM_DESCRIPTOR_HEADER = "x-machine-bridge-mcp-stream-descriptor";
const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;
const DEFAULT_POLL_INTERVAL_MS = 250;

type StreamProxyMode = "prepare" | "poll" | "";
type StreamDescriptorKind = "initial" | "resume" | "complete";
type StreamDescriptor = { kind: StreamDescriptorKind; stream_id: string };
type BridgeFetcher = { fetch(request: Request): Promise<Response> };
type StreamExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export async function proxyMcpEventStream(input: {
  request: Request;
  bridge: BridgeFetcher;
  extraOrigins: string;
  ctx: StreamExecutionContext;
  pollIntervalMs?: number;
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

  const terminal = pollTerminalMessage(
    input.bridge,
    input.request.url,
    descriptor.stream_id,
    positiveInteger(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  );
  input.ctx.waitUntil(terminal.then(() => undefined, () => undefined));
  const options = {
    streamId: descriptor.stream_id,
    keepAlive: (promise: Promise<void>) => input.ctx.waitUntil(promise),
  };
  const response = descriptor.kind === "initial"
    ? streamJsonRpcResponse(terminal, options)
    : resumeJsonRpcResponse(terminal, options);
  return applyCors(response, input.request, baseUrl(input.request), input.extraOrigins);
}

export function sanitizeBridgeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(MCP_STREAM_PROXY_MODE_HEADER);
  headers.delete(MCP_STREAM_PROXY_ID_HEADER);
  return new Request(request, { headers });
}

export async function handleMcpStreamPollRequest(
  request: Request,
  resumption: McpResumptionStore,
): Promise<Response | null> {
  if (mcpStreamProxyMode(request) !== "poll") return null;
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const streamId = mcpStreamProxyId(request);
  if (!streamId) return json({ error: "invalid_internal_stream_id" }, 400);
  const outcome = await resumption.pollMessage(streamId);
  if (outcome.kind === "pending") return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  if (outcome.kind === "not_found") return json({ error: "stream_not_found" }, 404);
  return json(outcome.message);
}

export function mcpStreamProxyMode(request: Request): StreamProxyMode {
  const value = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER)?.trim().toLowerCase() ?? "";
  return value === "prepare" || value === "poll" ? value : "";
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
  return new Request(sanitized, { headers });
}

async function pollTerminalMessage(
  bridge: BridgeFetcher,
  requestUrl: string,
  streamId: string,
  intervalMs: number,
): Promise<JsonRpcMessage> {
  for (;;) {
    const internal = withProxyHeaders(new Request(requestUrl, { method: "GET" }), "poll", streamId);
    const response = await bridge.fetch(internal);
    if (response.status === 202) {
      await delay(intervalMs);
      continue;
    }
    if (!response.ok) throw new Error(`internal MCP stream poll failed (${response.status})`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      throw new Error("internal MCP stream poll returned an invalid JSON-RPC message");
    }
    return value as JsonRpcMessage;
  }
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

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
