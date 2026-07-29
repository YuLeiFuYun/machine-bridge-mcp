import type { AuthorizedToken } from "./oauth-controller.ts";
import { publicWorkerToolError } from "./errors.ts";
import { inspectWorkerToolCall } from "./mcp-tool-call-input.ts";
import { acceptsEventStream } from "./mcp-stream.ts";
import { modernMcpStreamRequestKey } from "./mcp-session.ts";
import { mcpStreamProxyId, type StreamProxyMode } from "./mcp-stream-proxy.ts";
import { modernJsonRpcResponseStream, modernSubscriptionResponse } from "./mcp-modern-stream.ts";
import { json } from "./http.ts";
import {
  acceptedSubscriptionFilter, validateSubscriptionFilter,
} from "../shared/mcp-subscriptions.mjs";
import {
  McpProtocolError, modernCacheableResult, modernDiscoverResult,
} from "../shared/mcp-protocol.mjs";
import {
  asObject, rpcError, rpcResult, textToolResult, type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";

type ModernMcpConfig = Readonly<{
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

type ModernDispatchResult = Readonly<{
  message: Record<string, unknown>;
  status: number;
}>;

export class ModernMcpController {
  private readonly config: ModernMcpConfig;

  constructor(config: ModernMcpConfig) {
    this.config = config;
  }

  async handleControl(request: Request, mode: StreamProxyMode): Promise<Response | null> {
    if (mode !== "modern-cancel") return null;
    const requestKey = modernMcpStreamRequestKey(mcpStreamProxyId(request));
    await this.config.cancelClientRequest(requestKey);
    return new Response(null, { status: requestKey ? 202 : 400 });
  }

  async handleRequest(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    protocolVersion: string;
    proxyMode: StreamProxyMode;
  }): Promise<Response> {
    const { request, body } = input;
    if (body.id === undefined) return json(rpcError(undefined, -32601, "Method not found"), 404);
    if (body.id === null) return json(rpcError(null, -32600, "Modern MCP requests require a non-null request id"), 400);
    const requestKey = input.proxyMode === "modern-direct"
      ? modernMcpStreamRequestKey(mcpStreamProxyId(request))
      : undefined;
    if (input.proxyMode === "modern-direct" && !requestKey) {
      return json(rpcError(body.id, -32600, "Invalid modern stream identity"), 400);
    }
    if (body.method === "subscriptions/listen") return this.subscriptionResponse(input);
    if (body.method === "tools/call" && acceptsEventStream(request)) return this.streamedToolResponse({ ...input, requestKey });
    const outcome = await this.dispatch(input.body, input.base, input.authorized, input.protocolVersion, request.signal, requestKey);
    return json(outcome.message, outcome.status);
  }

  private subscriptionResponse(input: {
    request: Request;
    body: JsonRpcRequest;
  }): Response {
    const { request, body } = input;
    if (!acceptsEventStream(request)) {
      return json(rpcError(body.id, -32602, "subscriptions/listen requires text/event-stream support"), 406);
    }
    try {
      const requested = validateSubscriptionFilter(asObject(body.params).notifications);
      const accepted = acceptedSubscriptionFilter(requested, this.config.capabilities);
      return modernSubscriptionResponse({
        requestId: body.id as string | number,
        notifications: accepted,
        serverInfo: this.config.serverInfo,
      });
    } catch (error) {
      if (error instanceof McpProtocolError) return json(rpcError(body.id, error.code, error.message, error.data), 400);
      throw error;
    }
  }

  private streamedToolResponse(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    protocolVersion: string;
    requestKey?: string;
  }): Response {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    input.request.signal.addEventListener("abort", cancel, { once: true });
    const result = this.dispatch(input.body, input.base, input.authorized, input.protocolVersion, controller.signal, input.requestKey)
      .then((outcome) => outcome.message)
      .finally(() => input.request.signal.removeEventListener("abort", cancel));
    return modernJsonRpcResponseStream(result, {
      onCancel: cancel,
      onError: () => {
        this.config.recordError("modern_stream_dispatch_failed");
        return rpcError(input.body.id, -32603, "Internal error");
      },
    });
  }

  private async dispatch(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    protocolVersion: string,
    signal: AbortSignal,
    requestKey?: string,
  ): Promise<ModernDispatchResult> {
    if (request.method === "server/discover") return this.discover(request);
    if (request.method === "tools/list") return this.listTools(request, authorized);
    if (request.method === "tools/call") return this.callTool(request, base, authorized, protocolVersion, signal, requestKey);
    return { status: 404, message: rpcError(request.id, -32601, "Method not found") };
  }

  private discover(request: JsonRpcRequest): ModernDispatchResult {
    return {
      status: 200,
      message: rpcResult(request.id, modernDiscoverResult({
        supportedVersions: this.config.supportedVersions,
        capabilities: this.config.capabilities,
        instructions: this.config.instructions,
        ttlMs: this.config.discoveryTtlMs,
        serverInfo: this.config.serverInfo,
      }))!,
    };
  }

  private listTools(request: JsonRpcRequest, authorized: AuthorizedToken): ModernDispatchResult {
    return {
      status: 200,
      message: rpcResult(request.id, modernCacheableResult(
        { tools: this.config.tools(authorized) },
        { ttlMs: this.config.toolListTtlMs, cacheScope: "private", serverInfo: this.config.serverInfo },
      ))!,
    };
  }

  private async callTool(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    protocolVersion: string,
    signal: AbortSignal,
    requestKey?: string,
  ): Promise<ModernDispatchResult> {
    const inspected = inspectWorkerToolCall(request.params, this.config.tools(authorized));
    if (!inspected.ok) {
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
        message: rpcResult(request.id, textToolResult(result, false, protocolVersion, this.config.serverInfo))!,
      };
    } catch (error) {
      return {
        status: 200,
        message: rpcResult(request.id, textToolResult(
          { error: publicWorkerToolError(error) }, true, protocolVersion, this.config.serverInfo,
        ))!,
      };
    }
  }
}
