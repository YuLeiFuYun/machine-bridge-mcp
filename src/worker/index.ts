import { DurableObject } from "cloudflare:workers";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { PendingCallRegistrationError } from "./pending-call-contract.ts";
import { PendingCallRegistry } from "./pending-calls.ts";
import { MAX_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS, assertWorkerPendingCallAdmission, pendingCapacityProjection } from "./pending-call-capacity.ts";
import { daemonLivenessDeadlineMs, isFreshDaemonCandidate } from "./daemon-liveness.ts";
import { DaemonRegistry } from "./daemon-registry.ts";
import type { DaemonChannel } from "./daemon-channel.ts";
import { trySendDaemonChannel } from "./daemon-channel.ts";
import { cancelReadyDaemonAuthority, notifyReadyDaemon, readyDaemonWaiterSnapshot } from "./daemon-ready-waiters.ts";
import { immediateReadyDaemonForDispatch, readyDaemonForDispatch } from "./daemon-ready-dispatch.ts";
import { daemonReconnectExpiry, daemonToolTimeoutBudgetAfterDelay } from "./daemon-recovery-budget.ts";
import { daemonStatusSnapshot } from "./daemon-status.ts";
import { sanitizeDaemonInstanceId } from "./daemon-socket-attachment.ts";
import { sanitizeDaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "./runtime-alarm.ts";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "./daemon-auth.ts";
import { handleDaemonHttpRelay } from "./daemon-http-controller.ts";
import { handleReadyDaemonMessage } from "./daemon-ready-messages.ts";
import { McpController } from "./mcp-controller.ts";
import { authorizeMcpRequest } from "./mcp-access.ts";
import { removedProtocolResponse } from "./mcp-removed-protocol.ts";
import { initializationCompatibilityResponse } from "./mcp-initialization-compat.ts";
import { mcpStreamProxyMode } from "./mcp-stream-proxy-contract.ts";
import { buildServerInfoResult, serverInfoDetail } from "./server-info.ts";
import { handleOuterWorkerFetch } from "./worker-entry.ts";
import { daemonToolTimeoutBudget } from "./tool-timeout.ts";
import { daemonToolRecovery } from "./tool-call-recovery.ts";
import { WorkerObservability } from "./observability.ts";
import { readWorkerContinuityEvidence, recordWorkerClientCancellation, recordWorkerSocketDisconnect } from "./worker-continuity-evidence.ts";
import { dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError, dispatchedDaemonTimeoutError, publicWorkerToolError, revokedDaemonAuthorityError, WorkerToolError } from "./errors.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { accountRoleAllowsTool } from "./access.ts";
import type { AuthorizedToken } from "./access.ts";
import { OAuthController } from "./oauth-controller.ts";
import {
  authorityRevocations, authorityRevocationWireMessage,
} from "./authority-revocations.ts";
import { decorateProjectOverview } from "./authority.ts";
import { validateWorkerToolArguments, workerToolParameterHeaders, workspaceTools } from "./tool-catalog.ts";
import { workerAuthorityContext, workerToolsForRole } from "./worker-tool-authority.ts";
import { McpHttpContractError, httpHeaderContractError, validateHttpRequest } from "./mcp-http-contract.ts";
import { randomToken } from "./oauth-state.ts";
import {
  HttpError, applyCors, baseUrl, corsPreflight, discardRequestBody, json, mcpOriginRejection, methodNotAllowed,
  parseJsonRequest, workerErrorClass,
} from "./http.ts";
import { authorizationServerMetadata } from "./worker-metadata.ts";
import { workerBodyLimitBytes, type BridgeEnv } from "./worker-runtime-config.ts";
import { retainWorkerTask } from "./worker-task-lifetime.ts";
import { statefulRouteClass } from "./worker-rate-limit-key.ts";
import {
  MCP_DISCOVERY_TTL_MS, MCP_INSTRUCTIONS, MCP_PROTOCOL_VERSIONS,
  MCP_LEGACY_SERVER_CAPABILITIES, MCP_SERVER_CAPABILITIES, MCP_TOOL_LIST_TTL_MS, SERVER_NAME, mcpServerInfo,
} from "./worker-mcp-config.ts";
import { projectOverviewDetail, projectProjectOverview } from "../shared/project-overview-projection.mjs";
import { asObject, isJsonRpcRequest, isJsonRpcResponse, rpcError } from "./mcp-jsonrpc.ts";
import { managedJobReadArgumentsWithinExecutionBudget, managedJobReadExecutionBudgetHasHeadroom } from "./managed-job-read-timeout.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "./websocket-protocol.ts";
const SERVER_VERSION = "3.0.0-beta.143";
const MCP_SERVER_INFO = mcpServerInfo(SERVER_VERSION);
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_RECONNECT_GRACE_MS = relayContract.reconnectGraceMs; const NEW_CALL_RECONNECT_GRACE_MS = relayContract.newCallReconnectGraceMs;
export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS);
  private readonly observability = new WorkerObservability();
  private readonly oauth: OAuthController;
  private readonly daemonRegistry: DaemonRegistry;
  private readonly mcp: McpController;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.oauth = new OAuthController(
      ctx, env, SERVER_NAME, SERVER_VERSION,
      (event) => this.observability.oauthRefreshEvent(event),
    );
    this.daemonRegistry = new DaemonRegistry(ctx);
    this.mcp = new McpController({
      capabilities: MCP_SERVER_CAPABILITIES,
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
      supportedVersions: MCP_PROTOCOL_VERSIONS,
      discoveryTtlMs: MCP_DISCOVERY_TTL_MS,
      toolListTtlMs: MCP_TOOL_LIST_TTL_MS,
      tools: (authorized) => workerToolsForRole(authorized.role),
      recordError: (code) => this.observability.recordError(code),
      cancelClientRequest: (requestKey) => this.cancelClientRequest(requestKey),
      callTool: ({ name, args, base, authorized, signal, requestKey }) => this.callTool(
        name, args, base, authorized, requestKey, signal,
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
      if (url.pathname === "/admin/accounts") return await this.afterAuthorityMutation(this.oauth.handleAccountAdmin(request, "accounts"));
      if (url.pathname === "/admin/accounts/rotate-password") return await this.afterAuthorityMutation(this.oauth.handleAccountAdmin(request, "rotate-password"));
      if (url.pathname === "/admin/clients") return await this.afterAuthorityMutation(this.oauth.handleClientAdmin(request));
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
        return await this.afterAuthorityMutation(this.oauth.exchangeToken(request, base));
      }
      if (url.pathname === "/daemon/ws") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await this.acceptDaemonWebSocket(request);
      }
      if (url.pathname === "/daemon/http") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await this.acceptDaemonHttp(request);
      }
      if (url.pathname === "/mcp") return await this.handleMcp(request, base);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
      this.observability.event("error", "http.request.failed", { route: statefulRouteClass(url.pathname), error_class: workerErrorClass(error) });
      return json({ error: "internal_server_error" }, 500);
    }
  }

  private async afterAuthorityMutation(response: Promise<Response>): Promise<Response> {
    const settled = await response;
    await this.flushAuthorityRevocations();
    return settled;
  }

  private async flushAuthorityRevocations(): Promise<void> {
    let queued;
    try { queued = await authorityRevocations(this.ctx.storage); }
    catch (error) {
      this.observability.event("error", "authority.revocation.load_failed", { error_class: workerErrorClass(error) });
      return;
    }
    if (queued.length === 0) return;
    let cancelledWaiters = 0;
    let cancelledPending = 0;
    let cancelledSubscriptions = 0;
    for (const record of queued) {
      const revocation = {
        accountId: record.account_id, accountVersion: record.account_version,
        clientId: record.client_id, familyId: record.family_id,
      };
      cancelledWaiters += cancelReadyDaemonAuthority(this.daemonRegistry, revocation);
      cancelledPending += await this.pending.cancelAuthority(revocation, () => revokedDaemonAuthorityError());
      cancelledSubscriptions += this.mcp.cancelAuthority(revocation);
    }
    if (cancelledWaiters > 0) {
      this.observability.event("info", "authority.revocation.pre_dispatch_waiters_cancelled", { waiters: cancelledWaiters });
    }
    if (cancelledPending > 0) {
      this.observability.event("info", "authority.revocation.pending_calls_cancelled", { calls: cancelledPending });
    }
    if (cancelledSubscriptions > 0) {
      this.observability.event("info", "authority.revocation.subscriptions_cancelled", { subscriptions: cancelledSubscriptions });
    }
    for (const socket of this.daemonRegistry.readyChannels()) {
      for (const revocation of queued) {
        if (trySendDaemonChannel(socket, authorityRevocationWireMessage(revocation))) continue;
        await this.invalidateDaemonChannel(socket, "failed to deliver authority revocation", "daemon_transport_error");
        break;
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.expireOverdueCalls();
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
      const instanceId = sanitizeDaemonInstanceId(body.instance_id) ?? "";
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
        relayDiagnostics: sanitizeDaemonRelayDiagnostics(body.relay_diagnostics),
      });
      this.observability.socketAuthenticated();
      try {
        ws.send(JSON.stringify({ type: "hello_ack", server: SERVER_NAME, version: SERVER_VERSION }));
        ws.send(JSON.stringify({ type: "relay_probe", id: probeId }));
      } catch {
        await this.invalidateDaemonSocket(
          ws, "daemon readiness probe failed", "daemon readiness probe failed", "daemon_transport_error",
        );
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
      if (!this.touchDaemonSocket(ws)) return;
      if (!trySendWebSocket(ws, { type: "pong", ts: body.ts ?? Date.now() })) {
        await this.invalidateDaemonSocket(ws, "failed to acknowledge daemon heartbeat", "daemon pong failed", "daemon_transport_error");
        return;
      }
      await this.scheduleRuntimeAlarm();
      return;
    }

    if (socketAttachment.role === "probing") {
      if (body.type !== "relay_probe_result" || typeof body.id !== "string" || body.id !== socketAttachment.probeId) {
        rejectDaemonMessage(ws, "invalid_relay_probe_result", 1002, "invalid daemon readiness result");
        return;
      }
      const queuedRevocations = await authorityRevocations(this.ctx.storage);
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
      const previousHttpChannels = this.daemonRegistry.httpReadyChannels();
      const fallbackSocket = previousSockets.find((socket) => this.daemonRegistry.readyAttachment(socket)?.instanceId === daemonInstanceId);
      const fallbackHttp = previousHttpChannels.find((channel) => this.daemonRegistry.readyAttachment(channel)?.instanceId === daemonInstanceId);
      const reboundCallIds = this.pending.rebindInstance(daemonInstanceId, ws);
      if (reboundCallIds.length > 0) {
        this.observability.event("info", "daemon.calls.rebound", { rebound_calls: reboundCallIds.length });
      }
      try {
        ws.send(JSON.stringify({ type: "resume_calls", ids: reboundCallIds }));
        for (const revocation of queuedRevocations) ws.send(JSON.stringify(authorityRevocationWireMessage(revocation)));
        ws.send(JSON.stringify({ type: "ready_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        await this.invalidateDaemonSocket(ws, "daemon readiness acknowledgement failed", "daemon ready timeout", "daemon_ready_timeout");
        if (fallbackSocket?.readyState === WebSocket.OPEN) {
          this.pending.rebindInstance(daemonInstanceId, fallbackSocket);
        } else if (fallbackHttp?.readyState === 1) {
          this.pending.rebindInstance(daemonInstanceId, fallbackHttp);
        }
        await this.scheduleRuntimeAlarm();
        return;
      }
      this.observability.socketReady();
      for (const previous of previousSockets) {
        const cleanup = this.cleanupDaemonSocket(previous, "daemon connection replaced after verified handover");
        closeWebSocketQuietly(previous, 1012, "replaced by verified daemon");
        if (cleanup) await cleanup.task;
      }
      for (const previous of previousHttpChannels) {
        await this.detachDaemonChannelCalls(previous, "HTTPS fallback replaced by verified WebSocket");
        this.daemonRegistry.http.close(previous);
      }
      await this.scheduleRuntimeAlarm();
      notifyReadyDaemon(this.daemonRegistry);
      return;
    }

    if (socketAttachment.role !== "daemon") {
      closeWebSocketQuietly(ws, 1008, "daemon readiness required");
      return;
    }

    if (!this.touchDaemonSocket(ws)) return;
    const handled = await handleReadyDaemonMessage({
      channel: ws, body, pending: this.pending, storage: this.ctx.storage, observability: this.observability,
      beginDrain: (channel) => this.daemonRegistry.beginDrain(channel),
    });
    if (!handled.ok) {
      rejectDaemonMessage(ws, handled.errorCode ?? "unknown_message_type", 1002, handled.errorMessage ?? "invalid daemon message");
      return;
    }
    await this.scheduleRuntimeAlarm();
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const planned = this.daemonRegistry.isDraining(ws);
    const cleanup = this.cleanupDaemonSocket(ws, "daemon disconnected");
    if (cleanup?.first) this.observability.event("info", "daemon.websocket.closed", {
      close_code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 0,
      was_clean: wasClean === true,
    });
    if (cleanup) {
      await cleanup.task;
      await recordWorkerSocketDisconnect(this.ctx.storage, { planned, kind: "close", closeCode: code, wasClean });
      await this.scheduleRuntimeAlarm();
    }
  }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const planned = this.daemonRegistry.isDraining(ws);
    const cleanup = this.cleanupDaemonSocket(ws, "daemon transport error");
    if (!cleanup) return;
    if (cleanup.first) this.observability.event("warn", "daemon.websocket.error", { error_class: workerErrorClass(error) });
    await cleanup.task;
    await recordWorkerSocketDisconnect(this.ctx.storage, { planned, kind: "error" });
    await this.scheduleRuntimeAlarm();
  }
  private cleanupDaemonSocket(ws: WebSocket, message: string) {
    const cleanup = this.daemonRegistry.beginCleanup(ws, (attachment) => this.detachDaemonSocketCalls(ws, message, attachment));
    if (cleanup?.first) this.observability.socketDisconnected();
    return cleanup;
  }
  private async handleMcp(request: Request, base: string): Promise<Response> {
    const originRejection = mcpOriginRejection(request, base, this.env.MBM_ALLOWED_ORIGINS ?? "");
    if (originRejection) return originRejection;
    if (request.method !== "POST") return methodNotAllowed("POST");

    const proxyMode = mcpStreamProxyMode(request);
    const control = await this.mcp.handleControl(request, proxyMode);
    if (control) return control;

    const access = await authorizeMcpRequest({
      request,
      base,
      oauth: this.oauth,
      storage: this.ctx.storage,
      bodyLimitBytes: workerBodyLimitBytes(this.env.MBM_WORKER_MAX_BODY_BYTES),
      requiredScope: SERVER_NAME,
    });
    if (access.response) return access.response;

    const headerContractError = httpHeaderContractError(request);
    if (headerContractError) {
      await discardRequestBody(request, workerBodyLimitBytes(this.env.MBM_WORKER_MAX_BODY_BYTES));
      return json(rpcError(null, headerContractError.code, headerContractError.message, headerContractError.data), headerContractError.status);
    }
    const body = await parseJsonRequest(request, workerBodyLimitBytes(this.env.MBM_WORKER_MAX_BODY_BYTES));
    if (isJsonRpcResponse(body)) return json(rpcError(null, -32600, "Clients must not send JSON-RPC responses"), 400);
    if (!isJsonRpcRequest(body)) return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);
    try {
      const compatibility = await initializationCompatibilityResponse({
        request, body, base, authorized: access.authorized, controller: this.mcp,
        capabilities: MCP_LEGACY_SERVER_CAPABILITIES, serverInfo: MCP_SERVER_INFO, instructions: MCP_INSTRUCTIONS,
        tools: workerToolsForRole(access.authorized.role) as Array<{ name: string; inputSchema?: unknown }>,
      });
      if (compatibility) return compatibility;
      const removed = removedProtocolResponse(request, body, MCP_PROTOCOL_VERSIONS);
      if (removed) return removed;
      validateHttpRequest({
        request,
        body,
        tools: workerToolsForRole(access.authorized.role) as Array<{ name: string; inputSchema?: unknown }>,
      });
      return await this.mcp.handleRequest({ request, body, base, authorized: access.authorized, proxyMode });
    } catch (error) {
      if (error instanceof McpHttpContractError) {
        return json(rpcError(body.id, error.code, error.message, error.data), error.status);
      }
      throw error;
    }
  }

  private async serverInfoResult(base: string, authorized: AuthorizedToken, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { daemon, effectiveTools, advertisedTools, authorization } = this.authorityContext(authorized);
    const pendingSnapshot = pendingCapacityProjection(this.pending.snapshot(), readyDaemonWaiterSnapshot(this.daemonRegistry));
    return buildServerInfoResult({
      serverName: SERVER_NAME, serverVersion: SERVER_VERSION, base,
      oauth: authorizationServerMetadata(base, SERVER_NAME), authorization, daemon,
      effectiveTools, advertisedTools, pendingSnapshot,
      toolListSubscription: this.mcp.toolListSubscriptionSnapshot(authorized.accountId),
      daemonRegistry: this.daemonRegistry, observability: this.observability,
      continuityEvidence: authorization.account_role_is_owner === true ? await readWorkerContinuityEvidence(this.ctx.storage) : undefined,
    }, serverInfoDetail(args));
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
    if (name === "server_info") return this.serverInfoResult(base, authorized, args);
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!accountRoleAllowsTool(authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
      const overviewDetail = name === "project_overview" ? projectOverviewDetail(args) : "full";
      const daemonArgs = name === "project_overview" ? {} : args;
      const result = await this.callDaemonTool(name, daemonArgs, authorized, requestKey, signal);
      return name === "project_overview" ? projectProjectOverview(decorateProjectOverview(result, { accountId: authorized.accountId,
        accountVersion: authorized.accountVersion, role: authorized.role }), overviewDetail) : result;
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
    const timeoutBudget = daemonToolTimeoutBudget(name, args);
    const ready = immediateReadyDaemonForDispatch(this.daemonRegistry) ?? await readyDaemonForDispatch(this.daemonRegistry, {
      graceMs: Math.min(NEW_CALL_RECONNECT_GRACE_MS, timeoutBudget.executionTimeoutMs),
      signal,
      tool: name,
      pending: this.pending.snapshot(),
      authority: {
        accountId: authorized.accountId,
        accountVersion: authorized.accountVersion,
        clientId: authorized.clientId,
        familyId: authorized.familyId,
      },
      activeReadJobCallsForAccount: this.pending.readJobCallsForAccount(authorized.accountId),
    });
    const socket = ready.socket;
    const dispatchBudget = daemonToolTimeoutBudgetAfterDelay(timeoutBudget, ready.recoveryDelayMs);
    if (name === "read_job" && !managedJobReadExecutionBudgetHasHeadroom(dispatchBudget.executionTimeoutMs)) {
      throw new WorkerToolError("unavailable", "local daemon recovery left insufficient managed-job read execution headroom; retry the call",
        true, { side_effects_started: false });
    }
    const daemonArgs = name === "read_job"
      ? managedJobReadArgumentsWithinExecutionBudget(args, dispatchBudget.executionTimeoutMs)
      : args;
    const daemonAttachment = this.daemonRegistry.readyAttachment(socket);
    const daemonInstanceId = daemonAttachment?.instanceId ?? "";
    if (!daemonInstanceId) throw new WorkerToolError("unavailable", "local daemon connection is missing its instance identity", true);
    if (!daemonAttachment?.tools?.includes(name)) throw new WorkerToolError("authorization_denied", `tool disabled by local daemon policy: ${name}`);
    const id = randomToken("call");
    const recovery = daemonToolRecovery(name, args);
    let result!: Promise<unknown>; let sent = false;
    try {
      if (signal?.aborted) {
        throw new WorkerToolError("cancelled", "tool call cancelled before daemon dispatch", false, { side_effects_started: false });
      }
      assertWorkerPendingCallAdmission(this.pending.snapshot(), name);
      result = this.pending.register({
        id,
        socket,
        daemonInstanceId,
        clientRequestKey: requestKey,
        authority: {
          accountId: authorized.accountId, accountVersion: authorized.accountVersion,
          clientId: authorized.clientId, familyId: authorized.familyId,
        },
        tool: name,
        ...(recovery ? { recovery } : {}),
        timeoutMs: dispatchBudget.settlementTimeoutMs,
        onTimeout: (record) => this.daemonCallTimeout(record, name),
        redeliverAfterProvenMissing: (record, channel) => {
          const remainingExecutionMs = Math.min(dispatchBudget.executionTimeoutMs,
            Math.floor(record.startedAt + dispatchBudget.executionTimeoutMs - performance.now()));
          if (remainingExecutionMs < 1_000) return false;
          if (name === "read_job" && !managedJobReadExecutionBudgetHasHeadroom(remainingExecutionMs)) return false;
          const redeliveryArgs = name === "read_job"
            ? managedJobReadArgumentsWithinExecutionBudget(args, remainingExecutionMs)
            : args;
          return trySendDaemonChannel(channel, {
            type: "tool_call", id: record.id, tool: name, arguments: redeliveryArgs, timeout_ms: remainingExecutionMs,
            authorization: {
              account_id: authorized.accountId, account_version: authorized.accountVersion,
              client_id: authorized.clientId, family_id: authorized.familyId, role: authorized.role,
            },
          });
        },
        signal,
        onAbort: (record) => this.daemonCallCancellation(record),
      });
      try {
        sent = trySendDaemonChannel(socket, {
          type: "tool_call", id, tool: name, arguments: daemonArgs, timeout_ms: dispatchBudget.executionTimeoutMs,
          authorization: {
            account_id: authorized.accountId, account_version: authorized.accountVersion,
            client_id: authorized.clientId, family_id: authorized.familyId, role: authorized.role,
          },
        });
      } catch { sent = false; }
    } catch (error) {
      if (error instanceof PendingCallRegistrationError) {
        throw new WorkerToolError(error.code, error.message, error.retryable);
      }
      throw error;
    }
    if (!sent) {
      await this.pending.reject(id, new WorkerToolError("network_error", "failed to send daemon tool call", true), socket);
      await this.invalidateDaemonChannel(socket, "failed to send daemon tool call", "daemon_transport_error");
    }
    await this.scheduleRuntimeAlarm();
    this.observability.callStarted(name);
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
    const terminationRequested = Boolean(record.socket && trySendDaemonChannel(record.socket, { type: "cancel_call", id: record.id }));
    return dispatchedDaemonTimeoutError(name, terminationRequested, record.recovery);
  }
  private daemonCallCancellation(record: import("./pending-call-contract.ts").PendingCallRecord): Error {
    const terminationRequested = Boolean(record.socket && trySendDaemonChannel(record.socket, { type: "cancel_call", id: record.id }));
    this.ctx.waitUntil(recordWorkerClientCancellation(this.ctx.storage, "request_abort"));
    return dispatchedDaemonCancellationError("tool call cancelled when its HTTP response stream closed", terminationRequested, record.recovery);
  }

  private async cancelClientRequest(requestKey?: string): Promise<void> {
    if (!requestKey) return;
    const cancelledTransient = await this.pending.cancelRequest(requestKey, (record) => {
      const terminationRequested = Boolean(record.socket && trySendDaemonChannel(record.socket, { type: "cancel_call", id: record.id }));
      return dispatchedDaemonCancellationError("tool call cancelled by client", terminationRequested, record.recovery);
    });
    if (cancelledTransient) {
      this.ctx.waitUntil(recordWorkerClientCancellation(this.ctx.storage, "stream_cancel_control"));
      await this.scheduleRuntimeAlarm();
      return;
    }
  }
  private async acceptDaemonHttp(request: Request): Promise<Response> {
    if (!this.env.DAEMON_DEVICE_PUBLIC_KEY) return json({ error: "daemon_device_identity_not_configured" }, 503);
    return handleDaemonHttpRelay({
      request, storage: this.ctx.storage, registry: this.daemonRegistry, pending: this.pending,
      observability: this.observability, publicKeyJson: this.env.DAEMON_DEVICE_PUBLIC_KEY,
      server: SERVER_NAME, version: SERVER_VERSION,
      scheduleAlarm: () => this.scheduleRuntimeAlarm(),
      detachChannel: async (channel, message) => { await this.detachDaemonChannelCalls(channel, message); },
      retireWebSocket: async (socket, message) => {
        const cleanup = this.cleanupDaemonSocket(socket, message);
        closeWebSocketQuietly(socket, 1012, "HTTPS fallback handover");
        if (cleanup) await cleanup.task;
      },
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

    const connectionId = randomToken("connection");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.observability.socketCandidate();
    this.daemonRegistry.beginCandidate(server, challenge, preflight, connectionId);
    await this.scheduleRuntimeAlarm();
    const welcomed = trySendWebSocket(server, {
      type: "welcome",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      connection_id: connectionId,
      worker_origin: workerOrigin,
      authentication: {
        scheme: challenge.scheme,
        challenge: challenge.challenge,
        issued_at: challenge.issuedAt,
        expires_at: challenge.expiresAt,
      },
    });
    if (!welcomed) {
      await this.invalidateDaemonSocket(server, "daemon welcome failed", "daemon welcome failed", "daemon_transport_error");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private authorityContext(authorized: AuthorizedToken) {
    return workerAuthorityContext({
      authorized, daemonStatus: this.daemonStatus(true), daemonTools: this.daemonAdvertisedTools(),
    });
  }
  private daemonAdvertisedTools(): Set<string> {
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readyChannels()[0];
    if (!socket) return new Set();
    const attachment = this.daemonRegistry.readyAttachment(socket);
    if (!attachment?.tools) return new Set();
    return new Set(attachment.tools);
  }

  private touchDaemonSocket(ws: WebSocket): boolean { return Boolean(this.daemonRegistry.touch(ws)); }
  private async invalidateDaemonSocket(
    ws: WebSocket, message: string, closeReason: string,
    errorCode = "daemon_liveness_timeout", scheduleAlarm = true,
  ): Promise<void> {
    const cleanup = this.cleanupDaemonSocket(ws, message);
    sendWebSocketQuietly(ws, { type: "error", error: errorCode });
    closeWebSocketQuietly(ws, daemonErrorCloseCode(errorCode), closeReason);
    if (cleanup) { await cleanup.task; if (scheduleAlarm) await this.scheduleRuntimeAlarm(); }
  }

  private async detachDaemonSocketCalls(
    ws: WebSocket, message: string, attachment = this.daemonRegistry.attachment(ws),
  ): Promise<number> {
    return this.detachDaemonChannelCalls(ws, message, attachment);
  }

  private async detachDaemonChannelCalls(
    socket: DaemonChannel, message: string, attachment = this.daemonRegistry.readyAttachment(socket),
  ): Promise<number> {
    if (!attachment?.instanceId) {
      return await this.pending.rejectSocket(socket, (record) => dispatchedDaemonDisconnectError(message, record.recovery));
    }
    return this.pending.detachSocket(
      socket,
      DAEMON_RECONNECT_GRACE_MS,
      (record) => {
        const expiry = daemonReconnectExpiry(record, DAEMON_RECONNECT_GRACE_MS);
        return dispatchedDaemonDisconnectError(`${message}; ${expiry.message}`, record.recovery, expiry.reason);
      },
    );
  }

  private async invalidateDaemonChannel(
    socket: DaemonChannel, message: string, errorCode = "daemon_transport_error", reschedule = true,
  ): Promise<void> {
    if (socket.daemonTransport !== "https") {
      await this.invalidateDaemonSocket(socket as WebSocket, message, "daemon transport failed", errorCode);
      return;
    }
    this.daemonRegistry.rememberDisconnected(socket);
    await this.detachDaemonChannelCalls(socket, message);
    this.daemonRegistry.http.close(socket as import("./daemon-http-channel.ts").DaemonHttpChannel);
    this.observability.event("warn", "daemon.https_fallback.disconnected", { error_class: errorCode });
    if (reschedule) await this.scheduleRuntimeAlarm();
  }

  private reclaimStaleDaemonSockets(now = Date.now()): void {
    for (const socket of this.daemonRegistry.readyRoleSockets()) {
      const deadline = daemonLivenessDeadlineMs(this.daemonRegistry.readyAttachment(socket));
      if (Number.isFinite(deadline) && deadline > now) continue;
      retainWorkerTask(this.ctx,
        this.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout"),
        (error) => this.observability.event("error", "daemon.socket.cleanup.failed",
          { error_class: workerErrorClass(error) }));
    }
    for (const channel of this.daemonRegistry.http.staleReady(now)) {
      retainWorkerTask(this.ctx,
        this.invalidateDaemonChannel(channel, "HTTPS fallback became unresponsive", "daemon_liveness_timeout"),
        (error) => this.observability.event("error", "daemon.https_fallback.cleanup.failed",
          { error_class: workerErrorClass(error) }));
    }
  }

  async alarm(): Promise<void> {
    await processRuntimeAlarm(this.runtimeAlarmContext());
    await this.flushAuthorityRevocations();
  }

  private async expireOverdueCalls(): Promise<void> {
    await this.pending.expireDue();
  }

  private async scheduleRuntimeAlarm(): Promise<void> {
    await scheduleRuntimeAlarm(this.runtimeAlarmContext(), Date.now());
  }

  private runtimeAlarmContext() {
    return {
      storage: this.ctx.storage,
      pending: this.pending,
      daemonRegistry: this.daemonRegistry,
      invalidateDaemonSocket: (socket: WebSocket, message: string, closeReason: string, errorCode?: string) =>
        this.invalidateDaemonSocket(socket, message, closeReason, errorCode, false),
      invalidateDaemonChannel: (channel: DaemonChannel, message: string, errorCode?: string) =>
        this.invalidateDaemonChannel(channel, message, errorCode, false),
      onScheduleError: (error: unknown) => this.observability.event(
        "error", "runtime.alarm.schedule.failed", { error_class: workerErrorClass(error) },
      ),
      onAlarmMutation: (action: "set" | "delete" | "noop") => this.observability.runtimeAlarmMutation(action),
    };
  }

  private daemonStatus(detail: boolean): Record<string, unknown> {
    this.reclaimStaleDaemonSockets();
    return daemonStatusSnapshot(this.daemonRegistry, detail);
  }

}

export default {
  fetch: (request: Request, env: BridgeEnv, ctx: ExecutionContext) =>
    handleOuterWorkerFetch(request, env, ctx, { server: SERVER_NAME, version: SERVER_VERSION }),
} satisfies ExportedHandler<BridgeEnv>;
