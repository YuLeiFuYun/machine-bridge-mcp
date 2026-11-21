import type { AuthorizedToken } from "./access.ts";
import { discardRequestBody, HttpError, json, parseJsonRequest } from "./http.ts";
import { asObject, isJsonRpcRequest, isJsonRpcResponse, rpcError, rpcResult } from "./mcp-jsonrpc.ts";
import { dispatchWorkerToolCall, type WorkerToolCallConfig } from "./mcp-tool-call-dispatch.ts";

export const GEMINI_MCP_PROTOCOL_VERSION = "2025-11-25";

export async function handleGeminiMcp(input: {
  request: Request;
  base: string;
  authorized: AuthorizedToken;
  bodyLimitBytes: number;
  config: WorkerToolCallConfig;
}): Promise<Response> {
  const { request, config, authorized, base } = input;
  if (request.headers.has("Mcp-Session-Id") || request.headers.has("Last-Event-ID")) {
    await discardRequestBody(request, input.bodyLimitBytes);
    return json(rpcError(null, -32600, "This endpoint has no session or replay support"), 400);
  }
  const version = request.headers.get("MCP-Protocol-Version");
  if (version !== null && version !== GEMINI_MCP_PROTOCOL_VERSION) {
    await discardRequestBody(request, input.bodyLimitBytes);
    return json(rpcError(null, -32600, "Unsupported MCP-Protocol-Version"), 400);
  }
  let body: unknown;
  try { body = await parseJsonRequest(request, input.bodyLimitBytes); }
  catch (error) {
    if (error instanceof HttpError && error.code === "invalid_json") {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    throw error;
  }
  if (isJsonRpcResponse(body)) return new Response(null, { status: 202 });
  if (!isJsonRpcRequest(body) || body.id === null) {
    return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);
  }
  // Notifications cannot start tool work. The fixed endpoint needs no stored handshake.
  if (body.id === undefined) return new Response(null, { status: 202 });
  const params = asObject(body.params);

  switch (body.method) {
    case "initialize": {
      const client = asObject(params.clientInfo);
      if (typeof params.protocolVersion !== "string" || typeof client.name !== "string"
          || typeof client.version !== "string" || asObject(params.capabilities) !== params.capabilities) {
        return json(rpcError(body.id, -32602, "Invalid initialization parameters"));
      }
      const { name, version: serverVersion } = config.serverInfo;
      return json(rpcResult(body.id, {
        protocolVersion: GEMINI_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name, version: serverVersion },
        instructions: "Access a connected workspace through its authorized tools. Use the returned job handle to follow durable jobs.",
      }));
    }
    case "ping":
      return json(rpcResult(body.id, {}));
    case "tools/list":
      return json(rpcResult(body.id, { tools: config.tools(authorized) }));
    case "tools/call": {
      const call = { ...body, params: { name: params.name, arguments: params.arguments } };
      const outcome = await dispatchWorkerToolCall(call, base, authorized, request.signal, undefined, undefined, config);
      if (!Object.hasOwn(outcome.message, "result")) return json(outcome.message, outcome.status);
      const { content, structuredContent, isError } = asObject(outcome.message.result);
      return json(rpcResult(body.id, { content, structuredContent, isError }), outcome.status);
    }
    default:
      return json(rpcError(body.id, -32601, "Method not found"));
  }
}
