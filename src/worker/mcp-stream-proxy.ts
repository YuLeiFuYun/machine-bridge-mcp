import { MCP_MODERN_PROTOCOL_VERSION } from "../shared/mcp-protocol.mjs";
import { applyCors, baseUrl, json } from "./http.ts";
import { acceptsEventStream, resumeJsonRpcResponse, streamJsonRpcResponse } from "./mcp-stream.ts";
import type { McpStreamChannel } from "./mcp-stream-channel.ts";
import { proxyModernMcpStream } from "./mcp-modern-proxy.ts";
import { DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS, subscribeTerminalMessage } from "./mcp-stream-subscription.ts";
import {
  MCP_STREAM_DESCRIPTOR_HEADER, mcpStreamProxyId, mcpStreamProxyMode, readDescriptor,
  stripInternalResponseHeaders, withProxyHeaders,
  type BridgeFetcher, type StreamExecutionContext,
} from "./mcp-stream-proxy-contract.ts";
import { DEFAULT_PREPARE_RETRY_DELAYS_MS, fetchPreparedStreamResponse } from "./mcp-stream-prepare-retry.ts";
import { randomToken } from "./oauth-state.ts";

export {
  MCP_STREAM_PROXY_ID_HEADER, MCP_STREAM_PROXY_MODE_HEADER, MCP_STREAM_PROXY_RETRY_HEADER,
  mcpStreamDescriptorResponse, mcpStreamProxyId, mcpStreamProxyMode, mcpStreamProxyRetryId, sanitizeBridgeRequest,
} from "./mcp-stream-proxy-contract.ts";
export type { StreamProxyMode } from "./mcp-stream-proxy-contract.ts";


export async function proxyMcpEventStream(input: {
  request: Request;
  bridge: BridgeFetcher;
  extraOrigins: string;
  ctx: StreamExecutionContext;
  subscribeRetryDelaysMs?: readonly number[];
  prepareRetryDelaysMs?: readonly number[];
  prepareAttemptTimeoutMs?: number;
  subscribeAttemptTimeoutMs?: number;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== "/mcp") return null;
  const protocolVersion = input.request.headers.get("MCP-Protocol-Version")?.trim() ?? "";
  if (protocolVersion === MCP_MODERN_PROTOCOL_VERSION) return proxyModernMcpStream(input);

  const eligible = input.request.method === "GET"
    || (input.request.method === "POST" && acceptsEventStream(input.request));
  if (!eligible) return null;
  const requestedPrepareDelays = input.prepareRetryDelaysMs ?? DEFAULT_PREPARE_RETRY_DELAYS_MS;
  const prepareRetryDelays = legacyPrepareRetryAllowed(input.request) ? requestedPrepareDelays : requestedPrepareDelays.slice(0, 1);
  const retryId = prepareRetryDelays.length > 1 ? randomToken("retry") : "";
  const prepared = await fetchPreparedStreamResponse(
    input.bridge,
    input.request,
    prepareRetryDelays,
    input.prepareAttemptTimeoutMs,
    retryId,
  );
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

  const subscription = new AbortController();
  const terminal = subscribeTerminalMessage(
    input.bridge,
    (signal) => withProxyHeaders(
      new Request(input.request.url, { method: "GET" }),
      "subscribe",
      descriptor.stream_id,
      signal,
    ),
    input.subscribeRetryDelaysMs ?? DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS,
    subscription.signal,
    input.subscribeAttemptTimeoutMs,
  );
  const options = {
    streamId: descriptor.stream_id,
    keepAlive: (promise: Promise<void>) => input.ctx.waitUntil(promise),
    onCancel: (reason: unknown) => subscription.abort(reason),
  };
  const response = descriptor.kind === "initial"
    ? streamJsonRpcResponse(terminal, options)
    : resumeJsonRpcResponse(terminal, options);
  return applyCors(response, input.request, baseUrl(input.request), input.extraOrigins);
}

function legacyPrepareRetryAllowed(request: Request): boolean {
  if (request.method === "GET") return true;
  return request.method === "POST" && Boolean(request.headers.get("Mcp-Session-Id")?.trim());
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
