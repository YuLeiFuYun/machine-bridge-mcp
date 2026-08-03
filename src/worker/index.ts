import { DurableObject } from "cloudflare:workers";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { PendingCallRegistrationError, PendingCallRegistry } from "./pending-calls.ts";
import { MAX_PENDING_CALLS, RESERVED_CONTROL_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS, assertWorkerPendingCallAdmission } from "./pending-call-capacity.ts";
import { PendingAdmissionGate } from "./pending-admission.ts";
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  DAEMON_READY_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
} from "./daemon-liveness.ts";
import { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "./runtime-alarm.ts";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "./daemon-auth.ts";
import { resolveMcpSession } from "./mcp-session.ts";
import { LegacyMcpDispatcher } from "./mcp-legacy-dispatch.ts";
import { acceptsEventStream } from "./mcp-stream.ts";
import { ModernMcpController } from "./mcp-modern-controller.ts";
import { prepareLegacyStreamedToolCall, type LegacyWorkspaceStreamCallInput } from "./mcp-legacy-stream-prepare.ts";
import { authorizeMcpRequest } from "./mcp-access.ts";
import { handleMcpResumptionRequest } from "./mcp-resumption-http.ts";
import { handleMcpStreamSubscribeRequest, mcpStreamProxyMode, mcpStreamProxyRetryId } from "./mcp-stream-proxy.ts";
import { McpResumptionStore } from "./mcp-resumption.ts";
import { McpStreamChannel } from "./mcp-stream-channel.ts";
import { buildServerInfoResult, startEventDrivenStreamCall } from "./mcp-stream-dispatch.ts";
import { DurableStreamCallCoordinator } from "./durable-stream-calls.ts";
import { handleOuterWorkerFetch } from "./worker-entry.ts";
import { daemonToolTimeoutBudget } from "./tool-timeout.ts";
import { WorkerObservability } from "./observability.ts";
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole } from "./access.ts";
import { OAuthController, type AuthorizedToken } from "./oauth-controller.ts";
import { accountAuthoritySnapshot, decorateProjectOverview, describeDaemonCeiling } from "./authority.ts";
import { serverInfoTool, validateWorkerToolArguments, workerToolParameterHeaders, workspaceTools } from "./tool-catalog.ts";
import { detectHttpMcpEra, McpHttpContractError, validateModernHttpRequest } from "./mcp-http-contract.ts";
import { randomToken } from "./oauth-state.ts";
import {
  HttpError, applyCors, baseUrl, corsPreflight, json, mcpOriginRejection, methodNotAllowed,
  parseJsonRequest, workerErrorClass,
} from "./http.ts";
import { authorizationServerMetadata } from "./worker-metadata.ts";
import { workerBodyLimitBytes, type BridgeEnv } from "./worker-runtime-config.ts";
import {
  MCP_DISCOVERY_TTL_MS, MCP_INSTRUCTIONS, MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSIONS, MCP_SERVER_CAPABILITIES, MCP_TOOL_LIST_TTL_MS,
  SERVER_NAME, mcpServerInfo,
} from "./worker-mcp-config.ts";
import {
  MCP_LEGACY_PROTOCOL_VERSION, MCP_MODERN_PROTOCOL_VERSION,
} from "../shared/mcp-protocol.mjs";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, rpcError,
  validateProtocolVersionHeader, type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "./websocket-protocol.ts";

const SERVER_VERSION = "3.0.0-beta.32";
const MCP_SERVER_INFO = mcpServerInfo(SERVER_VERSION);
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_RECONNECT_GRACE_MS = relayContract.reconnectGraceMs;
export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS);
  private readonly observability = new WorkerObservability();
  private readonly oauth: OAuthController;
  private readonly daemonRegistry: DaemonSocketRegistry;
  private readonly streamChannel: McpStreamChannel;
  private readonly resumption: McpResumptionStore;
  private readonly durableCalls: DurableStreamCallCoordinator;
  private readonly pendingAdmission = new PendingAdmissionGate();
  private readonly modernMcp: ModernMcpController;
  private readonly legacyMcp: LegacyMcpDispatcher;

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
    this.durableCalls = new DurableStreamCallCoordinator(
      this.resumption.calls,
      this.daemonRegistry,
      this.observability,
      MAX_PENDING_CALLS,
      RESERVED_CONTROL_PENDING_CALLS,
    );
    this.modernMcp = new ModernMcpController({
      capabilities: MCP_SERVER_CAPABILITIES,
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
      supportedVersions: MCP_MODERN_PROTOCOL_VERSIONS,
      discoveryTtlMs: MCP_DISCOVERY_TTL_MS,
      toolListTtlMs: MCP_TOOL_LIST_TTL_MS,
      tools: (authorized) => this.allTools(authorized.role),
      recordError: (code) => this.observability.recordError(code),
      cancelClientRequest: (requestKey) => this.cancelClientRequest(requestKey),
      callTool: ({ name, args, base, authorized, signal, requestKey }) => this.callTool(
        name, args, base, authorized, requestKey, signal,
      ),
    });
    this.legacyMcp = new LegacyMcpDispatcher({
      defaultVersion: MCP_LEGACY_PROTOCOL_VERSION,
      supportedVersions: MCP_LEGACY_PROTOCOL_VERSIONS,
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
      daemonToolEnabled: (name) => this.daemonToolEnabled(name),
      callDaemonTool: (name, args, authorized) => this.callDaemonTool(name, args, authorized),
      recordError: (code) => this.observability.recordError(code),
      cancelClientRequest: (requestKey) => this.cancelClientRequest(requestKey),
      tools: (authorized) => this.allTools(authorized.role),
      callTool: ({ name, args, base, authorized, requestKey }) => this.callTool(
        name, args, base, authorized, requestKey,
      ),
    });
  }
  async fetch(request: Request): Promise<Response> {
    await this.expireOverdueCalls();
    const base = baseUrl(request);
    const extraOrigins = this.env.MBM_ALLOWED_ORIGINS ?? "";
    let response: Response;
    if (request.method === "OPTIONS" && request.headers.has("Origin")) response = corsPreflight(request, base, extraOrigins, workerToolParameterHeaders);
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
    await this.expireOverdueCalls();
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
      const connectionId = socketAttachment.connectionId ?? "";
      if (!connectionId) {
        rejectDaemonMessage(ws, "missing_daemon_connection_identity", 1008, "daemon connection identity missing");
        return;
      }
      this.daemonRegistry.beginProbe(ws, {
        connectedAt: authenticatedAt,
        probeId,
        instanceId,
        connectionId,
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
      const connectionId = readyAttachment.connectionId ?? "";
      if (!daemonInstanceId || !connectionId) {
        await this.invalidateDaemonSocket(ws, "daemon readiness identity is incomplete", "daemon ready timeout", "daemon_ready_timeout");
        return;
      }
      const previousSockets = this.daemonRegistry.readyRoleSockets().filter((socket) => socket !== ws);
      const fallbackSocket = previousSockets.find((socket) => this.daemonRegistry.readyAttachment(socket)?.instanceId === daemonInstanceId);
      const reboundCallIds = [
        ...this.pending.rebindInstance(daemonInstanceId, ws),
        ...await this.durableCalls.rebind(daemonInstanceId, connectionId),
      ];
      if (reboundCallIds.length > 0) {
        this.observability.event("info", "daemon.calls.rebound", { rebound_calls: reboundCallIds.length });
      }
      try {
        ws.send(JSON.stringify({ type: "resume_calls", ids: reboundCallIds }));
        ws.send(JSON.stringify({ type: "ready_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        await this.invalidateDaemonSocket(ws, "daemon readiness acknowledgement failed", "daemon ready timeout", "daemon_ready_timeout");
        if (fallbackSocket?.readyState === WebSocket.OPEN) {
          this.pending.rebindInstance(daemonInstanceId, fallbackSocket);
          const fallbackConnectionId = this.daemonRegistry.readyAttachment(fallbackSocket)?.connectionId ?? "";
          if (fallbackConnectionId) await this.durableCalls.rebind(daemonInstanceId, fallbackConnectionId);
        }
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
    const outcome: PendingCallOutcome = body.ok === false
      ? { ok: false, error: daemonToolError(body.error) }
      : { ok: true, value: body.result };
    let matched = outcome.ok
      ? await this.pending.resolve(body.id, ws, outcome.value)
      : await this.pending.reject(body.id, outcome.error, ws);
    let acknowledge = Boolean(matched);
    if (!matched && socketAttachment.connectionId) {
      const settlement = await this.durableCalls.settle(body.id, socketAttachment.connectionId, outcome);
      matched = settlement === "committed";
      acknowledge = settlement !== "stale";
    }
    if (acknowledge) trySendWebSocket(ws, { type: "tool_result_ack", id: body.id });
    if (!matched) this.observability.unmatchedResult();
    else await this.scheduleRuntimeAlarm();
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
    const originRejection = mcpOriginRejection(request, base, this.env.MBM_ALLOWED_ORIGINS ?? "");
    if (originRejection) return originRejection;
    const headerVersion = request.headers.get("MCP-Protocol-Version")?.trim() ?? "";
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "mcp endpoint expects POST, or legacy GET" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "GET, POST", "cache-control": "no-store" },
      });
    }
    if (request.method === "GET" && headerVersion === MCP_MODERN_PROTOCOL_VERSION) {
      return methodNotAllowed("POST");
    }

    const proxyMode = mcpStreamProxyMode(request);
    const subscribed = await handleMcpStreamSubscribeRequest(request, this.streamChannel, this.resumption);
    if (subscribed) return subscribed;
    const modernControl = await this.modernMcp.handleControl(request, proxyMode);
    if (modernControl) return modernControl;

    const access = await authorizeMcpRequest({
      request,
      base,
      oauth: this.oauth,
      storage: this.ctx.storage,
      bodyLimitBytes: workerBodyLimitBytes(this.env.MBM_WORKER_MAX_BODY_BYTES),
      internalDpopRetryId: proxyMode === "prepare" ? mcpStreamProxyRetryId(request) : "",
    });
    if (access.response) return access.response;
    if (request.method === "GET") {
      if (proxyMode !== "prepare") return json({ error: "stream_proxy_required" }, 500);
      return await handleMcpResumptionRequest({
        request,
        authorized: access.authorized,
        identityKey: this.oauth.identityKey(),
        supportedVersions: MCP_LEGACY_PROTOCOL_VERSIONS,
        resumption: this.resumption,
      });
    }

    const body = await parseJsonRequest(request, workerBodyLimitBytes(this.env.MBM_WORKER_MAX_BODY_BYTES));
    if (isJsonRpcResponse(body)) {
      return headerVersion === MCP_MODERN_PROTOCOL_VERSION
        ? json(rpcError(null, -32600, "Clients must not send JSON-RPC responses"), 400)
        : new Response(null, { status: 202 });
    }
    if (!isJsonRpcRequest(body)) return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);

    if (detectHttpMcpEra(request, body) === "modern") {
      try {
        const context = validateModernHttpRequest({ request, body, tools: this.allTools(access.authorized.role) as Array<{ name: string; inputSchema?: unknown }> });
        return await this.modernMcp.handleRequest({
          request, body, base, authorized: access.authorized,
          protocolVersion: context.version, proxyMode,
        });
      } catch (error) {
        if (error instanceof McpHttpContractError) {
          return json(rpcError(body.id, error.code, error.message, error.data), error.status);
        }
        throw error;
      }
    }

    const protocolError = validateProtocolVersionHeader(request, body, MCP_LEGACY_PROTOCOL_VERSIONS);
    if (protocolError) return json(protocolError, 400);
    const session = await resolveMcpSession(request, body.method, this.oauth.identityKey(), access.authorized.tokenKey);
    if (session.kind === "invalid") return json(rpcError(body.id, -32001, "MCP session not found"), 404);
    const sessionId = session.kind === "active" ? session.sessionId : "";

    if (body.method === "tools/call" && acceptsEventStream(request)) {
      return await this.handleLegacyStreamedToolCall(body, base, access.authorized, sessionId, proxyMode);
    }
    const response = await this.legacyMcp.dispatch(body, base, access.authorized, sessionId);
    if (response === null) return new Response(null, { status: 202 });
    return session.kind === "initialize" ? json(response, 200, { "mcp-session-id": session.sessionId }) : json(response);
  }

  private async handleLegacyStreamedToolCall(
    body: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    sessionId: string,
    proxyMode: ReturnType<typeof mcpStreamProxyMode>,
  ): Promise<Response> {
    return prepareLegacyStreamedToolCall(
      { body, authorized, sessionId, proxyMode },
      {
        advertisedTools: this.allTools(authorized.role),
        resumption: this.resumption,
        observability: this.observability,
        admission: this.pendingAdmission,
        serverInfo: () => this.serverInfoResult(base, authorized),
        dispatchWorkspaceCall: (input) => this.dispatchLegacyWorkspaceStreamCall(input),
      },
    );
  }

  private async dispatchLegacyWorkspaceStreamCall(input: LegacyWorkspaceStreamCallInput): Promise<void> {
    const { name, args, authorized } = input;
    if (!workspaceTools.some((tool) => tool.name === name)) throw new Error("unknown tool");
    if (!accountRoleAllowsTool(authorized.role, name)) {
      throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
    }
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readySockets()[0];
    if (!socket) throw new WorkerToolError("unavailable", "local daemon is not connected; keep the CLI start command running", true);
    const attachment = this.daemonRegistry.readyAttachment(socket);
    const daemonInstanceId = attachment?.instanceId ?? "";
    const connectionId = attachment?.connectionId ?? "";
    if (!daemonInstanceId || !connectionId) {
      throw new WorkerToolError("unavailable", "local daemon connection is missing its relay identity", true);
    }
    if (!attachment?.tools?.includes(name)) {
      throw new WorkerToolError("authorization_denied", `tool disabled by local daemon policy: ${name}`);
    }
    const timeoutBudget = daemonToolTimeoutBudget(name, args);
    await startEventDrivenStreamCall({
      resumption: this.resumption,
      observability: this.observability,
      streamId: input.streamId,
      requestId: input.requestId,
      clientRequestKey: input.requestKey,
      requestFingerprint: input.requestKey ? input.requestFingerprint : undefined,
      tool: name,
      arguments: args,
      socket,
      daemonInstanceId,
      connectionId,
      executionTimeoutMs: timeoutBudget.executionTimeoutMs,
      settlementTimeoutMs: timeoutBudget.settlementTimeoutMs,
      transientSnapshot: this.pending.snapshot(),
      maximumPendingCalls: MAX_PENDING_CALLS,
      reservedPendingCalls: RESERVED_CONTROL_PENDING_CALLS,
      authorization: {
        account_id: authorized.accountId,
        account_version: authorized.accountVersion,
        client_id: authorized.clientId,
        family_id: authorized.familyId,
        role: authorized.role,
      },
      transform: name === "project_overview" ? {
        kind: "project_overview",
        account_id: authorized.accountId,
        account_version: authorized.accountVersion,
        role: authorized.role,
      } : undefined,
      onSendFailure: () => this.invalidateDaemonSocket(socket, "failed to send daemon tool call", "daemon send failed"),
    });
    await this.scheduleRuntimeAlarm();
  }

  private async serverInfoResult(base: string, authorized: AuthorizedToken): Promise<Record<string, unknown>> {
    const { daemon, effectiveTools, advertisedTools, authorization } = this.authorityContext(authorized);
    return buildServerInfoResult({
      serverName: SERVER_NAME, serverVersion: SERVER_VERSION, base,
      oauth: authorizationServerMetadata(base, SERVER_NAME), authorization, daemon,
      effectiveTools, advertisedTools, pendingSnapshot: await this.durableCalls.snapshot(this.pending.snapshot()),
      daemonRegistry: this.daemonRegistry, observability: this.observability,
    });
  }
  private assertWorkerToolArguments(name: string, args: unknown): void {
    const validation = validateWorkerToolArguments(name, args);
    if (!validation.known) throw new WorkerToolError("not_found", "unknown tool");
    if (!validation.valid) {
      try { daemonToolTimeoutBudget(name, asObject(args)); }
      catch (error) { if (error instanceof WorkerToolError) throw error; }
      throw new WorkerToolError(
        "invalid_request",
        "tool arguments do not match the input schema",
        false,
        { tool: name, validation_issues: [...validation.issues] },
      );
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    base: string,
    authorized: AuthorizedToken,
    requestKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertWorkerToolArguments(name, args);
    if (name === "server_info") return this.serverInfoResult(base, authorized);
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!accountRoleAllowsTool(authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
      const result = await this.callDaemonTool(name, args, authorized, requestKey, signal);
      return name === "project_overview" ? decorateProjectOverview(result, { accountId: authorized.accountId,
        accountVersion: authorized.accountVersion, role: authorized.role }) : result;
    }
    throw new Error("unknown tool");
  }
  private async callDaemonTool(
    name: string,
    args: Record<string, unknown>,
    authorized: AuthorizedToken,
    requestKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readySockets()[0];
    if (!socket) throw new WorkerToolError("unavailable", "local daemon is not connected; keep the CLI start command running", true);
    const daemonAttachment = this.daemonRegistry.readyAttachment(socket);
    const daemonInstanceId = daemonAttachment?.instanceId ?? "";
    if (!daemonInstanceId) throw new WorkerToolError("unavailable", "local daemon connection is missing its instance identity", true);
    if (!daemonAttachment?.tools?.includes(name)) throw new WorkerToolError("authorization_denied", `tool disabled by local daemon policy: ${name}`);
    const id = randomToken("call");
    const timeoutBudget = daemonToolTimeoutBudget(name, args);
    let result!: Promise<unknown>;
    try {
      await this.pendingAdmission.run(async () => {
        assertWorkerPendingCallAdmission(this.pending.snapshot(), await this.resumption.calls.snapshot(MAX_PENDING_CALLS), name);
        result = this.pending.register({
          id,
          socket,
          daemonInstanceId,
          clientRequestKey: requestKey,
          tool: name,
          timeoutMs: timeoutBudget.settlementTimeoutMs,
          onTimeout: (record) => this.daemonCallTimeout(record, name),
          signal,
          onAbort: (record) => this.daemonCallCancellation(record),
        });
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
          type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutBudget.executionTimeoutMs,
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
    return new WorkerToolError("timeout", `daemon tool timed out: ${name}`, true);
  }
  private daemonCallCancellation(record: import("./pending-call-contract.ts").PendingCallRecord): Error {
    if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
    return new WorkerToolError("cancelled", "tool call cancelled when its HTTP response stream closed");
  }

  private async cancelClientRequest(requestKey?: string): Promise<void> {
    if (!requestKey) return;
    const cancelledTransient = await this.pending.cancelRequest(requestKey, (record) => {
      if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
      return new WorkerToolError("cancelled", "tool call cancelled by client");
    });
    if (cancelledTransient) {
      await this.scheduleRuntimeAlarm();
      return;
    }
    if (await this.durableCalls.cancel(requestKey)) await this.scheduleRuntimeAlarm();
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
    this.daemonRegistry.beginCandidate(server, challenge, preflight, randomToken("connection"));
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
    const advertised = accountRoleToolNames(role, workspaceTools.map((tool) => tool.name));
    const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
    return [serverInfoTool, ...localTools].map((tool) => structuredClone(tool));
  }
  private effectiveToolNames(role: AccountRole): string[] {
    return ["server_info", ...accountRoleToolNames(role, this.daemonAdvertisedTools())];
  }
  private authorityContext(authorized: AuthorizedToken) {
    const daemon = describeDaemonCeiling(this.daemonStatus(true));
    const advertisedTools = this.allTools(authorized.role).map((tool) => String(tool.name));
    const effectiveTools = this.effectiveToolNames(authorized.role);
    const authorization = accountAuthoritySnapshot({ accountId: authorized.accountId, accountVersion: authorized.accountVersion,
      role: authorized.role, daemonPolicy: daemon.policy, effectiveTools });
    return { daemon, effectiveTools, advertisedTools, authorization };
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
    closeWebSocketQuietly(ws, daemonErrorCloseCode(errorCode), closeReason);
    await cleanup;
  }

  private async detachDaemonSocketCalls(ws: WebSocket, message: string): Promise<number> {
    const attachment = this.daemonRegistry.attachment(ws);
    if (!attachment?.instanceId || !attachment.connectionId) {
      return await this.pending.rejectSocket(ws, () => new WorkerToolError("unavailable", message, true));
    }
    const transient = this.pending.detachSocket(
      ws,
      DAEMON_RECONNECT_GRACE_MS,
      () => new WorkerToolError("unavailable", `${message}; reconnect grace expired`, true),
    );
    const durable = await this.durableCalls.detach(attachment.connectionId, DAEMON_RECONNECT_GRACE_MS);
    return transient + durable;
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

  private async expireOverdueCalls(): Promise<void> {
    await this.pending.expireDue();
    await this.durableCalls.expireDue();
  }

  private async scheduleRuntimeAlarm(): Promise<void> {
    await scheduleRuntimeAlarm(this.runtimeAlarmContext());
  }

  private runtimeAlarmContext() {
    return {
      storage: this.ctx.storage,
      pending: this.pending,
      durableCalls: this.resumption.calls,
      expireDurableCall: (call: import("./mcp-pending-call-store.ts").PendingStreamCallView) => this.durableCalls.expire(call),
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

}

export default {
  fetch: (request: Request, env: BridgeEnv, ctx: ExecutionContext) =>
    handleOuterWorkerFetch(request, env, ctx, { server: SERVER_NAME, version: SERVER_VERSION }),
} satisfies ExportedHandler<BridgeEnv>;

function daemonInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^daemon_[A-Za-z0-9_-]{16,96}$/.test(value)) return "";
  return value;
}
