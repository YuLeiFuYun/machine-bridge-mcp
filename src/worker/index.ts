import { DurableObject } from "cloudflare:workers";
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { PendingCallRegistrationError, PendingCallRegistry } from "./pending-calls.ts";
import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  DAEMON_READY_TIMEOUT_MS,
  daemonLastSeenMs,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
} from "./daemon-liveness.ts";
import { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "./runtime-alarm.ts";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "./daemon-auth.ts";
import { mcpClientRequestKey, resolveMcpSession } from "./mcp-session.ts";
import { acceptsEventStream } from "./mcp-stream.ts";
import { authorizeMcpRequest } from "./mcp-access.ts";
import { handleMcpResumptionRequest } from "./mcp-resumption-http.ts";
import {
  handleMcpStreamSubscribeRequest, mcpStreamDescriptorResponse, mcpStreamProxyMode,
  proxyMcpEventStream, sanitizeBridgeRequest,
} from "./mcp-stream-proxy.ts";
import { McpResumptionStore, McpStreamLimitError } from "./mcp-resumption.ts";
import { McpStreamChannel } from "./mcp-stream-channel.ts";
import { buildServerInfoResult, persistImmediateStreamOutcome, startEventDrivenStreamCall } from "./mcp-stream-dispatch.ts";
import { daemonToolTimeoutMs } from "./tool-timeout.ts";
import { WorkerObservability } from "./observability.ts";
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole } from "./access.ts";
import { OAuthController, type AuthorizedToken, type OAuthControllerEnv } from "./oauth-controller.ts";
import { accountAuthoritySnapshot, decorateProjectOverview, describeDaemonCeiling } from "./authority.ts";
import { serverInfoTool, workspaceTools } from "./tool-catalog.ts";
import { randomToken } from "./oauth-state.ts";
import {
  HttpError, applyCors, baseUrl, corsPreflight, json, methodNotAllowed,
  parseJsonRequest, workerErrorClass,
} from "./http.ts";
import { respondWithoutDurableObject } from "./worker-static-routes.ts";
import { authorizationServerMetadata } from "./worker-metadata.ts";
import { createThrottledEdgeLogger } from "./worker-edge-log.ts";
import {
  admitStatefulRequest, durableObjectQuotaResponse, isDurableObjectQuotaError,
  outerWorkerErrorClass, workerGatewayErrorResponse,
} from "./worker-edge-guard.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  sessionInstructionText, textToolResult, validateProtocolVersionHeader, type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly, trySendWebSocket,
} from "./websocket-protocol.ts";

const SERVER_NAME = String(serverMetadata.name);
const SERVER_VERSION = "3.0.0-beta.19";
const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);
const MCP_SUPPORTED_PROTOCOL_VERSIONS = serverMetadata.supportedProtocolVersions.map((value) => String(value));
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_CALLS = 32;
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_RECONNECT_GRACE_MS = relayContract.reconnectGraceMs;
const logOuterFetchFailure = createThrottledEdgeLogger();

interface BridgeEnv extends OAuthControllerEnv {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  DAEMON_DEVICE_PUBLIC_KEY: string;
  OAUTH_TOKEN_VERSION: string;
  MBM_WORKER_MAX_BODY_BYTES?: string;
  MBM_ALLOWED_ORIGINS?: string;
  STATEFUL_RATE_LIMITER: RateLimit;
}

const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");

export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS);
  private readonly observability = new WorkerObservability();
  private readonly oauth: OAuthController;
  private readonly daemonRegistry: DaemonSocketRegistry;
  private readonly streamChannel: McpStreamChannel;
  private readonly resumption: McpResumptionStore;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.oauth = new OAuthController(
      ctx, env, SERVER_NAME, SERVER_VERSION,
      (event) => this.observability.oauthRefreshEvent(event),
    );
    this.daemonRegistry = new DaemonSocketRegistry(ctx);
    this.streamChannel = new McpStreamChannel(ctx, this.observability);
    this.resumption = new McpResumptionStore(
      ctx.storage,
      {},
      (streamId, message) => this.streamChannel.publish(streamId, message),
      (rows) => this.observability.streamStorageRowsWritten(rows),
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.pending.expireDue();
    const base = baseUrl(request);
    const extraOrigins = this.env.MBM_ALLOWED_ORIGINS ?? "";
    let response: Response;
    if (request.method === "OPTIONS" && request.headers.has("Origin")) response = corsPreflight(request, base, extraOrigins);
    else response = applyCors(await this.handleRequest(request, base), request, base, extraOrigins);
    this.observability.requestFinished(response.status);
    return response;
  }

  private async handleRequest(request: Request, base: string): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/admin/accounts") return await this.oauth.handleAccountAdmin(request, "accounts");
      if (url.pathname === "/admin/accounts/rotate-password") return await this.oauth.handleAccountAdmin(request, "rotate-password");
      if (url.pathname === "/admin/clients") return await this.oauth.handleClientAdmin(request);
      if (url.pathname === "/oauth/register") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await this.oauth.registerClient(request);
      }
      if (url.pathname === "/oauth/authorize") {
        if (request.method === "GET") return await this.oauth.authorizeGet(request, base);
        if (request.method === "POST") return await this.oauth.authorizeSubmit(request, base);
        return methodNotAllowed("GET, POST");
      }
      if (url.pathname === "/oauth/token") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await this.oauth.exchangeToken(request, base);
      }
      if (url.pathname === "/daemon/ws") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await this.acceptDaemonWebSocket(request);
      }
      if (url.pathname === "/mcp") return await this.handleMcp(request, base);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
      this.observability.event("error", "http.request.failed", { path: url.pathname, error_class: workerErrorClass(error) });
      return json({ error: "internal_server_error" }, 500);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.pending.expireDue();
    if (this.streamChannel.isSubscriber(ws)) {
      this.streamChannel.rejectSubscriberMessage(ws);
      return;
    }
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_DAEMON_MESSAGE_BYTES) {
      closeWebSocketQuietly(ws, 1009, "message too large");
      return;
    }
    let text: string;
    try {
      text = typeof message === "string" ? message : new TextDecoder("utf-8", { fatal: true }).decode(message);
    } catch {
      closeWebSocketQuietly(ws, 1007, "invalid UTF-8");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      rejectDaemonMessage(ws, "invalid_json", 1007, "invalid JSON");
      return;
    }
    if (!isObjectRecord(parsed)) {
      rejectDaemonMessage(ws, "invalid_message", 1002, "daemon message must be an object");
      return;
    }
    const body = parsed;

    const socketAttachment = this.daemonRegistry.attachment(ws);
    if (!socketAttachment) {
      closeWebSocketQuietly(ws, 1008, "missing daemon attachment");
      return;
    }

    if (socketAttachment.role === "expired") {
      closeWebSocketQuietly(ws, 1008, "expired daemon candidate");
      return;
    }

    if (body.type === "hello") {
      if (socketAttachment.role !== "candidate") {
        rejectDaemonMessage(ws, "duplicate_hello", 1002, "duplicate daemon hello");
        return;
      }
      if (!isFreshDaemonCandidate(socketAttachment.connectedAt)) {
        closeWebSocketQuietly(ws, 1008, "stale daemon candidate");
        await this.scheduleRuntimeAlarm();
        return;
      }
      const instanceId = daemonInstanceId(body.instance_id);
      if (!instanceId) {
        rejectDaemonMessage(ws, "invalid_daemon_instance", 1002, "daemon instance id required");
        return;
      }
      if (
        !socketAttachment.authChallenge
        || !socketAttachment.authIssuedAt
        || !socketAttachment.authExpiresAt
        || !socketAttachment.workerOrigin
        || !socketAttachment.authSessionPublicKeyJson
        || !socketAttachment.authSessionKeyId
        || !socketAttachment.authCertificateExpiresAt
      ) {
        rejectDaemonMessage(ws, "missing_daemon_challenge", 1008, "daemon challenge missing");
        return;
      }
      const authenticated = await verifyDaemonAuthentication({
        publicKeyJson: socketAttachment.authSessionPublicKeyJson,
        authentication: body.authentication,
        challenge: {
          scheme: "device-signature-v1",
          challenge: socketAttachment.authChallenge,
          issuedAt: socketAttachment.authIssuedAt,
          expiresAt: socketAttachment.authExpiresAt,
          workerOrigin: socketAttachment.workerOrigin,
        },
        server: SERVER_NAME,
        version: SERVER_VERSION,
        instanceId,
        certificateExpiresAt: socketAttachment.authCertificateExpiresAt,
      });
      if (!authenticated) {
        rejectDaemonMessage(ws, "daemon_authentication_failed", 1008, "daemon authentication failed");
        return;
      }
      const daemonPolicy = sanitizeDaemonPolicy(body.policy);
      const authenticatedAt = new Date().toISOString();
      const probeId = randomToken("probe");
      this.daemonRegistry.beginProbe(ws, {
        connectedAt: authenticatedAt,
        probeId,
        instanceId,
        policy: daemonPolicy,
        tools: sanitizeDaemonTools(body.tools, daemonPolicy),
      });
      this.observability.socketAuthenticated();
      try {
        ws.send(JSON.stringify({ type: "hello_ack", server: SERVER_NAME, version: SERVER_VERSION }));
        ws.send(JSON.stringify({ type: "relay_probe", id: probeId }));
      } catch {
        this.daemonRegistry.expire(ws);
        closeWebSocketQuietly(ws, 1011, "daemon readiness probe failed");
        await this.scheduleRuntimeAlarm();
        return;
      }
      await this.scheduleRuntimeAlarm();
      return;
    }

    if (socketAttachment.role === "candidate") {
      closeWebSocketQuietly(ws, 1008, "daemon hello required");
      return;
    }

    if (body.type === "heartbeat" || body.type === "ping") {
      await this.touchDaemonSocket(ws);
      if (!trySendWebSocket(ws, { type: "pong", ts: body.ts ?? Date.now() })) {
        await this.invalidateDaemonSocket(ws, "failed to acknowledge daemon heartbeat", "daemon pong failed", "daemon_transport_error");
      }
      return;
    }

    if (socketAttachment.role === "probing") {
      if (body.type !== "relay_probe_result" || typeof body.id !== "string" || body.id !== socketAttachment.probeId) {
        rejectDaemonMessage(ws, "invalid_relay_probe_result", 1002, "invalid daemon readiness result");
        return;
      }
      const readyAt = new Date().toISOString();
      const readyAttachment = this.daemonRegistry.promote(ws, readyAt);
      if (!readyAttachment) {
        rejectDaemonMessage(ws, "invalid_relay_readiness_state", 1002, "invalid daemon readiness state");
        return;
      }
      const daemonInstanceId = readyAttachment.instanceId ?? "";
      const previousSockets = this.daemonRegistry.readyRoleSockets().filter((socket) => socket !== ws);
      const fallbackSocket = previousSockets.find((socket) => this.daemonRegistry.readyAttachment(socket)?.instanceId === daemonInstanceId);
      const reboundCallIds = this.pending.rebindInstance(daemonInstanceId, ws);
      if (reboundCallIds.length > 0) {
        this.observability.event("info", "daemon.calls.rebound", { rebound_calls: reboundCallIds.length });
      }
      try {
        ws.send(JSON.stringify({ type: "resume_calls", ids: reboundCallIds }));
        ws.send(JSON.stringify({ type: "ready_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        await this.invalidateDaemonSocket(ws, "daemon readiness acknowledgement failed", "daemon ready timeout", "daemon_ready_timeout");
        if (fallbackSocket?.readyState === WebSocket.OPEN) this.pending.rebindInstance(daemonInstanceId, fallbackSocket);
        await this.scheduleRuntimeAlarm();
        return;
      }
      this.observability.socketReady();
      for (const previous of previousSockets) {
        await this.detachDaemonSocketCalls(previous, "daemon connection replaced after verified handover");
        this.daemonRegistry.expire(previous);
        closeWebSocketQuietly(previous, 1012, "replaced by verified daemon");
      }
      await this.scheduleRuntimeAlarm();
      return;
    }

    if (socketAttachment.role !== "daemon") {
      closeWebSocketQuietly(ws, 1008, "daemon readiness required");
      return;
    }

    if (body.type !== "tool_result" || typeof body.id !== "string") {
      rejectDaemonMessage(ws, "unknown_message_type", 1002, "unknown daemon message type");
      return;
    }

    await this.touchDaemonSocket(ws);
    const matched = body.ok === false
      ? await this.pending.reject(body.id, daemonToolError(body.error), ws)
      : await this.pending.resolve(body.id, ws, body.result);
    if (!matched) this.observability.unmatchedResult();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.streamChannel.isSubscriber(ws)) return;
    await this.cleanupDaemonSocket(ws, "daemon disconnected");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (this.streamChannel.isSubscriber(ws)) return;
    this.observability.event("warn", "daemon.websocket.error", { error_class: workerErrorClass(error) });
    await this.cleanupDaemonSocket(ws, "daemon transport error");
  }

  private async cleanupDaemonSocket(ws: WebSocket, message: string): Promise<void> {
    this.observability.socketDisconnected();
    await this.detachDaemonSocketCalls(ws, message);
    await this.scheduleRuntimeAlarm();
  }
  private async handleMcp(request: Request, base: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "mcp endpoint expects GET or POST" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "GET, POST", "cache-control": "no-store" },
      });
    }

    const proxyMode = mcpStreamProxyMode(request);
    const subscribed = await handleMcpStreamSubscribeRequest(request, this.streamChannel, this.resumption);
    if (subscribed) return subscribed;

    const access = await authorizeMcpRequest({
      request,
      base,
      oauth: this.oauth,
      storage: this.ctx.storage,
      bodyLimitBytes: this.bodyLimitBytes(),
    });
    if (access.response) return access.response;
    if (request.method === "GET") {
      if (proxyMode !== "prepare") return json({ error: "stream_proxy_required" }, 500);
      return await handleMcpResumptionRequest({
        request,
        authorized: access.authorized,
        identityKey: this.oauth.identityKey(),
        supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        resumption: this.resumption,
      });
    }

    const body = await parseJsonRequest(request, this.bodyLimitBytes());
    if (isJsonRpcResponse(body)) return new Response(null, { status: 202 });
    if (!isJsonRpcRequest(body)) return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);
    const protocolError = validateProtocolVersionHeader(request, body, MCP_SUPPORTED_PROTOCOL_VERSIONS);
    if (protocolError) return json(protocolError, 400);

    const session = await resolveMcpSession(request, body.method, this.oauth.identityKey(), access.authorized.tokenKey);
    if (session.kind === "invalid") return json(rpcError(body.id, -32001, "MCP session not found"), 404);
    const sessionId = session.kind === "active" ? session.sessionId : "";

    if (body.method === "tools/call" && acceptsEventStream(request)) {
      if (proxyMode !== "prepare") return json(rpcError(body.id, -32603, "MCP stream proxy is unavailable"), 500);
      if (body.id === undefined || body.id === null) return json(rpcError(null, -32600, "tools/call requires a non-null request id"), 400);
      const streamId = randomToken("stream");
      try {
        await this.resumption.begin({
          streamId,
          tokenKey: access.authorized.tokenKey,
          sessionId,
          requestId: body.id,
        });
      } catch (error) {
        if (error instanceof McpStreamLimitError) {
          return json(rpcError(body.id, -32004, error.message), 429);
        }
        this.observability.event("error", "mcp.stream.begin.failed", { error_class: workerErrorClass(error) });
        return json(rpcError(body.id, -32603, "Resumable stream storage is unavailable"), 503);
      }

      const params = asObject(body.params);
      const name = requiredString(params, "name");
      const args = asObject(params.arguments);
      try {
        if (name === "server_info") {
          await persistImmediateStreamOutcome({
            resumption: this.resumption, observability: this.observability, streamId, requestId: body.id,
            outcome: { ok: true, value: this.serverInfoResult(base, access.authorized) },
          });
        } else {
          if (!workspaceTools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`);
          if (!this.daemonToolEnabled(name)) throw new Error(`tool disabled by local daemon policy: ${name}`);
          if (!accountRoleAllowsTool(access.authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
          this.reclaimStaleDaemonSockets();
          const socket = this.daemonRegistry.readySockets()[0];
          if (!socket) throw new WorkerToolError("unavailable", "local daemon is not connected; keep the CLI start command running", true);
          const daemonInstanceId = this.daemonRegistry.readyAttachment(socket)?.instanceId ?? "";
          if (!daemonInstanceId) throw new WorkerToolError("unavailable", "local daemon connection is missing its instance identity", true);
          await startEventDrivenStreamCall({
            pending: this.pending, resumption: this.resumption, observability: this.observability,
            streamId, requestId: body.id, clientRequestKey: mcpClientRequestKey(access.authorized.tokenKey, sessionId, body.id),
            tool: name, arguments: args, socket, daemonInstanceId, timeoutMs: daemonToolTimeoutMs(name, args),
            authorization: {
              account_id: access.authorized.accountId, account_version: access.authorized.accountVersion,
              client_id: access.authorized.clientId, family_id: access.authorized.familyId, role: access.authorized.role,
            },
            onTimeout: (record) => this.daemonCallTimeout(record, name),
            onSendFailure: () => this.invalidateDaemonSocket(socket, "failed to send daemon tool call", "daemon send failed"),
            transformResult: name === "project_overview"
              ? (value) => decorateProjectOverview(value, { accountId: access.authorized.accountId,
                accountVersion: access.authorized.accountVersion, role: access.authorized.role })
              : undefined,
          });
          await this.scheduleRuntimeAlarm();
        }
      } catch (error) {
        await persistImmediateStreamOutcome({
          resumption: this.resumption, observability: this.observability, streamId, requestId: body.id,
          outcome: { ok: false, error: error instanceof Error ? error : new Error("streamed tool call failed") },
        });
      }
      return mcpStreamDescriptorResponse("initial", streamId);
    }

    const response = await this.dispatchJsonRpc(body, base, access.authorized, sessionId);
    if (response === null) return new Response(null, { status: 202 });
    return session.kind === "initialize" ? json(response, 200, { "mcp-session-id": session.sessionId }) : json(response);
  }

  private async dispatchJsonRpc(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") {
      const requested = asObject(request.params).protocolVersion;
      const protocolVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])
        ? requested
        : MCP_PROTOCOL_VERSION;
      let bootstrap = null;
      if (this.daemonToolEnabled("session_bootstrap")) {
        try {
          bootstrap = await this.callDaemonTool("session_bootstrap", { path: "." }, authorized);
        } catch {
          // Initialization remains usable without optional local instructions, but the degradation is observable.
          this.observability.recordError("session_bootstrap_failed");
        }
      }
      const localInstructions = sessionInstructionText(bootstrap);
      return rpcResult(request.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: {
          name: SERVER_NAME,
          title: "Machine Bridge MCP",
          version: SERVER_VERSION,
          description: "Workspace-scoped local coding tools over authenticated remote relay.",
        },
        instructions: localInstructions ? `${MCP_INSTRUCTIONS}\n\n--- LOCAL SESSION INSTRUCTIONS ---\n${localInstructions}` : MCP_INSTRUCTIONS,
      });
    }
    if (request.method === "notifications/initialized") return null;
    if (request.method === "notifications/cancelled") {
      await this.cancelClientRequest(mcpClientRequestKey(authorized.tokenKey, sessionId, asObject(request.params).requestId));
      return null;
    }
    if (request.method === "logging/setLevel") return rpcResult(request.id, {});
    if (request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") return rpcResult(request.id, { tools: this.allTools(authorized.role) });
    if (request.method === "tools/call") {
      if (request.id === undefined || request.id === null) return rpcError(null, -32600, "tools/call requires a non-null request id");
      const params = asObject(request.params);
      const name = requiredString(params, "name");
      const args = asObject(params.arguments);
      try {
        const result = await this.callTool(
          name,
          args,
          base,
          authorized,
          mcpClientRequestKey(authorized.tokenKey, sessionId, request.id),
        );
        return rpcResult(request.id, textToolResult(result));
      } catch (error) {
        return rpcResult(request.id, textToolResult({ error: publicWorkerToolError(error) }, true));
      }
    }
    return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
  private serverInfoResult(base: string, authorized: AuthorizedToken): Record<string, unknown> {
    const { daemon, tools, authorization } = this.authorityContext(authorized);
    return buildServerInfoResult({
      serverName: SERVER_NAME, serverVersion: SERVER_VERSION, base,
      oauth: authorizationServerMetadata(base, SERVER_NAME), authorization, daemon, tools,
      pending: this.pending, daemonRegistry: this.daemonRegistry, observability: this.observability,
    });
  }
  private async callTool(
    name: string,
    args: Record<string, unknown>,
    base: string,
    authorized: AuthorizedToken,
    requestKey?: string,
  ): Promise<unknown> {
    if (name === "server_info") return this.serverInfoResult(base, authorized);
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!this.daemonToolEnabled(name)) throw new Error(`tool disabled by local daemon policy: ${name}`);
      if (!accountRoleAllowsTool(authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
      const result = await this.callDaemonTool(name, args, authorized, requestKey);
      return name === "project_overview" ? decorateProjectOverview(result, { accountId: authorized.accountId,
        accountVersion: authorized.accountVersion, role: authorized.role }) : result;
    }
    throw new Error(`unknown tool: ${name}`);
  }
  private async callDaemonTool(
    name: string,
    args: Record<string, unknown>,
    authorized: AuthorizedToken,
    requestKey?: string,
  ): Promise<unknown> {
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readySockets()[0];
    if (!socket) throw new WorkerToolError("unavailable", "local daemon is not connected; keep the CLI start command running", true);
    const daemonAttachment = this.daemonRegistry.readyAttachment(socket);
    const daemonInstanceId = daemonAttachment?.instanceId ?? "";
    if (!daemonInstanceId) throw new WorkerToolError("unavailable", "local daemon connection is missing its instance identity", true);
    const id = randomToken("call");
    const timeoutMs = daemonToolTimeoutMs(name, args);
    let result: Promise<unknown>;
    try {
      result = this.pending.register({
        id,
        socket,
        daemonInstanceId,
        clientRequestKey: requestKey,
        tool: name,
        timeoutMs,
        onTimeout: (record) => this.daemonCallTimeout(record, name),
      });
    } catch (error) {
      if (error instanceof PendingCallRegistrationError) {
        throw new WorkerToolError(error.code, error.message, error.retryable);
      }
      throw error;
    }
    await this.scheduleRuntimeAlarm();
    this.observability.callStarted(name);
    try {
      socket.send(JSON.stringify({
          type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutMs,
          authorization: {
            account_id: authorized.accountId,
            account_version: authorized.accountVersion,
            client_id: authorized.clientId,
            family_id: authorized.familyId,
            role: authorized.role,
          },
      }));
    } catch {
      await this.pending.reject(id, new WorkerToolError("network_error", "failed to send daemon tool call", true), socket);
      await this.invalidateDaemonSocket(socket, "failed to send daemon tool call", "daemon send failed");
    }
    try {
      const value = await result;
      this.observability.callFinished(name);
      return value;
    } catch (error) {
      this.observability.callFinished(name, publicWorkerToolError(error).code);
      throw error;
    }
  }
  private daemonCallTimeout(record: import("./pending-call-contract.ts").PendingCallRecord, name: string): Error {
    if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
    const silentForMs = record.socket ? Date.now() - daemonLastSeenMs(this.daemonRegistry.readyAttachment(record.socket)) : 0;
    if (record.socket && (!Number.isFinite(silentForMs) || silentForMs > 45_000)) {
      void this.invalidateDaemonSocket(record.socket, "daemon became unresponsive", "daemon liveness timeout");
    }
    return new WorkerToolError("timeout", `daemon tool timed out: ${name}`, true);
  }

  private async cancelClientRequest(requestKey?: string): Promise<void> {
    if (!requestKey) return;
    await this.pending.cancelRequest(requestKey, (record) => {
      if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
      return new WorkerToolError("cancelled", "tool call cancelled by client");
    });
  }
  private async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    if (!this.env.DAEMON_DEVICE_PUBLIC_KEY) return new Response("Daemon device identity is not configured", { status: 503 });
    const workerOrigin = new URL(request.url).origin;
    const preflight = await verifyDaemonPreflight({
      publicKeyJson: this.env.DAEMON_DEVICE_PUBLIC_KEY,
      headers: request.headers,
      workerOrigin,
      server: SERVER_NAME,
      version: SERVER_VERSION,
    });
    if (!preflight || !(await consumeDaemonPreflightNonce(this.ctx.storage, preflight))) {
      return new Response("Unauthorized daemon device", { status: 401 });
    }
    const challenge = createDaemonChallenge(workerOrigin);

    for (const socket of this.daemonRegistry.nonReadySockets()) {
      closeWebSocketQuietly(socket, 1012, "replaced by newer daemon candidate");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.observability.socketCandidate();
    this.daemonRegistry.beginCandidate(server, challenge, preflight);
    await this.scheduleRuntimeAlarm();
    const welcomed = trySendWebSocket(server, {
      type: "welcome",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      worker_origin: workerOrigin,
      authentication: {
        scheme: challenge.scheme,
        challenge: challenge.challenge,
        issued_at: challenge.issuedAt,
        expires_at: challenge.expiresAt,
      },
    });
    if (!welcomed) {
      this.daemonRegistry.expire(server);
      closeWebSocketQuietly(server, 1011, "daemon welcome failed");
      await this.scheduleRuntimeAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private allTools(role: AccountRole): Array<Record<string, unknown>> {
    const advertised = accountRoleToolNames(role, this.daemonAdvertisedTools());
    const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
    return [serverInfoTool, ...localTools].map((tool) => structuredClone(tool));
  }
  private authorityContext(authorized: AuthorizedToken) {
    const daemon = describeDaemonCeiling(this.daemonStatus(true));
    const tools = this.allTools(authorized.role).map((tool) => String(tool.name));
    const authorization = accountAuthoritySnapshot({ accountId: authorized.accountId, accountVersion: authorized.accountVersion,
      role: authorized.role, daemonPolicy: daemon.policy, effectiveTools: tools });
    return { daemon, tools, authorization };
  }
  private daemonToolEnabled(name: string): boolean {
    return this.daemonAdvertisedTools().has(name);
  }
  private daemonAdvertisedTools(): Set<string> {
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readySockets()[0];
    if (!socket) return new Set();
    const attachment = this.daemonRegistry.readyAttachment(socket);
    if (!attachment?.tools) return new Set();
    return new Set(attachment.tools);
  }

  private async touchDaemonSocket(ws: WebSocket): Promise<void> {
    if (!this.daemonRegistry.touch(ws)) return;
    await this.scheduleRuntimeAlarm();
  }

  private async invalidateDaemonSocket(
    ws: WebSocket,
    message: string,
    closeReason: string,
    errorCode = "daemon_liveness_timeout",
  ): Promise<void> {
    const cleanup = this.detachDaemonSocketCalls(ws, message);
    this.daemonRegistry.expire(ws);
    sendWebSocketQuietly(ws, { type: "error", error: errorCode });
    closeWebSocketQuietly(ws, 1008, closeReason);
    await cleanup;
  }

  private async detachDaemonSocketCalls(ws: WebSocket, message: string): Promise<number> {
    const attachment = this.daemonRegistry.attachment(ws);
    if (!attachment?.instanceId) {
      return await this.pending.rejectSocket(ws, () => new WorkerToolError("unavailable", message, true));
    }
    return this.pending.detachSocket(
      ws,
      DAEMON_RECONNECT_GRACE_MS,
      () => new WorkerToolError("unavailable", `${message}; reconnect grace expired`, true),
    );
  }

  private reclaimStaleDaemonSockets(now = Date.now()): void {
    for (const socket of this.daemonRegistry.readyRoleSockets()) {
      const deadline = daemonLivenessDeadlineMs(this.daemonRegistry.readyAttachment(socket));
      if (Number.isFinite(deadline) && deadline > now) continue;
      void this.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout");
    }
  }

  async alarm(): Promise<void> {
    await processRuntimeAlarm(this.runtimeAlarmContext());
  }

  private async scheduleRuntimeAlarm(): Promise<void> {
    await scheduleRuntimeAlarm(this.runtimeAlarmContext());
  }

  private runtimeAlarmContext() {
    return {
      storage: this.ctx.storage,
      pending: this.pending,
      daemonRegistry: this.daemonRegistry,
      invalidateDaemonSocket: (socket: WebSocket, message: string, closeReason: string, errorCode?: string) =>
        this.invalidateDaemonSocket(socket, message, closeReason, errorCode),
      onScheduleError: (error: unknown) => this.observability.event(
        "error", "runtime.alarm.schedule.failed", { error_class: workerErrorClass(error) },
      ),
      onAlarmMutation: (action: "set" | "delete" | "noop") => this.observability.runtimeAlarmMutation(action),
    };
  }

  private daemonStatus(detail: boolean): Record<string, unknown> {
    this.reclaimStaleDaemonSockets();
    const sockets = this.daemonRegistry.readySockets();
    const attachment = sockets[0] ? this.daemonRegistry.readyAttachment(sockets[0]) : undefined;
    const tools = attachment?.tools ?? [];
    const base = {
      connected: sockets.length > 0,
      count: sockets.length,
      tool_count: tools.length,
      connected_at: attachment?.connectedAt ?? null,
      last_seen_at: attachment?.lastSeenAt ?? attachment?.connectedAt ?? null,
      readiness_verified: sockets.length > 0,
      readiness_timeout_ms: DAEMON_READY_TIMEOUT_MS,
      liveness_timeout_ms: DAEMON_LIVENESS_TIMEOUT_MS,
    };
    if (!detail) return base;
    return {
      ...base,
      policy: attachment?.policy ?? null,
      tools,
    };
  }

  private bodyLimitBytes(): number {
    const parsed = Number.parseInt(this.env.MBM_WORKER_MAX_BODY_BYTES ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
    return Math.min(parsed, MAX_BODY_BYTES);
  }
}

export default {
  async fetch(request: Request, env: BridgeEnv, ctx: ExecutionContext): Promise<Response> {
    const extraOrigins = env.MBM_ALLOWED_ORIGINS ?? "";
    const staticResponse = respondWithoutDurableObject(
      request,
      { server: SERVER_NAME, version: SERVER_VERSION },
      extraOrigins,
    );
    if (staticResponse) return staticResponse;

    try {
      const limited = await admitStatefulRequest(request, env.STATEFUL_RATE_LIMITER, extraOrigins);
      if (limited) return limited;
      const stub = env.BRIDGE.getByName("default");
      const streamed = await proxyMcpEventStream({
        request,
        bridge: stub,
        extraOrigins,
        ctx,
      });
      return streamed ?? stub.fetch(sanitizeBridgeRequest(request));
    } catch (error) {
      if (isDurableObjectQuotaError(error)) return durableObjectQuotaResponse(request, extraOrigins);
      logOuterFetchFailure("error", "outer.fetch.failed", {
        path: new URL(request.url).pathname,
        error_class: outerWorkerErrorClass(error),
      });
      return workerGatewayErrorResponse(request, extraOrigins);
    }
  },
} satisfies ExportedHandler<BridgeEnv>;

function daemonInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^daemon_[A-Za-z0-9_-]{16,96}$/.test(value)) return "";
  return value;
}
