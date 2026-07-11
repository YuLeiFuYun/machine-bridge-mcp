import { DurableObject } from "cloudflare:workers";
import toolCatalog from "../shared/tool-catalog.json";
import serverMetadata from "../shared/server-metadata.json";

const SERVER_NAME = String(serverMetadata.name);
const SERVER_VERSION = "0.8.0";
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
const AUTH_FAILURE_WINDOW_SECONDS = 10 * 60;
const AUTH_BLOCK_SECONDS = 15 * 60;
const AUTH_FAILURE_LIMIT = 10;
const AUTHORIZATION_FIELDS = new Set(["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource", "state"]);
const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

interface BridgeEnv {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  MCP_OAUTH_PASSWORD: string;
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

interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  last_used_at: number;
  registration_identity?: string;
}

interface OAuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: number;
}

interface OAuthToken {
  client_id: string;
  scope: string;
  resource: string;
  version: string;
  expires_at: number;
}

interface OAuthFailure {
  count: number;
  window_started: number;
  blocked_until: number;
  last_attempt: number;
}

interface OAuthStore {
  clients: Record<string, OAuthClient>;
  codes: Record<string, OAuthCode>;
  tokens: Record<string, OAuthToken>;
  auth_failures: Record<string, OAuthFailure>;
}

interface ValidatedAuthorization {
  client: OAuthClient;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  requestedResource: string;
  scope: string;
  state: string;
}

interface DaemonAttachment {
  role: "candidate" | "expired" | "daemon";
  connectedAt: string;
  policy?: Record<string, unknown>;
  tools?: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  socket: WebSocket;
  clientRequestKey?: string;
}

interface AuthorizedToken {
  tokenKey: string;
  clientId: string;
}

type ToolDefinition = Record<string, unknown> & { name: string; availability?: string };

const allCatalogTools = toolCatalog as ToolDefinition[];
const serverInfoTool = publicTool(allCatalogTools.find((tool) => tool.name === "server_info")!);
const workspaceTools = allCatalogTools.filter((tool) => tool.name !== "server_info").map(publicTool);

const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");


function publicTool(tool: ToolDefinition): ToolDefinition {
  const { availability: _availability, ...definition } = tool;
  return structuredClone(definition) as ToolDefinition;
}

export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new Map<string, PendingCall>();
  private oauthQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const base = baseUrl(request);
    const configuredOrigins = this.env.MBM_ALLOWED_ORIGINS ?? "";
    if (!validateOrigin(request, base, configuredOrigins)) return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS" && request.headers.has("Origin")) {
      return corsPreflight(request, base, configuredOrigins);
    }
    const response = await this.handleRequest(request, base);
    return applyCors(response, request, base, configuredOrigins);
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
      console.error(JSON.stringify({ level: "error", message: "request_failed", path: url.pathname, error_class: workerErrorClass(error) }));
      return json({ error: "internal_server_error" }, 500);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_DAEMON_MESSAGE_BYTES) {
      try { ws.close(1009, "message too large"); } catch {}
      return;
    }
    let text: string;
    try {
      text = typeof message === "string" ? message : new TextDecoder("utf-8", { fatal: true }).decode(message);
    } catch {
      try { ws.close(1007, "invalid UTF-8"); } catch {}
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }

    const socketAttachment = this.socketAttachment(ws);
    if (!socketAttachment) {
      try { ws.close(1008, "missing daemon attachment"); } catch {}
      return;
    }

    if (socketAttachment.role === "expired") {
      try { ws.close(1008, "expired daemon candidate"); } catch {}
      return;
    }

    if (body.type === "hello") {
      const previousDaemons = this.daemonSockets().filter((socket) => socket !== ws);
      if (socketAttachment.role === "candidate") {
        if (!isFreshDaemonCandidate(socketAttachment.connectedAt)) {
          try { ws.close(1008, "stale daemon candidate"); } catch {}
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
      await this.scheduleCandidateAlarm();
      try {
        ws.send(JSON.stringify({ type: "hello_ack", server: SERVER_NAME, version: SERVER_VERSION }));
      } catch {
        ws.serializeAttachment({
          role: "expired",
          connectedAt: socketAttachment.connectedAt,
        } satisfies DaemonAttachment);
        try { ws.close(1011, "daemon hello acknowledgement failed"); } catch {}
        return;
      }
      for (const socket of previousDaemons) {
        try { socket.close(1012, "replaced by authenticated daemon"); } catch {}
      }
      return;
    }

    if (socketAttachment.role !== "daemon") {
      try { ws.close(1008, "daemon hello required"); } catch {}
      return;
    }

    if (body.type === "heartbeat" || body.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: body.ts ?? Date.now() }));
      return;
    }

    if (body.type !== "tool_result" || typeof body.id !== "string") {
      ws.send(JSON.stringify({ type: "error", error: "unknown_message_type" }));
      return;
    }

    const pending = this.pending.get(body.id);
    if (!pending || pending.socket !== ws) return;
    clearTimeout(pending.timeout);
    this.pending.delete(body.id);
    if (body.ok === false) pending.reject(new Error(errorMessage(body.error)));
    else pending.resolve(body.result);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.cleanupDaemonSocket(ws, "daemon disconnected");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ level: "warn", message: "daemon_websocket_error", error_class: workerErrorClass(error) }));
    await this.cleanupDaemonSocket(ws, "daemon transport error");
  }

  private async cleanupDaemonSocket(ws: WebSocket, message: string): Promise<void> {
    await this.scheduleCandidateAlarm();
    for (const [id, pending] of this.pending) {
      if (pending.socket !== ws) continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
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
    const response = await this.dispatchJsonRpc(body, base, authorized);
    if (response === null) return new Response(null, { status: 202 });
    return json(response);
  }

  private async dispatchJsonRpc(request: JsonRpcRequest, base: string, authorized: AuthorizedToken): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") {
      const requested = asObject(request.params).protocolVersion;
      const protocolVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])
        ? requested
        : MCP_PROTOCOL_VERSION;
      return rpcResult(request.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: {
          name: SERVER_NAME,
          title: "Machine Bridge MCP",
          version: SERVER_VERSION,
          description: "Workspace-scoped local coding tools over authenticated remote relay.",
        },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    if (request.method === "notifications/initialized") return null;
    if (request.method === "notifications/cancelled") {
      this.cancelClientRequest(clientRequestKey(authorized, asObject(request.params).requestId));
      return null;
    }
    if (request.method === "logging/setLevel") return rpcResult(request.id, {});
    if (request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") return rpcResult(request.id, { tools: this.allTools() });
    if (request.method === "tools/call") {
      if (request.id === undefined || request.id === null) return rpcError(null, -32600, "tools/call requires a non-null request id");
      const params = asObject(request.params);
      const name = requiredString(params, "name");
      const args = asObject(params.arguments);
      try {
        const result = await this.callTool(name, args, base, clientRequestKey(authorized, request.id));
        return rpcResult(request.id, textToolResult(result));
      } catch (error) {
        return rpcResult(request.id, textToolResult({ error: errorMessage(error) }, true));
      }
    }
    return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }

  private async callTool(name: string, args: Record<string, unknown>, base: string, requestKey?: string): Promise<unknown> {
    if (name === "server_info") {
      const daemon = this.daemonStatus(true);
      const tools = this.allTools().map((tool) => tool.name);
      return {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_url: `${base}/mcp`,
        oauth: this.authorizationServerMetadata(base),
        daemon,
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
      return this.callDaemonTool(name, args, requestKey);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async callDaemonTool(name: string, args: Record<string, unknown>, requestKey?: string): Promise<unknown> {
    const socket = this.daemonSockets()[0];
    if (!socket) throw new Error("local daemon is not connected; keep the CLI start command running");
    if (this.pending.size >= MAX_PENDING_CALLS) throw new Error("too many concurrent daemon tool calls");
    if (requestKey && [...this.pending.values()].some((pending) => pending.clientRequestKey === requestKey)) {
      throw new Error("duplicate in-flight JSON-RPC request id for this access token");
    }
    const id = randomToken("call");
    const timeoutMs = daemonToolTimeoutMs(name, args);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        try { socket.send(JSON.stringify({ type: "cancel_call", id })); } catch {}
        reject(new Error(`daemon tool timed out: ${name}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, socket, clientRequestKey: requestKey });
      try {
        socket.send(JSON.stringify({ type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutMs }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`failed to send daemon tool call: ${errorMessage(error)}`));
      }
    });
  }

  private cancelClientRequest(requestKey?: string): void {
    if (!requestKey) return;
    for (const [id, pending] of this.pending) {
      if (pending.clientRequestKey !== requestKey) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      try { pending.socket.send(JSON.stringify({ type: "cancel_call", id })); } catch {}
      pending.reject(new Error("tool call cancelled by client"));
    }
  }

  private async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const expected = this.env.DAEMON_SHARED_SECRET ?? "";
    const supplied = request.headers.get("X-Bridge-Token") ?? "";
    if (!expected || !(await safeEqual(supplied, expected))) return new Response("Unauthorized daemon", { status: 401 });

    for (const socket of this.nonDaemonSockets()) {
      try { socket.close(1012, "replaced by newer daemon candidate"); } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: "candidate",
      connectedAt: new Date().toISOString(),
    } satisfies DaemonAttachment);
    await this.ctx.storage.setAlarm(Date.now() + DAEMON_HELLO_TIMEOUT_MS);
    server.send(JSON.stringify({ type: "welcome", server: SERVER_NAME, version: SERVER_VERSION }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private allTools(): Array<Record<string, unknown>> {
    const advertised = this.daemonAdvertisedTools();
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
        try { socket.send(JSON.stringify({ type: "error", error: "daemon_hello_timeout" })); } catch {}
        try { socket.close(1008, "daemon hello timeout"); } catch {}
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
        try { socket.close(1008, "invalid daemon candidate timestamp"); } catch {}
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
    const store = (await this.ctx.storage.get<OAuthStore>("oauth")) ?? { clients: {}, codes: {}, tokens: {}, auth_failures: {} };
    store.clients ||= {};
    store.codes ||= {};
    store.tokens ||= {};
    store.auth_failures ||= {};
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [code, value] of Object.entries(store.codes)) {
      if (value.expires_at <= now) {
        delete store.codes[code];
        changed = true;
      }
    }
    for (const [token, value] of Object.entries(store.tokens)) {
      if (value.expires_at <= now) {
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
      if (!client.last_used_at) {
        client.last_used_at = client.created_at;
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
      const validation = validateAuthorizationRequest(body, base, store);
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
      <label>Connection password<br><input name="login_token" type="password" autocomplete="current-password" autofocus required style="width: 100%; box-sizing: border-box; padding: 8px;"></label>
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
      const validation = validateAuthorizationRequest(body, base, store);
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

      const expectedLogin = this.env.MCP_OAUTH_PASSWORD ?? "";
      if (!expectedLogin || !(await safeEqual(String(body.login_token ?? ""), expectedLogin))) {
        recordAuthorizationFailure(store, identity, now);
        pruneAuthFailures(store, MAX_AUTH_FAILURE_IDENTITIES);
        await this.ctx.storage.put("oauth", store);
        const status = store.auth_failures[identity]?.blocked_until > now ? 429 : 401;
        return this.authorizePage(request, base, "Invalid connection password.", body, status, validation.value);
      }
      delete store.auth_failures[identity];
      client.last_used_at = now;

      const code = randomToken("mcp_code");
      store.codes[code] = {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        scope,
        resource: requestedResource,
        expires_at: now + 300,
      };
      pruneClientRecordByExpiry(store.codes, clientId, MAX_CODES_PER_CLIENT);
      pruneRecordByExpiry(store.codes, MAX_OAUTH_CODES);
      await this.ctx.storage.put("oauth", store);

      const params = new URLSearchParams({ code });
      if (state) params.set("state", state);
      return oauthRedirect(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${params.toString()}`);
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
      return { tokenKey: key, clientId: record.client_id };
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
    const key = this.env.OAUTH_TOKEN_VERSION || this.env.DAEMON_SHARED_SECRET || this.env.MCP_OAUTH_PASSWORD;
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

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: {
      allow,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function oauthRedirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function isFreshDaemonCandidate(connectedAt: string): boolean {
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= DAEMON_HELLO_TIMEOUT_MS;
}

function sanitizeMetadataText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(UNSAFE_DISPLAY_CONTROLS, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}


function sanitizeDaemonTools(value: unknown, policy: Record<string, unknown>): string[] {
  if (!Array.isArray(value)) return [];
  const definitions = new Map(allCatalogTools.map((tool) => [tool.name, tool]));
  return [...new Set(value.filter((item): item is string => {
    if (typeof item !== "string" || item === "server_info") return false;
    const definition = definitions.get(item);
    return Boolean(definition && daemonPolicyAllows(definition.availability, policy));
  }))];
}

function daemonPolicyAllows(availability: unknown, policy: Record<string, unknown>): boolean {
  if (availability === "always") return true;
  if (availability === "write") return policy.allowWrite === true;
  if (availability === "direct-exec") return policy.execMode === "direct" || policy.execMode === "shell";
  if (availability === "shell-exec") return policy.execMode === "shell";
  if (availability === "full") return policy.profile === "full"
    && policy.allowWrite === true
    && policy.execMode === "shell"
    && policy.unrestrictedPaths === true
    && policy.minimalEnv === false
    && policy.exposeAbsolutePaths === true;
  return false;
}

function sanitizeDaemonPolicy(value: unknown): Record<string, unknown> {
  const policy = asObject(value);
  const execMode = policy.execMode === "shell" || policy.execMode === "direct" ? policy.execMode : "off";
  const origin = sanitizeMetadataText(policy.origin, 32);
  const revision = Number.isInteger(policy.revision) && Number(policy.revision) > 0
    ? Math.min(Number(policy.revision), 1_000_000)
    : 1;
  return {
    profile: sanitizeMetadataText(policy.profile, 32) ?? "custom",
    origin: ["default", "explicit", "custom", "migrated", "legacy-preserved"].includes(origin ?? "") ? origin : "custom",
    revision,
    allowWrite: policy.allowWrite === true,
    allowExec: execMode !== "off",
    execMode,
    unrestrictedPaths: policy.unrestrictedPaths === true,
    minimalEnv: policy.minimalEnv !== false,
    exposeAbsolutePaths: policy.exposeAbsolutePaths === true,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function baseUrl(request: Request): string {
  return new URL(request.url).origin;
}

function bearerToken(request: Request): string {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

async function parseJsonRequest(request: Request, limit: number): Promise<unknown> {
  const text = await readBoundedText(request, limit);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

async function parseRequestBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBoundedText(request, limit);
  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "bad_request", "JSON body must be an object");
    return parsed as Record<string, unknown>;
  }
  return searchParamsObject(new URLSearchParams(text));
}


async function readBoundedText(request: Request, limit: number): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > limit) throw new HttpError(413, "request_body_too_large", `request body exceeds ${limit} bytes`);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(413, "request_body_too_large", `request body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new HttpError(400, "invalid_encoding", "Request body must be valid UTF-8");
  }
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

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : Number.parseInt(String(value ?? ""), 10);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.min(Math.max(Math.floor(safe), min), max);
}

function daemonToolTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name !== "exec_command" && name !== "run_process") return 60_000;
  const seconds = clampNumber(args.timeout_seconds, 120, 1, 600);
  return Math.min((seconds + 5) * 1000, 610_000);
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

function clientRequestKey(authorized: AuthorizedToken, requestId: unknown): string | undefined {
  if (requestId === null || (typeof requestId !== "string" && typeof requestId !== "number")) return undefined;
  return `${authorized.tokenKey}:${typeof requestId}:${String(requestId)}`;
}

function validateAuthorizationRequest(
  body: Record<string, unknown>,
  base: string,
  store: OAuthStore,
): { value: ValidatedAuthorization } | { error: string; status: number } {
  const responseType = String(body.response_type ?? "");
  const clientId = String(body.client_id ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeChallenge = String(body.code_challenge ?? "");
  const codeChallengeMethod = String(body.code_challenge_method ?? "");
  const requestedResource = String(body.resource ?? `${base}/mcp`);
  const scope = String(body.scope ?? SERVER_NAME).trim();
  const state = body.state === undefined ? "" : typeof body.state === "string" ? body.state : "";

  if (responseType !== "code") return { error: "response_type must be code.", status: 400 };
  if (requestedResource !== `${base}/mcp`) return { error: "resource mismatch.", status: 400 };
  if (scope !== SERVER_NAME) return { error: "unsupported scope.", status: 400 };
  if (body.state !== undefined && typeof body.state !== "string") return { error: "state must be a string.", status: 400 };
  if (state.length > 1024) return { error: "state is too long.", status: 400 };
  if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return { error: "A valid PKCE S256 challenge is required.", status: 400 };
  }
  const client = store.clients[clientId];
  if (!client) return { error: "Unknown OAuth client.", status: 400 };
  if (!client.redirect_uris.includes(redirectUri)) return { error: "redirect_uri is not registered.", status: 400 };
  return { value: { client, clientId, redirectUri, codeChallenge, requestedResource, scope, state } };
}

function pruneClientRecordByExpiry<T extends { client_id: string; expires_at: number }>(record: Record<string, T>, clientId: string, keep: number): void {
  const allowed = new Set(Object.entries(record)
    .filter(([, value]) => value.client_id === clientId)
    .sort((left, right) => right[1].expires_at - left[1].expires_at)
    .slice(0, keep)
    .map(([key]) => key));
  for (const [key, value] of Object.entries(record)) {
    if (value.client_id === clientId && !allowed.has(key)) delete record[key];
  }
}

function pruneRecordByExpiry<T extends { expires_at: number }>(record: Record<string, T>, keep: number): void {
  const allowed = new Set(Object.entries(record)
    .sort((left, right) => right[1].expires_at - left[1].expires_at)
    .slice(0, keep)
    .map(([key]) => key));
  for (const key of Object.keys(record)) if (!allowed.has(key)) delete record[key];
}

async function authorizationIdentity(request: Request, keyMaterial: string): Promise<string> {
  const source = (request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 128);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(source));
  return `hmac-sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function recordAuthorizationFailure(store: OAuthStore, identity: string, now: number): void {
  const current = store.auth_failures[identity];
  const activeWindow = current && current.window_started + AUTH_FAILURE_WINDOW_SECONDS > now;
  const count = activeWindow ? current.count + 1 : 1;
  store.auth_failures[identity] = {
    count,
    window_started: activeWindow ? current.window_started : now,
    blocked_until: count >= AUTH_FAILURE_LIMIT ? now + AUTH_BLOCK_SECONDS : 0,
    last_attempt: now,
  };
}

function pruneAuthFailures(store: OAuthStore, keep: number): void {
  const allowed = new Set(Object.entries(store.auth_failures)
    .sort((left, right) => right[1].last_attempt - left[1].last_attempt)
    .slice(0, keep)
    .map(([key]) => key));
  for (const key of Object.keys(store.auth_failures)) if (!allowed.has(key)) delete store.auth_failures[key];
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64Url(bytes)}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return diff === 0;
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function normalizeRedirectUri(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:" && url.hostname) return url.toString();
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

function corsPreflight(request: Request, base: string, configured: string): Response {
  const origin = request.headers.get("Origin") ?? "";
  if (!isConfiguredOrSameOrigin(origin, base, configured)) return json({ error: "origin_not_allowed" }, 403);
  const requestedMethod = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (requestedMethod && !["GET", "POST"].includes(requestedMethod)) return methodNotAllowed("GET, POST, OPTIONS");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

function applyCors(response: Response, request: Request, base: string, configured: string): Response {
  if (response.status === 101) return response;
  const origin = request.headers.get("Origin") ?? "";
  if (!origin || !isConfiguredOrSameOrigin(origin, base, configured)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "www-authenticate, mcp-session-id");
  appendVary(headers, "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  const values = new Set((existing ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function isConfiguredOrSameOrigin(origin: string, base: string, configured: string): boolean {
  if (isDefaultAllowedOrigin(origin, base)) return true;
  const allowed = configured.split(",").map((item) => item.trim()).filter((item) => item && item !== "null");
  return allowed.includes(origin);
}

function validateOrigin(request: Request, base: string, configured = ""): boolean {
  const origin = request.headers.get("Origin");
  return !origin || isConfiguredOrSameOrigin(origin, base, configured);
}

function isDefaultAllowedOrigin(origin: string, base: string): boolean {
  try {
    return new URL(origin).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function searchParamsEntries(params: URLSearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  return entries;
}

function searchParamsObject(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  params.forEach((value, key) => {
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) (out[key] as string[]).push(value);
    else out[key] = [out[key] as string, value];
  });
  return out;
}

function normalizeDisplayText(value: string, maxLength: number, fallback = "MCP Client"): string {
  const normalized = value.replace(UNSAFE_DISPLAY_CONTROLS, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, maxLength);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function workerErrorClass(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return error.name.replace(/[^A-Za-z0-9_-]/g, "_").toLowerCase().slice(0, 64) || "error";
  return "unknown_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
