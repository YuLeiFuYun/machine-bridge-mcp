import type { AuthorizedToken } from "./access.ts";
import { publicWorkerToolError } from "./errors.ts";
import { inspectWorkerToolCall } from "./mcp-tool-call-input.ts";
import { acceptsEventStream } from "./mcp-http-accept.ts";
import { mcpStreamProxyId, mcpStreamRequestKey, type StreamProxyMode } from "./mcp-stream-proxy-contract.ts";
import { closedSubscriptionResponse, jsonRpcResponseStream } from "./mcp-response-stream.ts";
import { json } from "./http.ts";
import {
  cacheableResult, discoverResult, emptySubscriptionAcknowledgement,
  McpProtocolError, subscriptionCompleteResult, validateSubscriptionRequest,
} from "../shared/mcp-protocol.mjs";
import {
  rpcError, rpcResult, textToolResult, type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";

type McpConfig = Readonly<{
  capabilities: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  instructions: string;
  supportedVersions: readonly string[];
  discoveryTtlMs: number;
  toolListTtlMs: number;
  tools: (authorized: AuthorizedToken) => Array<Record<string, unknown>>;
  recordError: (code: string) => void;
  cancelClientRequest: (requestKey?: string) => Promise<void>;
  callTool: (input: {
    name: string;
    args: Record<string, unknown>;
    base: string;
    authorized: AuthorizedToken;
    signal: AbortSignal;
    requestKey?: string;
  }) => Promise<unknown>;
}>;

type McpDispatchResult = Readonly<{
  message: Record<string, unknown>;
  status: number;
}>;

export class McpController {
  private readonly config: McpConfig;

  constructor(config: McpConfig) {
    this.config = config;
  }

  async handleControl(request: Request, mode: StreamProxyMode): Promise<Response | null> {
    if (mode !== "cancel") return null;
    const requestKey = mcpStreamRequestKey(mcpStreamProxyId(request));
    await this.config.cancelClientRequest(requestKey);
    return new Response(null, { status: requestKey ? 202 : 400 });
  }

  async handleRequest(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    proxyMode: StreamProxyMode;
  }): Promise<Response> {
    const { request, body } = input;
    if (body.id === undefined) return json(rpcError(undefined, -32601, "Method not found"), 404);
    if (body.id === null) return json(rpcError(null, -32600, "MCP requests require a non-null request id"), 400);
    const requestKey = input.proxyMode === "direct"
      ? mcpStreamRequestKey(mcpStreamProxyId(request))
      : undefined;
    if (input.proxyMode === "direct" && !requestKey) {
      return json(rpcError(body.id, -32600, "Invalid response stream identity"), 400);
    }
    if (body.method === "subscriptions/listen") {
      if (!acceptsEventStream(request)) {
        return json(rpcError(body.id, -32602, "subscriptions/listen requires text/event-stream support"), 406);
      }
      try {
        validateSubscriptionRequest(body);
        return closedSubscriptionResponse(
          emptySubscriptionAcknowledgement(body.id),
          rpcResult(body.id, subscriptionCompleteResult(body.id, this.config.serverInfo))!,
        );
      } catch (error) {
        if (error instanceof McpProtocolError) return json(rpcError(body.id, error.code, error.message, error.data), 400);
        throw error;
      }
    }
    if (body.method === "tools/call" && acceptsEventStream(request)) return this.streamedToolResponse({ ...input, requestKey });
    const outcome = await this.dispatch(input.body, input.base, input.authorized, request.signal, requestKey);
    return json(outcome.message, outcome.status);
  }

  private streamedToolResponse(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    proxyMode: StreamProxyMode;
    requestKey?: string;
  }): Response {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    input.request.signal.addEventListener("abort", cancel, { once: true });
    const result = this.dispatch(input.body, input.base, input.authorized, controller.signal, input.requestKey)
      .then((outcome) => outcome.message)
      .finally(() => input.request.signal.removeEventListener("abort", cancel));
    return jsonRpcResponseStream(result, {
      onCancel: cancel,
      onError: () => {
        this.config.recordError("mcp_stream_dispatch_failed");
        return rpcError(input.body.id, -32603, "Internal error");
      },
    });
  }

  private async dispatch(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    signal: AbortSignal,
    requestKey?: string,
  ): Promise<McpDispatchResult> {
    if (request.method === "server/discover") return this.discover(request);
    if (request.method === "tools/list") return this.listTools(request, authorized);
    if (request.method === "tools/call") return this.callTool(request, base, authorized, signal, requestKey);
    return { status: 404, message: rpcError(request.id, -32601, "Method not found") };
  }

  private discover(request: JsonRpcRequest): McpDispatchResult {
    return {
      status: 200,
      message: rpcResult(request.id, discoverResult({
        supportedVersions: this.config.supportedVersions,
        capabilities: this.config.capabilities,
        instructions: this.config.instructions,
        ttlMs: this.config.discoveryTtlMs,
        serverInfo: this.config.serverInfo,
      }))!,
    };
  }

  private listTools(request: JsonRpcRequest, authorized: AuthorizedToken): McpDispatchResult {
    return {
      status: 200,
      message: rpcResult(request.id, cacheableResult(
        { tools: this.config.tools(authorized) },
        { ttlMs: this.config.toolListTtlMs, cacheScope: "private", serverInfo: this.config.serverInfo },
      ))!,
    };
  }

  private async callTool(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    signal: AbortSignal,
    requestKey?: string,
  ): Promise<McpDispatchResult> {
    const inspected = inspectWorkerToolCall(request.params, this.config.tools(authorized));
    if (!inspected.ok) {
      const compatibility = staleSchemaMaximumCompatibilityResult(request, inspected.issues, this.config.serverInfo);
      if (compatibility) return { status: 200, message: compatibility };
      const message = inspected.reason === "missing_name" ? "tools/call requires a tool name"
        : inspected.reason === "unknown_tool" ? "Unknown tool"
          : "Tool arguments do not match the input schema";
      return {
        status: 200,
        message: rpcError(request.id, -32602, message, inspected.issues ? { side_effects_started: false, validation_issues: [...inspected.issues] } : undefined),
      };
    }
    const { name, args: rawArgs } = inspected;
    try {
      const result = await this.config.callTool({
        name, args: rawArgs as Record<string, unknown>, base, authorized, signal, requestKey,
      });
      return {
        status: 200,
        message: rpcResult(request.id, textToolResult(result, false, this.config.serverInfo))!,
      };
    } catch (error) {
      return {
        status: 200,
        message: rpcResult(request.id, textToolResult(
          { error: publicWorkerToolError(error) }, true, this.config.serverInfo,
        ))!,
      };
    }
  }
}

function staleSchemaMaximumCompatibilityResult(
  request: JsonRpcRequest,
  issues: readonly Readonly<{ instancePath: string; keyword: string; message: string }>[] | undefined,
  serverInfo: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!issues?.length || issues.some((issue) => issue.keyword !== "maximum")) return null;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : null;
  const toolName = typeof params?.name === "string" ? params.name : "";
  const compatible = issues.every((issue) => issue.instancePath === "/timeout_seconds")
    || toolName === "read_process" && issues.every((issue) => issue.instancePath === "/wait_ms");
  if (!compatible) return null;
  return rpcResult(request.id, textToolResult({
    error: {
      code: "invalid_request",
      message: "cached tool arguments exceed the current server limit; refresh tools/list and use short polling, start_process/read_process, or start_job/read_job instead of holding one response open",
      retryable: false,
      details: {
        side_effects_started: false,
        schema_refresh_recommended: true,
        validation_issues: [...issues],
      },
    },
  }, true, serverInfo));
}
