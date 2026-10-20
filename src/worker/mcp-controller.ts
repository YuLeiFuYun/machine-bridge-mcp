import type { AuthorizedToken } from "./access.ts";
import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { acceptsEventStream } from "./mcp-http-accept.ts";
import { mcpStreamProxyId, mcpStreamRequestKey, type StreamProxyMode } from "./mcp-stream-proxy-contract.ts";
import { McpRequestCancellationRegistry } from "./mcp-request-cancellation.ts";
import { closedSubscriptionResponse } from "./mcp-subscription-stream.ts";
import { McpSubscriptionRegistry } from "./mcp-subscription-registry.ts";
import { json } from "./http.ts";
import {
  cacheableResult, discoverResult, emptySubscriptionAcknowledgement,
  McpProtocolError, subscriptionAcknowledgement, subscriptionCompleteResult,
  toolsListChangedNotification, validateSubscriptionRequest,
} from "../shared/mcp-protocol.mjs";
import { rpcError, rpcResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { dispatchManagedJobMonitorResource } from "./mcp-job-monitor-ui.ts";
import { dispatchWorkerTaskOperation, type TaskCredentialResolver } from "./mcp-tasks.ts";
import type { McpTaskStore } from "./mcp-task-store.ts";
import { dispatchWorkerPromptOperation } from "./mcp-prompts.ts";
import { createStreamedToolResponse } from "./mcp-streamed-tool-dispatch.ts";
import { dispatchWorkerToolCall } from "./mcp-tool-call-dispatch.ts";
type McpConfig = Readonly<{
  capabilities: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  instructions: string;
  supportedVersions: readonly string[];
  discoveryTtlMs: number;
  toolListTtlMs: number;
  taskStore?: McpTaskStore;
  resolveTaskCredentials?: TaskCredentialResolver;
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
    clientCapabilities?: Record<string, unknown>;
    progressToken?: unknown;
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
    if (body.method === "tools/call" && acceptsEventStream(request)) return this.streamedToolResponse({ ...input, requestKey });
    const outcome = await this.dispatch(input.body, input.base, input.authorized, request.signal, requestKey, input.progressToken);
    return json(outcome.message, outcome.status);
  }

  private streamedToolResponse(input: {
    request: Request; body: JsonRpcRequest; base: string; authorized: AuthorizedToken;
    proxyMode: StreamProxyMode; requestKey?: string; progressToken?: unknown;
  }): Response {
    return createStreamedToolResponse({
      request: input.request, body: input.body, base: input.base, authorized: input.authorized,
      requestKey: input.requestKey, progressToken: input.progressToken, cancellations: this.requestCancellations,
      dispatch: (signal, requestKey, progressToken) => this.dispatch(input.body, input.base, input.authorized, signal, requestKey, progressToken),
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
  ): Promise<McpDispatchResult> {
    if (request.method === "server/discover") return this.discover(request);
    if (request.method === "tools/list") return this.listTools(request, authorized);
    const resource = dispatchManagedJobMonitorResource(request, this.config.serverInfo); if (resource) return resource;
    const task = await dispatchWorkerTaskOperation(
      request, this.config.callTool, base, authorized, signal,
      this.config.taskStore, this.config.resolveTaskCredentials, this.config.serverInfo, requestKey,
    ); if (task) return task;
    const prompt = await dispatchWorkerPromptOperation(request, this.config.callTool, base, authorized, signal, requestKey, this.config.serverInfo); if (prompt) return prompt;
    if (request.method === "tools/call") return this.callTool(request, base, authorized, signal, requestKey, progressToken);
    return { status: 404, message: rpcError(request.id, -32601, "Method not found") };
  }

  private discover(request: JsonRpcRequest): McpDispatchResult {
    return { status: 200, message: rpcResult(request.id, discoverResult({
      supportedVersions: this.config.supportedVersions, capabilities: this.config.capabilities,
      instructions: this.config.instructions, ttlMs: this.config.discoveryTtlMs, serverInfo: this.config.serverInfo,
    }))! };
  }

  private listTools(request: JsonRpcRequest, authorized: AuthorizedToken): McpDispatchResult {
    return { status: 200, message: rpcResult(request.id, cacheableResult(
      { tools: this.config.tools(authorized) },
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
  ): Promise<McpDispatchResult> {
    return dispatchWorkerToolCall(request, base, authorized, signal, requestKey, progressToken, this.config);
  }
}
