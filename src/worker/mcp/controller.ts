import type { AuthorizedToken } from "../oauth/authority.ts";
import type { AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import { acceptsEventStream } from "./http-contract.ts";
import { mcpStreamProxyId, mcpStreamRequestKey, type StreamProxyMode } from "./response-proxy.ts";
import { McpRequestCancellationRegistry } from "./request-cancellation.ts";
import { closedSubscriptionResponse, McpSubscriptionRegistry } from "./subscriptions.ts";
import { GEMINI_MCP_PATH, NATIVE_MCP_PATH, type McpResourcePath, json } from "../room/http.ts";
import { cacheableResult, discoverResult, emptySubscriptionAcknowledgement, McpProtocolError, subscriptionAcknowledgement, subscriptionCompleteResult, toolsListChangedNotification, validateSubscriptionRequest } from "../../shared/mcp-protocol.mjs";
import { asObject, rpcError, rpcResult, type JsonRpcRequest } from "./jsonrpc.ts";
import { dispatchManagedJobMonitorResource } from "./job-monitor.ts";
import { dispatchWorkerTaskOperation, type TaskCredentialResolver } from "./tasks.ts";
import type { McpTaskStore } from "./task-store.ts";
import { dispatchWorkerPromptOperation } from "./prompts.ts";
import { createStreamedToolResponse } from "./response-stream.ts";
import { dispatchWorkerToolCall } from "./tool-call-dispatch.ts";

export const MCP_2025_PROTOCOL_VERSION = "2025-11-25";

export type McpProtocolMode = "2026-07-28" | "2025-11-25";

type McpConfig = Readonly<{
  capabilities: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  instructions: string;
  stateless2025Instructions?: string;
  supportedVersions: readonly string[];
  discoveryTtlMs: number;
  toolListTtlMs: number;
  taskStore?: McpTaskStore;
  resolveTaskCredentials?: TaskCredentialResolver;
  tools: (authorized: AuthorizedToken, includeJobMonitor?: boolean) => Array<Record<string, unknown>>;
  recordError: (code: string) => void;
  cancelClientRequest: (requestKey?: string) => Promise<void>;
  callTool: (input: {
    name: string;
    args: Record<string, unknown>;
    base: string;
    authorized: AuthorizedToken;
    signal: AbortSignal;
    requestKey?: string;
    clientCapabilities?: Record<string, unknown>;
    progressToken?: unknown;
    mcpPath?: McpResourcePath;
    includeJobMonitor?: boolean;
  }) => Promise<unknown>;
}>;

type McpDispatchResult = Readonly<{
  message: Record<string, unknown>;
  status: number;
}>;

export class McpController {
  private readonly config: McpConfig;
  private readonly subscriptions = new McpSubscriptionRegistry();
  private readonly requestCancellations: McpRequestCancellationRegistry;
  private readonly activeRequests = new Map<string, { controller: AbortController; requestKey?: string }>();
  constructor(config: McpConfig) {
    this.config = config;
    this.requestCancellations = new McpRequestCancellationRegistry({ onFailClosed: () => config.recordError("mcp_request_cancellation_fail_closed") });
  }

  toolListSubscriptionSnapshot(accountId: string) {
    return this.subscriptions.snapshot(accountId);
  }

  cancelAuthority(revocation: AuthorityRevocation): number {
    return this.subscriptions.cancelAuthority(revocation);
  }

  async handleControl(request: Request, mode: StreamProxyMode): Promise<Response | null> {
    if (mode !== "cancel") return null;
    const requestKey = mcpStreamRequestKey(mcpStreamProxyId(request));
    this.requestCancellations.cancel(requestKey);
    this.subscriptions.cancelRequest(requestKey);
    await this.config.cancelClientRequest(requestKey);
    return new Response(null, { status: requestKey ? 202 : 400 });
  }

  async handleRequest(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    proxyMode: StreamProxyMode;
    progressToken?: unknown;
    protocolMode?: McpProtocolMode;
    mcpPath?: McpResourcePath;
  }): Promise<Response> {
    const { request, body } = input;
    const mcpPath = input.mcpPath ?? NATIVE_MCP_PATH;
    if (body.id === undefined) {
      if (typeof body.method !== "string" || !body.method.startsWith("notifications/")) {
        return json(rpcError(null, -32600, "MCP requests require a non-null request id"), 400);
      }
      if (body.method === "notifications/cancelled") {
        await this.handleCancelledNotification(request, input.authorized, body.params);
      }
      return new Response(null, { status: 202 });
    }
    if (body.id === null) return json(rpcError(null, -32600, "MCP requests require a non-null request id"), 400);
    const protocolMode = input.protocolMode ?? inferProtocolMode(request, body, mcpPath);
    if (protocolMode === "2025-11-25") {
      return this.handleStateless2025Request({ request, body, base: input.base, authorized: input.authorized, mcpPath });
    }

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
        const filter = validateSubscriptionRequest(body);
        const toolsListChanged = filter.toolsListChanged === true
          && (this.config.capabilities.tools as { listChanged?: unknown } | undefined)?.listChanged === true;
        if (toolsListChanged) {
          const response = this.subscriptions.open({
            authority: { accountId: input.authorized.accountId, accountVersion: input.authorized.accountVersion,
              clientId: input.authorized.clientId, familyId: input.authorized.familyId },
            requestKey, requestSignal: request.signal,
            acknowledged: subscriptionAcknowledgement(body.id, { toolsListChanged: true }),
            initialMessages: [toolsListChangedNotification(body.id)],
          });
          return response ?? json(rpcError(body.id, -32000, "Subscription capacity exceeded"), 429);
        }
        return closedSubscriptionResponse(emptySubscriptionAcknowledgement(body.id),
          rpcResult(body.id, subscriptionCompleteResult(body.id, this.config.serverInfo))!);
      } catch (error) {
        if (error instanceof McpProtocolError) return json(rpcError(body.id, error.code, error.message, error.data), 400);
        throw error;
      }
    }
    if (body.method === "tools/call" && acceptsEventStream(request)) {
      return this.streamedToolResponse({ ...input, requestKey, mcpPath });
    }
    return this.trackActiveRequest(input.authorized, body.id, request.signal, requestKey, async (signal) => {
      const outcome = await this.dispatch(input.body, input.base, input.authorized, signal, requestKey, input.progressToken, mcpPath);
      return json(outcome.message, outcome.status);
    });
  }

  private async handleCancelledNotification(request: Request, authorized: AuthorizedToken, rawParams: unknown): Promise<void> {
    const params = asObject(rawParams);
    const requestId = params.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      const scopeKey = activeRequestScopeKey(authorized, requestId);
      const active = this.activeRequests.get(scopeKey);
      if (active) {
        active.controller.abort("cancelled_by_notification");
        if (active.requestKey) {
          this.requestCancellations.cancel(active.requestKey);
          await this.config.cancelClientRequest(active.requestKey);
        }
      }
    }
    const headerKey = mcpStreamRequestKey(mcpStreamProxyId(request));
    if (headerKey) {
      this.requestCancellations.cancel(headerKey);
      await this.config.cancelClientRequest(headerKey);
    }
  }

  private async handleStateless2025Request(input: {
    request: Request;
    body: JsonRpcRequest;
    base: string;
    authorized: AuthorizedToken;
    mcpPath: McpResourcePath;
  }): Promise<Response> {
    const { request, body, base, authorized, mcpPath } = input;
    const params = asObject(body.params);
    switch (body.method) {
      case "initialize": {
        const client = asObject(params.clientInfo);
        if (typeof params.protocolVersion !== "string" || typeof client.name !== "string"
            || typeof client.version !== "string" || asObject(params.capabilities) !== params.capabilities) {
          return json(rpcError(body.id, -32602, "Invalid initialization parameters"));
        }
        const { name, version: serverVersion } = this.config.serverInfo;
        return json(rpcResult(body.id, {
          protocolVersion: MCP_2025_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version: serverVersion },
          instructions: this.config.stateless2025Instructions ?? this.config.instructions,
        }));
      }
      case "ping":
        return json(rpcResult(body.id, {}));
      case "tools/list":
        return json(rpcResult(body.id, { tools: this.config.tools(authorized, false) }));
      case "tools/call": {
        const call = { ...body, params: { name: params.name, arguments: params.arguments } };
        return this.trackActiveRequest(authorized, body.id!, request.signal, undefined, async (signal) => {
          const outcome = await dispatchWorkerToolCall(call, base, authorized, signal, undefined, undefined, {
            serverInfo: this.config.serverInfo,
            tools: (currentAuthorized) => this.config.tools(currentAuthorized, false),
            includeJobMonitor: false,
            recordError: this.config.recordError,
            callTool: (toolInput) => this.config.callTool({ ...toolInput, mcpPath, includeJobMonitor: false }),
          });
          if (!Object.hasOwn(outcome.message, "result")) return json(outcome.message, outcome.status);
          const { content, structuredContent, isError } = asObject(outcome.message.result);
          return json(rpcResult(body.id, { content, structuredContent, isError }), outcome.status);
        });
      }
      default:
        return json(rpcError(body.id, -32601, "Method not found"));
    }
  }

  private async trackActiveRequest<T>(
    authorized: AuthorizedToken,
    id: string | number,
    outerSignal: AbortSignal,
    requestKey: string | undefined,
    runner: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const scopeKey = activeRequestScopeKey(authorized, id);
    const controller = new AbortController();
    const existed = this.activeRequests.has(scopeKey);
    if (!existed) this.activeRequests.set(scopeKey, { controller, requestKey });
    const signal = AbortSignal.any([outerSignal, controller.signal]);
    try {
      return await runner(signal);
    } finally {
      if (!existed) this.activeRequests.delete(scopeKey);
    }
  }

  private streamedToolResponse(input: {
    request: Request; body: JsonRpcRequest; base: string; authorized: AuthorizedToken;
    proxyMode: StreamProxyMode; requestKey?: string; progressToken?: unknown; mcpPath: McpResourcePath;
  }): Response {
    return createStreamedToolResponse({
      request: input.request, body: input.body, base: input.base, authorized: input.authorized,
      requestKey: input.requestKey, progressToken: input.progressToken, cancellations: this.requestCancellations,
      dispatch: (signal, requestKey, progressToken) => this.trackActiveRequest(
        input.authorized,
        input.body.id!,
        signal,
        requestKey,
        (trackedSignal) => this.dispatch(input.body, input.base, input.authorized, trackedSignal, requestKey, progressToken, input.mcpPath),
      ),
      recordError: this.config.recordError,
    });
  }

  private async dispatch(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    signal: AbortSignal,
    requestKey?: string,
    progressToken?: unknown,
    mcpPath: McpResourcePath = NATIVE_MCP_PATH,
  ): Promise<McpDispatchResult> {
    if (request.method === "server/discover") return this.discover(request);
    if (request.method === "tools/list") return this.listTools(request, authorized);
    const resource = dispatchManagedJobMonitorResource(
      request,
      this.config.serverInfo,
      this.config.tools(authorized, true),
    );
    if (resource) return resource;
    const task = await dispatchWorkerTaskOperation(
      request, this.config.callTool, base, authorized, signal,
      this.config.taskStore, this.config.resolveTaskCredentials, this.config.serverInfo, requestKey,
    );
    if (task) return task;
    const prompt = await dispatchWorkerPromptOperation(
      request, this.config.callTool, base, authorized, signal, requestKey, this.config.serverInfo,
    );
    if (prompt) return prompt;
    if (request.method === "tools/call") return this.callTool(request, base, authorized, signal, requestKey, progressToken, mcpPath);
    return { status: 200, message: rpcError(request.id, -32601, "Method not found") };
  }

  private discover(request: JsonRpcRequest): McpDispatchResult {
    return { status: 200, message: rpcResult(request.id, discoverResult({
      supportedVersions: this.config.supportedVersions, capabilities: this.config.capabilities,
      instructions: this.config.instructions, ttlMs: this.config.discoveryTtlMs, serverInfo: this.config.serverInfo,
    }))! };
  }

  private listTools(request: JsonRpcRequest, authorized: AuthorizedToken): McpDispatchResult {
    return { status: 200, message: rpcResult(request.id, cacheableResult(
      { tools: this.config.tools(authorized, true) },
      { ttlMs: this.config.toolListTtlMs, cacheScope: "private", serverInfo: this.config.serverInfo },
    ))! };
  }

  private async callTool(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    signal: AbortSignal,
    requestKey?: string,
    progressToken?: unknown,
    mcpPath: McpResourcePath = NATIVE_MCP_PATH,
  ): Promise<McpDispatchResult> {
    return dispatchWorkerToolCall(request, base, authorized, signal, requestKey, progressToken, {
      ...this.config,
      tools: (currentAuthorized) => this.config.tools(currentAuthorized, true),
      callTool: (toolInput) => this.config.callTool({ ...toolInput, mcpPath, includeJobMonitor: true }),
    });
  }
}

function inferProtocolMode(_request: Request, _body: JsonRpcRequest, mcpPath: McpResourcePath): McpProtocolMode {
  return mcpPath === GEMINI_MCP_PATH ? MCP_2025_PROTOCOL_VERSION : "2026-07-28";
}

function activeRequestScopeKey(authorized: AuthorizedToken, id: string | number): string {
  return `${authorized.accountId}:${authorized.clientId}:${typeof id}:${String(id)}`;
}
