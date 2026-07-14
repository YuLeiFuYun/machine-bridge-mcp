import { DurableObject } from "cloudflare:workers";
import serverMetadata from "../shared/server-metadata.json";
import { PendingCallRegistrationError, PendingCallRegistry } from "./pending-calls";
import { mcpClientRequestKey, resolveMcpSession } from "./mcp-session";
import { daemonToolTimeoutMs } from "./tool-timeout";
import { WorkerObservability } from "./observability";
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "./errors";
import { sanitizeDaemonPolicy, sanitizeDaemonTools, type DaemonPolicy } from "./policy";
import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole } from "./access";
import { accountAdminAuthorized, handleAccountAdminOperation } from "./account-admin";
import { serverInfoTool, workspaceTools } from "./tool-catalog";
import {
  AUTH_BLOCK_SECONDS, accountByName, authorizationIdentity, emptyOAuthStore, isCurrentOAuthStore,
  pkceS256, pruneAuthFailures, pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken,
  recordAuthorizationFailure, safeEqual, sha256Hex, validateAuthorizationRequest, verifyAccountPassword,
  type OAuthClient, type OAuthStore, type ValidatedAuthorization,
} from "./oauth-state";
import {
  HttpError, applyCors, authorizationRedirectLocation, baseUrl, bearerToken, corsPreflight, escapeHtml,
  html, json, methodNotAllowed, normalizeDisplayText, normalizeRedirectUri, oauthRedirect, sanitizeMetadataText,
  parseJsonRequest, parseRequestBody, searchParamsEntries, searchParamsObject, validateOrigin, workerErrorClass,
} from "./http";

const SERVER_NAME = String(serverMetadata.name);
const SERVER_VERSION = "1.0.2";
const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);
const MCP_SUPPORTED_PROTOCOL_VERSIONS = serverMetadata.supportedProtocolVersions.map((value) => String(value));
const JSONRPC_VERSION = "2.0";
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_PENDING_CALLS = 32;
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
const DAEMON_HELLO_TIMEOUT_MS = 10_000;
const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;
const MAX_OAUTH_CLIENTS = 50;
const MAX_OAUTH_CLIENTS_PER_IDENTITY = 5;
const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_TOKENS_PER_CLIENT = 20;
const MAX_CODES_PER_CLIENT = 10;
const MAX_OAUTH_CODES = 200;
const MAX_OAUTH_TOKENS = 500;
const MAX_AUTH_FAILURE_IDENTITIES = 200;
const AUTHORIZATION_FIELDS = new Set(["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource", "state"]);

interface BridgeEnv {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  ACCOUNT_ADMIN_SECRET: string;
  DAEMON_SHARED_SECRET: string;
  OAUTH_TOKEN_VERSION: string;
  MBM_WORKER_MAX_BODY_BYTES?: string;
  MBM_ALLOWED_ORIGINS?: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface DaemonAttachment {
  role: "candidate" | "expired" | "daemon";
  connectedAt: string;
  policy?: DaemonPolicy;
  tools?: string[];
}

interface AuthorizedToken {
  tokenKey: string;
  clientId: string;
  accountId: string;
  accountVersion: number;
  role: AccountRole;
}

const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");

export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new PendingCallRegistry(MAX_PENDING_CALLS);
  private readonly observability = new WorkerObservability();
  private oauthQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const base = baseUrl(request);
    const configuredOrigins = this.env.MBM_ALLOWED_ORIGINS ?? "";
    let response: Response;
    if (!validateOrigin(request, base, configuredOrigins)) response = json({ error: "origin_not_allowed" }, 403);
    else if (request.method === "OPTIONS" && request.headers.has("Origin")) response = corsPreflight(request, base, configuredOrigins);
    else response = applyCors(await this.handleRequest(request, base), request, base, configuredOrigins);
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
      if (url.pathname === "/admin/accounts") return await this.handleAccountAdmin(request, "accounts");
      if (url.pathname === "/admin/accounts/rotate-password") return await this.handleAccountAdmin(request, "rotate-password");
            if (url.pathname === "/oauth/register") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await this.registerClient(request);
      }
      if (url.pathname === "/oauth/authorize") {
        if (request.method === "GET") return await this.authorizeGet(request, base);
        if (request.method === "POST") return await this.authorizeSubmit(request, base);
        return methodNotAllowed("GET, POST");
      }
      if (url.pathname === "/oauth/token") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await this.exchangeToken(request, base);
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

    const socketAttachment = this.socketAttachment(ws);
    if (!socketAttachment) {
      closeWebSocketQuietly(ws, 1008, "missing daemon attachment");
      return;
    }

    if (socketAttachment.role === "expired") {
      closeWebSocketQuietly(ws, 1008, "expired daemon candidate");
      return;
    }

    if (body.type === "hello") {
      if (socketAttachment.role === "daemon") {
        rejectDaemonMessage(ws, "duplicate_hello", 1002, "duplicate daemon hello");
        return;
      }
      const previousDaemons = this.daemonSockets().filter((socket) => socket !== ws);
      if (socketAttachment.role === "candidate") {
        if (!isFreshDaemonCandidate(socketAttachment.connectedAt)) {
          closeWebSocketQuietly(ws, 1008, "stale daemon candidate");
          await this.scheduleCandidateAlarm();
          return;
        }
      }
      const daemonPolicy = sanitizeDaemonPolicy(body.policy);
      ws.serializeAttachment({
        role: "daemon",
        connectedAt: new Date().toISOString(),
        policy: daemonPolicy,
        tools: sanitizeDaemonTools(body.tools, daemonPolicy),
      } satisfies DaemonAttachment);
      this.observability.socketAuthenticated();
      await this.scheduleCandidateAlarm();
      try {
        ws.send(JSON.stringify({ type: "hello_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        ws.serializeAttachment({
          role: "expired",
          connectedAt: socketAttachment.connectedAt,
        } satisfies DaemonAttachment);
        closeWebSocketQuietly(ws, 1011, "daemon hello acknowledgement failed");
        return;
      }
      for (const socket of previousDaemons) {
        closeWebSocketQuietly(socket, 1012, "replaced by authenticated daemon");
      }
      return;
    }

    if (socketAttachment.role !== "daemon") {
      closeWebSocketQuietly(ws, 1008, "daemon hello required");
      return;
    }

    if (body.type === "heartbeat" || body.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: body.ts ?? Date.now() }));
      return;
    }

    if (body.type !== "tool_result" || typeof body.id !== "string") {
      rejectDaemonMessage(ws, "unknown_message_type", 1002, "unknown daemon message type");
      return;
    }

    if (body.ok === false) this.pending.reject(body.id, daemonToolError(body.error), ws);
    else this.pending.resolve(body.id, ws, body.result);
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
    await this.scheduleCandidateAlarm();
    this.pending.rejectSocket(ws, () => new WorkerToolError("unavailable", message, true));
  }

  private async handleMcp(request: Request, base: string): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "mcp endpoint expects POST JSON-RPC" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "POST", "cache-control": "no-store" },
      });
    }

    const authorized = await this.verifyAccessToken(bearerToken(request), base);
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
    const protocolError = validateProtocolVersionHeader(request, body);
    if (protocolError) return json(protocolError, 400);

    const session = await resolveMcpSession(request, body.method, this.identityKey(), authorized.tokenKey);
    if (session.kind === "invalid") return json(rpcError(body.id, -32001, "MCP session not found"), 404);
    const response = await this.dispatchJsonRpc(body, base, authorized, session.kind === "active" ? session.sessionId : "");
    if (response === null) return new Response(null, { status: 202 });
    return session.kind === "initialize" ? json(response, 200, { "mcp-session-id": session.sessionId }) : json(response);
  }

  private async dispatchJsonRpc(request: JsonRpcRequest, base: string, authorized: AuthorizedToken, sessionId: string): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") {
      const requested = asObject(request.params).protocolVersion;
      const protocolVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])
        ? requested
        : MCP_PROTOCOL_VERSION;
      const bootstrap = this.daemonToolEnabled("session_bootstrap")
        ? await this.callDaemonTool("session_bootstrap", { path: "." }, authorized).catch(() => null)
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
        const result = await this.callTool(name, args, base, authorized, mcpClientRequestKey(authorized.tokenKey, sessionId, request.id));
        return rpcResult(request.id, textToolResult(result));
      } catch (error) {
        return rpcResult(request.id, textToolResult({ error: publicWorkerToolError(error) }, true));
      }
    }
    return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }

  private async callTool(name: string, args: Record<string, unknown>, base: string, authorized: AuthorizedToken, requestKey?: string): Promise<unknown> {
    if (name === "server_info") {
      const daemon = this.daemonStatus(true);
      const tools = this.allTools(authorized.role).map((tool) => tool.name);
      return {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_url: `${base}/mcp`,
        oauth: this.authorizationServerMetadata(base),
        account: { account_id: authorized.accountId, role: authorized.role, version: authorized.accountVersion },
        daemon,
        worker: {
          pending_calls: this.pending.snapshot(),
          daemon_candidates: this.candidateSockets().length,
          observability: this.observability.snapshot(),
        },
        tools,
        tool_delivery: {
          full_profile_scope: "local-daemon-and-relay-advertisement",
          daemon_advertised_tool_count: daemon.tool_count,
          relay_advertised_tool_count: tools.length,
          host_exposed_tools_known_to_server: false,
          host_may_expose_subset: true,
        },
      };
    }
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!this.daemonToolEnabled(name)) throw new Error(`tool disabled by local daemon policy: ${name}`);
      if (!accountRoleAllowsTool(authorized.role, name)) throw new WorkerToolError("authorization_denied", "tool is not allowed for this account role");
      return this.callDaemonTool(name, args, authorized, requestKey);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async callDaemonTool(name: string, args: Record<string, unknown>, authorized: AuthorizedToken, requestKey?: string): Promise<unknown> {
    const socket = this.daemonSockets()[0];
    if (!socket) throw new WorkerToolError("unavailable", "local daemon is not connected; keep the CLI start command running", true);
    const id = randomToken("call");
    const timeoutMs = daemonToolTimeoutMs(name, args);
    let result: Promise<unknown>;
    try {
      result = this.pending.register({
        id,
        socket,
        clientRequestKey: requestKey,
        tool: name,
        timeoutMs,
        onTimeout: (record) => {
          sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
          return new WorkerToolError("timeout", `daemon tool timed out: ${name}`, true);
        },
      });
    } catch (error) {
      if (error instanceof PendingCallRegistrationError) {
        throw new WorkerToolError(error.code, error.message, error.retryable);
      }
      throw error;
    }
    this.observability.callStarted(name);
    try {
      socket.send(JSON.stringify({
        type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutMs,
        authorization: { account_id: authorized.accountId, account_version: authorized.accountVersion, role: authorized.role },
      }));
    } catch {
      this.pending.reject(id, new WorkerToolError("network_error", "failed to send daemon tool call", true), socket);
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
      sendWebSocketQuietly(record.socket, { type: "cancel_call", id: record.id });
      return new WorkerToolError("cancelled", "tool call cancelled by client");
    });
  }

  private async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const expected = this.env.DAEMON_SHARED_SECRET ?? "";
    const supplied = request.headers.get("X-Bridge-Token") ?? "";
    if (!expected || !(await safeEqual(supplied, expected))) return new Response("Unauthorized daemon", { status: 401 });

    for (const socket of this.nonDaemonSockets()) {
      closeWebSocketQuietly(socket, 1012, "replaced by newer daemon candidate");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.observability.socketCandidate();
    server.serializeAttachment({
      role: "candidate",
      connectedAt: new Date().toISOString(),
    } satisfies DaemonAttachment);
    await this.ctx.storage.setAlarm(Date.now() + DAEMON_HELLO_TIMEOUT_MS);
    server.send(JSON.stringify({ type: "welcome", server: SERVER_NAME, version: SERVER_VERSION }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private allTools(role: AccountRole): Array<Record<string, unknown>> {
    const advertised = accountRoleToolNames(role, this.daemonAdvertisedTools());
    const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
    return [serverInfoTool, ...localTools].map((tool) => structuredClone(tool));
  }

  private daemonToolEnabled(name: string): boolean {
    return this.daemonAdvertisedTools().has(name);
  }

  private daemonAdvertisedTools(): Set<string> {
    const socket = this.daemonSockets()[0];
    if (!socket) return new Set();
    const attachment = this.daemonAttachment(socket);
    if (!attachment?.tools) return new Set();
    return new Set(attachment.tools);
  }

  private daemonSockets(): WebSocket[] {
    return this.ctx.getWebSockets()
      .filter((socket) => this.daemonAttachment(socket) && socket.readyState === WebSocket.OPEN)
      .sort((left, right) => {
        const leftTime = Date.parse(this.daemonAttachment(left)?.connectedAt ?? "") || 0;
        const rightTime = Date.parse(this.daemonAttachment(right)?.connectedAt ?? "") || 0;
        return rightTime - leftTime;
      });
  }

  private candidateSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => this.socketAttachment(socket)?.role === "candidate" && socket.readyState === WebSocket.OPEN);
  }

  private nonDaemonSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const role = this.socketAttachment(socket)?.role;
      return role !== "daemon" && socket.readyState === WebSocket.OPEN;
    });
  }

  private socketAttachment(socket: WebSocket): DaemonAttachment | undefined {
    const raw = socket.deserializeAttachment();
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as Partial<DaemonAttachment>;
    if (candidate.role !== "candidate" && candidate.role !== "expired" && candidate.role !== "daemon") return undefined;
    const policy = sanitizeDaemonPolicy(candidate.policy);
    return {
      role: candidate.role,
      connectedAt: sanitizeMetadataText(candidate.connectedAt, 64) ?? "",
      policy,
      tools: sanitizeDaemonTools(candidate.tools, policy),
    };
  }

  private daemonAttachment(socket: WebSocket): DaemonAttachment | undefined {
    const attachment = this.socketAttachment(socket);
    return attachment?.role === "daemon" ? attachment : undefined;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const socket of this.candidateSockets()) {
      const attachment = this.socketAttachment(socket);
      const connectedAt = Date.parse(attachment?.connectedAt ?? "");
      const deadline = connectedAt + DAEMON_HELLO_TIMEOUT_MS;
      if (!Number.isFinite(connectedAt) || deadline <= now) {
        socket.serializeAttachment({
          role: "expired",
          connectedAt: attachment?.connectedAt ?? new Date(0).toISOString(),
        } satisfies DaemonAttachment);
        sendWebSocketQuietly(socket, { type: "error", error: "daemon_hello_timeout" });
        closeWebSocketQuietly(socket, 1008, "daemon hello timeout");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (Number.isFinite(nextDeadline)) await this.ctx.storage.setAlarm(nextDeadline);
    else await this.ctx.storage.deleteAlarm();
  }

  private async scheduleCandidateAlarm(): Promise<void> {
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const socket of this.candidateSockets()) {
      const attachment = this.socketAttachment(socket);
      const connectedAt = Date.parse(attachment?.connectedAt ?? "");
      if (!Number.isFinite(connectedAt)) {
        closeWebSocketQuietly(socket, 1008, "invalid daemon candidate timestamp");
        continue;
      }
      nextDeadline = Math.min(nextDeadline, connectedAt + DAEMON_HELLO_TIMEOUT_MS);
    }
    if (Number.isFinite(nextDeadline)) await this.ctx.storage.setAlarm(Math.max(Date.now(), nextDeadline));
    else await this.ctx.storage.deleteAlarm();
  }

  private daemonStatus(detail: boolean): Record<string, unknown> {
    const sockets = this.daemonSockets();
    const attachment = sockets[0] ? this.daemonAttachment(sockets[0]) : undefined;
    const tools = attachment?.tools ?? [];
    const base = {
      connected: sockets.length > 0,
      count: sockets.length,
      tool_count: tools.length,
      connected_at: attachment?.connectedAt ?? null,
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
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [SERVER_NAME],
    };
  }

  private protectedResourceMetadata(base: string): Record<string, unknown> {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [SERVER_NAME],
      bearer_methods_supported: ["header"],
      resource_name: SERVER_NAME,
    };
  }

  private async oauthStore(): Promise<OAuthStore> {
    const raw = await this.ctx.storage.get<unknown>("oauth");
    if (raw !== undefined && !isCurrentOAuthStore(raw)) {
      throw new HttpError(503, "oauth_state_schema_mismatch", "OAuth state requires the one-time multi-account upgrade");
    }
    const store = isCurrentOAuthStore(raw) ? raw : emptyOAuthStore();
    let changed = false;
    const now = Math.floor(Date.now() / 1000);

    for (const [code, value] of Object.entries(store.codes)) {
      const account = store.accounts[value.account_id];
      if (value.expires_at <= now || !account || !account.active || account.version !== value.account_version || account.role !== value.role) {
        delete store.codes[code];
        changed = true;
      }
    }
    for (const [token, value] of Object.entries(store.tokens)) {
      const account = store.accounts[value.account_id];
      if (value.expires_at <= now || !account || !account.active || account.version !== value.account_version || account.role !== value.role) {
        delete store.tokens[token];
        changed = true;
      }
    }
    for (const [identity, value] of Object.entries(store.auth_failures)) {
      if (!identity.startsWith("hmac-sha256:") || value.last_attempt + AUTH_BLOCK_SECONDS <= now) {
        delete store.auth_failures[identity];
        changed = true;
      }
    }
    const activeClientIds = new Set([
      ...Object.values(store.codes).map((value) => value.client_id),
      ...Object.values(store.tokens).map((value) => value.client_id),
    ]);
    for (const [clientId, client] of Object.entries(store.clients)) {
      if (client.registration_identity && !client.registration_identity.startsWith("hmac-sha256:")) {
        delete client.registration_identity;
        changed = true;
      }
      const ttl = client.last_used_at === client.created_at ? OAUTH_UNUSED_CLIENT_TTL_SECONDS : OAUTH_CLIENT_IDLE_TTL_SECONDS;
      if (!activeClientIds.has(clientId) && client.last_used_at + ttl <= now) {
        delete store.clients[clientId];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put("oauth", store);
    return store;
  }

  private async handleAccountAdmin(request: Request, operation: "accounts" | "rotate-password"): Promise<Response> {
    if (!(await accountAdminAuthorized(request, this.env.ACCOUNT_ADMIN_SECRET ?? ""))) return json({ error: "unauthorized" }, 401);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      return handleAccountAdminOperation({
        request, operation, store, now: Math.floor(Date.now() / 1000),
        save: () => this.ctx.storage.put("oauth", store),
      });
    });
  }

  private async registerClient(request: Request): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array" }, 400);
    }
    if (redirectUris.length > 5) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must contain at most 5 entries" }, 400);
    }
    const suppliedRedirectUris = redirectUris.map((item) => String(item));
    if (suppliedRedirectUris.some((item) => item.length > 1024)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uri is too long" }, 400);
    }
    const canonicalRedirectUris = suppliedRedirectUris.map(normalizeRedirectUri);
    if (canonicalRedirectUris.some((item) => item === null)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be canonicalizable https or local http URLs without credentials or fragments" }, 400);
    }
    const normalized = [...new Set(canonicalRedirectUris as string[])];

    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const registrationIdentity = await authorizationIdentity(request, this.identityKey());
      const identityClientCount = Object.values(store.clients).filter((client) => client.registration_identity === registrationIdentity).length;
      if (identityClientCount >= MAX_OAUTH_CLIENTS_PER_IDENTITY) {
        return json({ error: "too_many_requests", error_description: "client registration limit reached for this source" }, 429);
      }
      if (Object.keys(store.clients).length >= MAX_OAUTH_CLIENTS) {
        return json({ error: "temporarily_unavailable", error_description: "client registry is full; remove stale state or retry after inactive clients expire" }, 503);
      }
      const now = Math.floor(Date.now() / 1000);
      const client: OAuthClient = {
        client_id: randomToken("mcp_client"),
        client_name: normalizeDisplayText(stringOrUndefined(body.client_name) ?? "MCP Client", 128),
        redirect_uris: normalized,
        created_at: now,
        last_used_at: now,
        registration_identity: registrationIdentity,
      };
      store.clients[client.client_id] = client;
      await this.ctx.storage.put("oauth", store);
      return json({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: client.created_at,
      });
    });
  }

  private async authorizeGet(request: Request, base: string): Promise<Response> {
    const body = searchParamsObject(new URL(request.url).searchParams);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const validation = validateAuthorizationRequest(body, base, SERVER_NAME, store);
      if ("error" in validation) {
        return this.authorizePage(request, base, validation.error, body, validation.status, undefined, false);
      }
      return this.authorizePage(request, base, "", body, 200, validation.value, true);
    });
  }

  private authorizePage(
    request: Request,
    base: string,
    error = "",
    submitted?: Record<string, unknown>,
    status = 200,
    authorization?: ValidatedAuthorization,
    allowSubmit = true,
  ): Response {
    const url = new URL(request.url);
    const sourceEntries = submitted ? Object.entries(submitted) : searchParamsEntries(url.searchParams);
    const hidden = sourceEntries
      .filter(([key]) => AUTHORIZATION_FIELDS.has(key))
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
      .join("\n");
    const resource = normalizeDisplayText(
      authorization?.requestedResource ?? String(submitted?.resource ?? url.searchParams.get("resource") ?? `${base}/mcp`),
      1024,
      `${base}/mcp`,
    );
    const clientBlock = authorization
      ? `<p><strong>Client:</strong> ${escapeHtml(authorization.client.client_name)}</p>
    <p><strong>Redirect URI:</strong> <code>${escapeHtml(authorization.redirectUri)}</code></p>`
      : "";
    const errorBlock = error ? `<p role="alert" style="color:#b91c1c">${escapeHtml(error)}</p>` : "";
    const form = allowSubmit
      ? `<form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Account name<br><input name="account_name" autocomplete="username" autofocus required style="width: 100%; box-sizing: border-box; padding: 8px;"></label>
      <p><label>Account password<br><input name="account_password" type="password" autocomplete="current-password" required style="width: 100%; box-sizing: border-box; padding: 8px;"></label></p>
      <p><button type="submit">Authorize</button></p>
    </form>`
      : "<p>Authorization cannot continue. Return to the MCP client and start the connection again.</p>";
    return html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${SERVER_NAME}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorize ${SERVER_NAME}</h1>
    <p>Only continue if you initiated this MCP connection and recognize the client and redirect URI below.</p>
    ${clientBlock}
    <p><strong>Resource:</strong> <code>${escapeHtml(resource)}</code></p>
    ${errorBlock}
    ${form}
  </body>
</html>`, status);
  }

  private async authorizeSubmit(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const validation = validateAuthorizationRequest(body, base, SERVER_NAME, store);
      if ("error" in validation) {
        return this.authorizePage(request, base, validation.error, body, validation.status, undefined, false);
      }
      const { client, clientId, redirectUri, codeChallenge, requestedResource, scope, state } = validation.value;
      const now = Math.floor(Date.now() / 1000);
      const identity = await authorizationIdentity(request, this.identityKey());
      const failure = store.auth_failures[identity];
      if (failure?.blocked_until > now) {
        return this.authorizePage(request, base, "Too many failed attempts. Try again later.", body, 429, validation.value);
      }

      const account = accountByName(store, body.account_name);
      const credentialsValid = Boolean(account?.active && await verifyAccountPassword(account, body.account_password));
      if (!account || !credentialsValid) {
        recordAuthorizationFailure(store, identity, now);
        pruneAuthFailures(store, MAX_AUTH_FAILURE_IDENTITIES);
        await this.ctx.storage.put("oauth", store);
        const status = store.auth_failures[identity]?.blocked_until > now ? 429 : 401;
        return this.authorizePage(request, base, "Invalid account credentials.", body, status, validation.value);
      }
      delete store.auth_failures[identity];
      client.last_used_at = now;

      const code = randomToken("mcp_code");
      const redirectLocation = authorizationRedirectLocation(redirectUri, code, state);
      store.codes[code] = {
        client_id: clientId,
        account_id: account.account_id,
        account_version: account.version,
        role: account.role,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        scope,
        resource: requestedResource,
        expires_at: now + 300,
      };
      pruneClientRecordByExpiry(store.codes, clientId, MAX_CODES_PER_CLIENT);
      pruneRecordByExpiry(store.codes, MAX_OAUTH_CODES);
      await this.ctx.storage.put("oauth", store);

      return oauthRedirect(redirectLocation);
    });
  }

  private async exchangeToken(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    if (String(body.grant_type ?? "") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);

    const code = String(body.code ?? "");
    const verifier = String(body.code_verifier ?? "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const record = store.codes[code];
      if (!record) return json({ error: "invalid_grant" }, 400);
      if (String(body.client_id ?? "") !== record.client_id || String(body.redirect_uri ?? "") !== record.redirect_uri) {
        return json({ error: "invalid_grant", error_description: "client or redirect mismatch" }, 400);
      }
      if (String(body.resource ?? record.resource) !== record.resource) {
        return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
      }
      if (!(await safeEqual(await pkceS256(verifier), record.code_challenge))) {
        return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
      }

      const tokenVersion = this.env.OAUTH_TOKEN_VERSION ?? "";
      if (!tokenVersion) return json({ error: "server_error", error_description: "OAuth token version is not configured" }, 503);
      delete store.codes[code];
      const accessToken = randomToken("mcp_at");
      store.tokens[`sha256:${await sha256Hex(accessToken)}`] = {
        client_id: record.client_id,
        account_id: record.account_id,
        account_version: record.account_version,
        role: record.role,
        scope: record.scope,
        resource: `${base}/mcp`,
        version: tokenVersion,
        expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      };
      pruneClientRecordByExpiry(store.tokens, record.client_id, MAX_TOKENS_PER_CLIENT);
      pruneRecordByExpiry(store.tokens, MAX_OAUTH_TOKENS);
      await this.ctx.storage.put("oauth", store);
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: record.scope });
    });
  }

  private async verifyAccessToken(token: string, base: string): Promise<AuthorizedToken | null> {
    return this.withOAuthLock(async () => {
      if (!token) return null;
      const store = await this.oauthStore();
      const key = `sha256:${await sha256Hex(token)}`;
      const record = store.tokens[key];
      if (!record) return null;
      if (record.expires_at <= Math.floor(Date.now() / 1000)) {
        delete store.tokens[key];
        await this.ctx.storage.put("oauth", store);
        return null;
      }
      const currentVersion = this.env.OAUTH_TOKEN_VERSION ?? "";
      if (!record.version || !currentVersion || !(await safeEqual(record.version, currentVersion))) return null;
      if (record.resource !== `${base}/mcp`) return null;
      const account = store.accounts[record.account_id];
      if (!account || !account.active || account.version !== record.account_version || account.role !== record.role) {
        delete store.tokens[key];
        await this.ctx.storage.put("oauth", store);
        return null;
      }
      return {
        tokenKey: key, clientId: record.client_id, accountId: account.account_id,
        accountVersion: account.version, role: account.role,
      };
    });
  }

  private async withOAuthLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.oauthQueue;
    let release = () => {};
    this.oauthQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private identityKey(): string {
    const key = this.env.OAUTH_TOKEN_VERSION || this.env.DAEMON_SHARED_SECRET || this.env.ACCOUNT_ADMIN_SECRET;
    if (!key) throw new HttpError(503, "server_not_configured", "OAuth identity key is not configured");
    return key;
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectDaemonMessage(ws: WebSocket, error: string, closeCode: number, closeReason: string): void {
  sendWebSocketQuietly(ws, { type: "error", error });
  closeWebSocketQuietly(ws, closeCode, closeReason);
}

function sendWebSocketQuietly(ws: WebSocket, value: unknown): void {
  try {
    ws.send(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Best-effort protocol cleanup must not replace the primary timeout or rejection.
  }
}

function closeWebSocketQuietly(ws: WebSocket, code?: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // The socket may already be closed or detached; no recovery remains at this boundary.
  }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSONRPC_VERSION || typeof candidate.method !== "string" || !candidate.method.trim() || candidate.method.length > 256) return false;
  if ("id" in candidate && !isJsonRpcId(candidate.id)) return false;
  return true;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSONRPC_VERSION || !("id" in candidate) || !isJsonRpcId(candidate.id) || typeof candidate.method === "string") return false;
  return ("result" in candidate) !== ("error" in candidate);
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> | null {
  if (id === undefined) return null;
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error };
}

function textToolResult(value: unknown, isError = false): Record<string, unknown> {
  const special = asObject(value).$mcp;
  if (special && typeof special === "object" && !Array.isArray(special)) {
    const specialObject = special as Record<string, unknown>;
    if (Array.isArray(specialObject.content)) {
      const result: Record<string, unknown> = { content: specialObject.content, isError };
      if (specialObject.structuredContent && typeof specialObject.structuredContent === "object" && !Array.isArray(specialObject.structuredContent)) {
        result.structuredContent = specialObject.structuredContent;
      }
      return result;
    }
  }
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
  if (value && typeof value === "object" && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

function isFreshDaemonCandidate(connectedAt: string): boolean {
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= DAEMON_HELLO_TIMEOUT_MS;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`${key} must be a non-empty string`);
  return field.trim();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionInstructionText(value: unknown): string {
  const object = asObject(value);
  const instructions = typeof object.instructions === "string" ? object.instructions : "";
  if (!instructions) return "";
  const bytes = new TextEncoder().encode(instructions);
  if (bytes.byteLength > 3 * 1024 * 1024) return "";
  return instructions;
}

function validateProtocolVersionHeader(request: Request, body: JsonRpcRequest): Record<string, unknown> | null {
  if (body.method === "initialize") return null;
  const version = request.headers.get("MCP-Protocol-Version");
  if (!version) return null;
  if (MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])) return null;
  return rpcError(body.id, -32602, "Unsupported MCP protocol version", {
    requested: version,
    supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
  });
}
