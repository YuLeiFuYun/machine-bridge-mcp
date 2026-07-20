import { DurableObject } from "cloudflare:workers";
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { PendingCallRegistrationError, PendingCallRegistry } from "./pending-calls.ts";
import {
  DAEMON_HELLO_TIMEOUT_MS,
  DAEMON_LIVENESS_TIMEOUT_MS,
  DAEMON_READY_TIMEOUT_MS,
  daemonLastSeenMs,
  daemonLivenessDeadlineMs,
  daemonReadyDeadlineMs,
  isFreshDaemonCandidate,
} from "./daemon-liveness.ts";
import { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { mcpClientRequestKey, resolveMcpSession } from "./mcp-session.ts";
import { daemonToolTimeoutMs } from "./tool-timeout.ts";
import { WorkerObservability } from "./observability.ts";
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole } from "./access.ts";
import { OAuthController, type AuthorizedToken, type OAuthControllerEnv } from "./oauth-controller.ts";
import { accountAuthoritySnapshot, decorateProjectOverview, describeDaemonCeiling } from "./authority.ts";
import { serverInfoTool, workspaceTools } from "./tool-catalog.ts";
import { OFFLINE_ACCESS_SCOPE, randomToken, safeEqual } from "./oauth-state.ts";
import {
  HttpError, applyCors, baseUrl, bearerToken, corsPreflight, json, methodNotAllowed,
  parseJsonRequest, workerErrorClass,
} from "./http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  sessionInstructionText, textToolResult, validateProtocolVersionHeader, type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly,
} from "./websocket-protocol.ts";

const SERVER_NAME = String(serverMetadata.name);
const SERVER_VERSION = "1.2.10";
const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);
const MCP_SUPPORTED_PROTOCOL_VERSIONS = serverMetadata.supportedProtocolVersions.map((value) => String(value));
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_CALLS = 32;
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_RECONNECT_GRACE_MS = 30_000;

interface BridgeEnv extends OAuthControllerEnv {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  ACCOUNT_ADMIN_SECRET: string;
  DAEMON_SHARED_SECRET: string;
  OAUTH_TOKEN_VERSION: string;
  MBM_WORKER_MAX_BODY_BYTES?: string;
  MBM_ALLOWED_ORIGINS?: string;
}

const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");

export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS);
  private readonly observability = new WorkerObservability();
  private readonly oauth: OAuthController;
  private readonly daemonRegistry: DaemonSocketRegistry;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.oauth = new OAuthController(ctx, env, SERVER_NAME);
    this.daemonRegistry = new DaemonSocketRegistry(ctx);
  }

  async fetch(request: Request): Promise<Response> {
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
      if (url.pathname === "/") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, mcp: `${base}/mcp` });
      }
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
      }
      if (url.pathname === "/.well-known/mcp.json") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json(this.mcpMetadata(base));
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/openid-configuration/mcp"
      ) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json(this.authorizationServerMetadata(base));
      }
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json(this.protectedResourceMetadata(base));
      }
      if (url.pathname === "/admin/accounts") return await this.oauth.handleAccountAdmin(request, "accounts");
      if (url.pathname === "/admin/accounts/rotate-password") return await this.oauth.handleAccountAdmin(request, "rotate-password");
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
        await this.scheduleSocketAlarms();
        return;
      }
      const daemonPolicy = sanitizeDaemonPolicy(body.policy);
      const instanceId = daemonInstanceId(body.instance_id);
      if (!instanceId) {
        rejectDaemonMessage(ws, "invalid_daemon_instance", 1002, "daemon instance id required");
        return;
      }
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
        await this.scheduleSocketAlarms();
        return;
      }
      await this.scheduleSocketAlarms();
      return;
    }

    if (socketAttachment.role === "candidate") {
      closeWebSocketQuietly(ws, 1008, "daemon hello required");
      return;
    }

    if (body.type === "heartbeat" || body.type === "ping") {
      await this.touchDaemonSocket(ws);
      ws.send(JSON.stringify({ type: "pong", ts: body.ts ?? Date.now() }));
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
      const reboundCallIds = this.pending.rebindInstance(readyAttachment.instanceId ?? "", ws);
      if (reboundCallIds.length > 0) {
        this.observability.event("info", "daemon.calls.rebound", { rebound_calls: reboundCallIds.length });
      }
      try {
        ws.send(JSON.stringify({ type: "resume_calls", ids: reboundCallIds }));
        ws.send(JSON.stringify({ type: "ready_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        this.invalidateDaemonSocket(ws, "daemon readiness acknowledgement failed", "daemon ready timeout", "daemon_ready_timeout");
        return;
      }
      this.observability.socketReady();
      for (const previous of this.daemonRegistry.readyRoleSockets().filter((socket) => socket !== ws)) {
        closeWebSocketQuietly(previous, 1012, "replaced by verified daemon");
      }
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
      ? this.pending.reject(body.id, daemonToolError(body.error), ws)
      : this.pending.resolve(body.id, ws, body.result);
    if (!matched) this.observability.unmatchedResult();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.cleanupDaemonSocket(ws, "daemon disconnected");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.observability.event("warn", "daemon.websocket.error", { error_class: workerErrorClass(error) });
    await this.cleanupDaemonSocket(ws, "daemon transport error");
  }

  private async cleanupDaemonSocket(ws: WebSocket, message: string): Promise<void> {
    this.observability.socketDisconnected();
    this.detachDaemonSocketCalls(ws, message);
    await this.scheduleSocketAlarms();
  }

  private async handleMcp(request: Request, base: string): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "mcp endpoint expects POST JSON-RPC" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "POST", "cache-control": "no-store" },
      });
    }

    const authorized = await this.oauth.verifyAccessToken(bearerToken(request), base);
    if (!authorized) {
      try { await request.arrayBuffer(); } catch { /* The rejected body may already be unavailable; the 401 remains authoritative. */ }
      return new Response("OAuth bearer token required", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const body = await parseJsonRequest(request, this.bodyLimitBytes());
    if (isJsonRpcResponse(body)) return new Response(null, { status: 202 });
    if (!isJsonRpcRequest(body)) return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);
    const protocolError = validateProtocolVersionHeader(request, body, MCP_SUPPORTED_PROTOCOL_VERSIONS);
    if (protocolError) return json(protocolError, 400);

    const session = await resolveMcpSession(request, body.method, this.oauth.identityKey(), authorized.tokenKey);
    if (session.kind === "invalid") return json(rpcError(body.id, -32001, "MCP session not found"), 404);
    const response = await this.dispatchJsonRpc(
      body,
      base,
      authorized,
      session.kind === "active" ? session.sessionId : "",
      request.signal,
    );
    if (response === null) return new Response(null, { status: 202 });
    return session.kind === "initialize" ? json(response, 200, { "mcp-session-id": session.sessionId }) : json(response);
  }

  private async dispatchJsonRpc(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") {
      const requested = asObject(request.params).protocolVersion;
      const protocolVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])
        ? requested
        : MCP_PROTOCOL_VERSION;
      const bootstrap = this.daemonToolEnabled("session_bootstrap")
        ? await this.callDaemonTool("session_bootstrap", { path: "." }, authorized, undefined, signal).catch(() => null)
        : null;
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
      this.cancelClientRequest(mcpClientRequestKey(authorized.tokenKey, sessionId, asObject(request.params).requestId));
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
          signal,
        );
        return rpcResult(request.id, textToolResult(result));
      } catch (error) {
        return rpcResult(request.id, textToolResult({ error: publicWorkerToolError(error) }, true));
      }
    }
    return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
  private async callTool(
    name: string,
    args: Record<string, unknown>,
    base: string,
    authorized: AuthorizedToken,
    requestKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (name === "server_info") {
      const { daemon, tools, authorization } = this.authorityContext(authorized);
      return {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_url: `${base}/mcp`,
        oauth: this.authorizationServerMetadata(base),
        account: authorization.account,
        authorization,
        authority_summary: authorization.summary,
        daemon,
        worker: {
          pending_calls: this.pending.snapshot(),
          daemon_candidates: this.daemonRegistry.candidateSockets().length,
          daemon_probes: this.daemonRegistry.probingSockets().length,
          sockets_live: {
            authenticated: this.daemonRegistry.readyRoleSockets().length + this.daemonRegistry.probingSockets().length,
            ready: this.daemonRegistry.readySockets().length,
            probing: this.daemonRegistry.probingSockets().length,
            candidates: this.daemonRegistry.candidateSockets().length,
          },
          observability: this.observability.snapshot(),
        },
        tools,
        tools_scope: "authenticated_account_effective_tools_before_host_filtering",
        tool_delivery: {
          full_profile_scope: "daemon-capability-ceiling-before-account-filtering",
          daemon_advertised_tool_count: daemon.tool_count,
          relay_advertised_tool_count: tools.length,
          effective_account_tool_count: tools.length,
          relay_advertised_scope: "authenticated_account_effective_tools_before_host_filtering",
          host_exposed_tools_known_to_server: false,
          host_may_expose_subset: true,
        },
      };
    }
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!this.daemonToolEnabled(name)) throw new Error(`tool disabled by local daemon policy: ${name}`);
      if (!accountRoleAllowsTool(authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
      const result = await this.callDaemonTool(name, args, authorized, requestKey, signal);
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
    signal?: AbortSignal,
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
        onTimeout: (record) => {
          if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
          const silentForMs = record.socket
            ? Date.now() - daemonLastSeenMs(this.daemonRegistry.readyAttachment(record.socket))
            : 0;
          if (record.socket && (!Number.isFinite(silentForMs) || silentForMs > 45_000)) {
            this.invalidateDaemonSocket(record.socket, "daemon became unresponsive", "daemon liveness timeout");
          }
          return new WorkerToolError("timeout", `daemon tool timed out: ${name}`, true);
        },
        signal,
        onAbort: (record) => {
          if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
          return new WorkerToolError("cancelled", "MCP client stopped waiting for the tool result");
        },
      });
    } catch (error) {
      if (error instanceof PendingCallRegistrationError) {
        throw new WorkerToolError(error.code, error.message, error.retryable);
      }
      throw error;
    }
    this.observability.callStarted(name);
    if (!signal?.aborted) {
      try {
        socket.send(JSON.stringify({
          type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutMs,
          authorization: { account_id: authorized.accountId, account_version: authorized.accountVersion, role: authorized.role },
        }));
      } catch {
        this.pending.reject(id, new WorkerToolError("network_error", "failed to send daemon tool call", true), socket);
        this.invalidateDaemonSocket(socket, "failed to send daemon tool call", "daemon send failed");
      }
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
  private cancelClientRequest(requestKey?: string): void {
    if (!requestKey) return;
    this.pending.cancelRequest(requestKey, (record) => {
      if (record.socket) sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
      return new WorkerToolError("cancelled", "tool call cancelled by client");
    });
  }

  private async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const expected = this.env.DAEMON_SHARED_SECRET ?? "";
    const supplied = request.headers.get("X-Bridge-Token") ?? "";
    if (!expected || !(await safeEqual(supplied, expected))) return new Response("Unauthorized daemon", { status: 401 });

    for (const socket of this.daemonRegistry.nonReadySockets()) {
      closeWebSocketQuietly(socket, 1012, "replaced by newer daemon candidate");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.observability.socketCandidate();
    this.daemonRegistry.beginCandidate(server);
    await this.scheduleSocketAlarms();
    server.send(JSON.stringify({ type: "welcome", server: SERVER_NAME, version: SERVER_VERSION }));
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
    await this.scheduleSocketAlarms();
  }

  private invalidateDaemonSocket(
    ws: WebSocket,
    message: string,
    closeReason: string,
    errorCode = "daemon_liveness_timeout",
  ): void {
    this.detachDaemonSocketCalls(ws, message);
    this.daemonRegistry.expire(ws);
    sendWebSocketQuietly(ws, { type: "error", error: errorCode });
    closeWebSocketQuietly(ws, 1008, closeReason);
  }

  private detachDaemonSocketCalls(ws: WebSocket, message: string): number {
    const attachment = this.daemonRegistry.attachment(ws);
    if (!attachment?.instanceId) {
      return this.pending.rejectSocket(ws, () => new WorkerToolError("unavailable", message, true));
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
      this.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout");
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const socket of this.daemonRegistry.candidateSockets()) {
      const attachment = this.daemonRegistry.attachment(socket);
      const connectedAt = Date.parse(attachment?.connectedAt ?? "");
      const deadline = connectedAt + DAEMON_HELLO_TIMEOUT_MS;
      if (!Number.isFinite(connectedAt) || deadline <= now) {
        this.daemonRegistry.expire(socket);
        sendWebSocketQuietly(socket, { type: "error", error: "daemon_hello_timeout" });
        closeWebSocketQuietly(socket, 1008, "daemon hello timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    for (const socket of this.daemonRegistry.probingSockets()) {
      const attachment = this.daemonRegistry.attachment(socket);
      const readyDeadline = daemonReadyDeadlineMs(attachment);
      const liveDeadline = daemonLivenessDeadlineMs(attachment);
      if (!Number.isFinite(readyDeadline) || !Number.isFinite(liveDeadline) || Math.min(readyDeadline, liveDeadline) <= now) {
        this.invalidateDaemonSocket(socket, "daemon did not complete end-to-end readiness verification", "daemon ready timeout", "daemon_ready_timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, readyDeadline, liveDeadline);
    }
    for (const socket of this.daemonRegistry.readyRoleSockets()) {
      const deadline = daemonLivenessDeadlineMs(this.daemonRegistry.readyAttachment(socket));
      if (!Number.isFinite(deadline) || deadline <= now) {
        this.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (Number.isFinite(nextDeadline)) await this.ctx.storage.setAlarm(nextDeadline);
    else await this.ctx.storage.deleteAlarm();
  }

  private async scheduleSocketAlarms(): Promise<void> {
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const socket of this.daemonRegistry.candidateSockets()) {
      const attachment = this.daemonRegistry.attachment(socket);
      const connectedAt = Date.parse(attachment?.connectedAt ?? "");
      if (!Number.isFinite(connectedAt)) {
        closeWebSocketQuietly(socket, 1008, "invalid daemon candidate timestamp");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, connectedAt + DAEMON_HELLO_TIMEOUT_MS);
    }
    for (const socket of this.daemonRegistry.probingSockets()) {
      const attachment = this.daemonRegistry.attachment(socket);
      const readyDeadline = daemonReadyDeadlineMs(attachment);
      const liveDeadline = daemonLivenessDeadlineMs(attachment);
      if (!Number.isFinite(readyDeadline) || !Number.isFinite(liveDeadline)) {
        this.invalidateDaemonSocket(socket, "daemon readiness state is invalid", "daemon ready timeout", "daemon_ready_timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, readyDeadline, liveDeadline);
    }
    for (const socket of this.daemonRegistry.readyRoleSockets()) {
      const deadline = daemonLivenessDeadlineMs(this.daemonRegistry.readyAttachment(socket));
      if (!Number.isFinite(deadline)) {
        this.invalidateDaemonSocket(socket, "daemon became unresponsive", "invalid daemon liveness timestamp");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (Number.isFinite(nextDeadline)) await this.ctx.storage.setAlarm(Math.max(Date.now(), nextDeadline));
    else await this.ctx.storage.deleteAlarm();
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

  private mcpMetadata(base: string): Record<string, unknown> {
    return {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      protocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      transport: { type: "streamable-http", url: `${base}/mcp` },
      auth: { type: "oauth", authorization_servers: [base] },
    };
  }

  private authorizationServerMetadata(base: string): Record<string, unknown> {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [SERVER_NAME, OFFLINE_ACCESS_SCOPE],
    };
  }

  private protectedResourceMetadata(base: string): Record<string, unknown> {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [SERVER_NAME, OFFLINE_ACCESS_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: SERVER_NAME,
    };
  }

  private bodyLimitBytes(): number {
    const parsed = Number.parseInt(this.env.MBM_WORKER_MAX_BODY_BYTES ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
    return Math.min(parsed, MAX_BODY_BYTES);
  }
}

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    const stub = env.BRIDGE.getByName("default");
    return stub.fetch(request);
  },
} satisfies ExportedHandler<BridgeEnv>;

function daemonInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^daemon_[A-Za-z0-9_-]{16,96}$/.test(value)) return "";
  return value;
}
