import { DurableObject } from "cloudflare:workers";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { PendingCallRegistrationError } from "./pending-call-contract.ts";
import { PendingCallRegistry } from "./pending-calls.ts";
import { MAX_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS, assertWorkerPendingCallAdmission, pendingCapacityProjection } from "./pending-call-capacity.ts";
import { PendingAdmissionGate } from "./pending-admission.ts";
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import { daemonLivenessDeadlineMs, isFreshDaemonCandidate } from "./daemon-liveness.ts";
import { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { notifyReadyDaemon, readyDaemonWaiterSnapshot, waitForReadyDaemon } from "./daemon-ready-waiters.ts";
import { daemonToolTimeoutBudgetAfterDelay } from "./daemon-recovery-budget.ts";
import { daemonStatusSnapshot } from "./daemon-status.ts";
import { sanitizeDaemonInstanceId } from "./daemon-socket-attachment.ts";
import { sanitizeDaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "./runtime-alarm.ts";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "./daemon-auth.ts";
import { McpController } from "./mcp-controller.ts";
import { authorizeMcpRequest } from "./mcp-access.ts";
import { removedProtocolResponse } from "./mcp-removed-protocol.ts";
import { initializationCompatibilityResponse } from "./mcp-initialization-compat.ts";
import { mcpStreamProxyMode } from "./mcp-stream-proxy-contract.ts";
import { buildServerInfoResult, serverInfoDetail } from "./server-info.ts";
import { handleOuterWorkerFetch } from "./worker-entry.ts";
import { daemonToolTimeoutBudget } from "./tool-timeout.ts";
import { WorkerObservability } from "./observability.ts";
import { daemonToolError, dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError, dispatchedDaemonTimeoutError, publicWorkerToolError, revokedDaemonAuthorityError, WorkerToolError } from "./errors.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole } from "./access.ts";
import type { AuthorizedToken } from "./access.ts";
import { OAuthController } from "./oauth-controller.ts";
import {
  acknowledgeAuthorityRevocation, authorityRevocationAckId, authorityRevocations, authorityRevocationWireMessage,
} from "./authority-revocations.ts";
import { accountAuthoritySnapshot, decorateProjectOverview, describeDaemonCeiling } from "./authority.ts";
import { serverInfoTool, validateWorkerToolArguments, workerToolParameterHeaders, workspaceTools } from "./tool-catalog.ts";
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
  MCP_SERVER_CAPABILITIES, MCP_TOOL_LIST_TTL_MS, SERVER_NAME, mcpServerInfo,
} from "./worker-mcp-config.ts";
import { projectOverviewDetail, projectProjectOverview } from "../shared/project-overview-projection.mjs";
import { asObject, isJsonRpcRequest, isJsonRpcResponse, rpcError } from "./mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "./websocket-protocol.ts";
const SERVER_VERSION = "3.0.0-beta.67";
const MCP_SERVER_INFO = mcpServerInfo(SERVER_VERSION);
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_RECONNECT_GRACE_MS = relayContract.reconnectGraceMs; const NEW_CALL_RECONNECT_GRACE_MS = relayContract.newCallReconnectGraceMs;
export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS, WORKER_PENDING_REGISTRY_OPTIONS);
  private readonly observability = new WorkerObservability();
  private readonly oauth: OAuthController;
  private readonly daemonRegistry: DaemonSocketRegistry;
  private readonly pendingAdmission = new PendingAdmissionGate();
  private readonly mcp: McpController;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.oauth = new OAuthController(
      ctx, env, SERVER_NAME, SERVER_VERSION,
      (event) => this.observability.oauthRefreshEvent(event),
    );
    this.daemonRegistry = new DaemonSocketRegistry(ctx);
    this.mcp = new McpController({
      capabilities: MCP_SERVER_CAPABILITIES,
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
      supportedVersions: MCP_PROTOCOL_VERSIONS,
      discoveryTtlMs: MCP_DISCOVERY_TTL_MS,
      toolListTtlMs: MCP_TOOL_LIST_TTL_MS,
      tools: (authorized) => this.allTools(authorized.role),
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
    let cancelled = 0;
    for (const record of queued) {
      cancelled += await this.pending.cancelAuthority({
        accountId: record.account_id, accountVersion: record.account_version,
        clientId: record.client_id, familyId: record.family_id,
      }, () => revokedDaemonAuthorityError());
    }
    if (cancelled > 0) this.observability.event("info", "authority.revocation.pending_calls_cancelled", { calls: cancelled });
    for (const socket of this.daemonRegistry.readySockets()) {
      for (const revocation of queued) {
        if (trySendWebSocket(socket, authorityRevocationWireMessage(revocation))) continue;
        await this.invalidateDaemonSocket(socket, "failed to deliver authority revocation", "daemon authority revocation send failed", "daemon_transport_error");
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
      const fallbackSocket = previousSockets.find((socket) => this.daemonRegistry.readyAttachment(socket)?.instanceId === daemonInstanceId);
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
        }
        await this.scheduleRuntimeAlarm();
        return;
      }
      this.observability.socketReady();
      notifyReadyDaemon(this.daemonRegistry);
      for (const previous of previousSockets) {
        const cleanup = this.cleanupDaemonSocket(previous, "daemon connection replaced after verified handover");
        closeWebSocketQuietly(previous, 1012, "replaced by verified daemon");
        if (cleanup) await cleanup.task;
      }
      await this.scheduleRuntimeAlarm();
      return;
    }

    if (socketAttachment.role !== "daemon") {
      closeWebSocketQuietly(ws, 1008, "daemon readiness required");
      return;
    }

    if (body.type === "authority_revoke_ack") {
      const revocationId = authorityRevocationAckId(body.revocation_id);
      if (!revocationId) {
        rejectDaemonMessage(ws, "invalid_authority_revoke_ack", 1002, "invalid authority revocation acknowledgement");
        return;
      }
      if (!this.touchDaemonSocket(ws)) return;
      await acknowledgeAuthorityRevocation(this.ctx.storage, revocationId);
      await this.scheduleRuntimeAlarm();
      return;
    }

    if (body.type !== "tool_result" || typeof body.id !== "string") {
      rejectDaemonMessage(ws, "unknown_message_type", 1002, "unknown daemon message type");
      return;
    }

    if (!this.touchDaemonSocket(ws)) return;
    const outcome: PendingCallOutcome = body.ok === false
      ? { ok: false, error: daemonToolError(body.error) }
      : { ok: true, value: body.result };
    const ownership = this.pending.resultOwnership(body.id, ws);
    const transientMatched = ownership === "owned" && (outcome.ok
      ? await this.pending.resolve(body.id, ws, outcome.value)
      : await this.pending.reject(body.id, outcome.error, ws));
    if (transientMatched || ownership === "missing") trySendWebSocket(ws, { type: "tool_result_ack", id: body.id });
    this.observability.daemonTerminalResult(transientMatched ? "committed"
      : ownership === "missing" ? "owner_missing_acknowledged" : "stale_connection_rejected");
    await this.scheduleRuntimeAlarm();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const cleanup = this.cleanupDaemonSocket(ws, "daemon disconnected");
    if (cleanup) { await cleanup.task; await this.scheduleRuntimeAlarm(); }
  }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const cleanup = this.cleanupDaemonSocket(ws, "daemon transport error");
    if (!cleanup) return;
    if (cleanup.first) this.observability.event("warn", "daemon.websocket.error", { error_class: workerErrorClass(error) });
    await cleanup.task; await this.scheduleRuntimeAlarm();
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
        capabilities: MCP_SERVER_CAPABILITIES, serverInfo: MCP_SERVER_INFO, instructions: MCP_INSTRUCTIONS,
        tools: this.allTools(access.authorized.role) as Array<{ name: string; inputSchema?: unknown }>,
      });
      if (compatibility) return compatibility;
      const removed = removedProtocolResponse(request, body, MCP_PROTOCOL_VERSIONS);
      if (removed) return removed;
      validateHttpRequest({
        request,
        body,
        tools: this.allTools(access.authorized.role) as Array<{ name: string; inputSchema?: unknown }>,
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
      daemonRegistry: this.daemonRegistry, observability: this.observability,
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
    const recoveryStartedAt = performance.now();
    const socket = await waitForReadyDaemon(this.daemonRegistry, {
      graceMs: Math.min(NEW_CALL_RECONNECT_GRACE_MS, timeoutBudget.executionTimeoutMs),
      signal,
      tool: name,
      pending: this.pending.snapshot(),
    });
    const dispatchBudget = daemonToolTimeoutBudgetAfterDelay(timeoutBudget, performance.now() - recoveryStartedAt);
    const daemonAttachment = this.daemonRegistry.readyAttachment(socket);
    const daemonInstanceId = daemonAttachment?.instanceId ?? "";
    if (!daemonInstanceId) throw new WorkerToolError("unavailable", "local daemon connection is missing its instance identity", true);
    if (!daemonAttachment?.tools?.includes(name)) throw new WorkerToolError("authorization_denied", `tool disabled by local daemon policy: ${name}`);
    const id = randomToken("call");
    let result!: Promise<unknown>;
    try {
      await this.pendingAdmission.run(async () => {
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
          timeoutMs: dispatchBudget.settlementTimeoutMs,
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
          type: "tool_call", id, tool: name, arguments: args, timeout_ms: dispatchBudget.executionTimeoutMs,
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
    const terminationRequested = Boolean(record.socket && trySendWebSocket(record.socket, { type: "cancel_call", id: record.id }));
    return dispatchedDaemonTimeoutError(name, terminationRequested);
  }
  private daemonCallCancellation(record: import("./pending-call-contract.ts").PendingCallRecord): Error {
    const terminationRequested = Boolean(record.socket && trySendWebSocket(record.socket, { type: "cancel_call", id: record.id }));
    return dispatchedDaemonCancellationError("tool call cancelled when its HTTP response stream closed", terminationRequested);
  }

  private async cancelClientRequest(requestKey?: string): Promise<void> {
    if (!requestKey) return;
    const cancelledTransient = await this.pending.cancelRequest(requestKey, (record) => {
      const terminationRequested = Boolean(record.socket && trySendWebSocket(record.socket, { type: "cancel_call", id: record.id }));
      return dispatchedDaemonCancellationError("tool call cancelled by client", terminationRequested);
    });
    if (cancelledTransient) {
      await this.scheduleRuntimeAlarm();
      return;
    }
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
      await this.invalidateDaemonSocket(server, "daemon welcome failed", "daemon welcome failed", "daemon_transport_error");
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
  private daemonAdvertisedTools(): Set<string> {
    this.reclaimStaleDaemonSockets();
    const socket = this.daemonRegistry.readySockets()[0];
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
    if (!attachment?.instanceId) {
      return await this.pending.rejectSocket(ws, () => dispatchedDaemonDisconnectError(message));
    }
    return this.pending.detachSocket(
      ws,
      DAEMON_RECONNECT_GRACE_MS,
      () => dispatchedDaemonDisconnectError(`${message}; reconnect grace expired`),
    );
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
