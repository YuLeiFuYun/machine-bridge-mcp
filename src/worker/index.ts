import { DurableObject } from "cloudflare:workers";

const SERVER_NAME = "machine-bridge-mcp";
const SERVER_VERSION = "0.2.5";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const JSONRPC_VERSION = "2.0";
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

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

interface AuthenticatedClient {
  clientId: string;
  scope: string;
  resource: string;
}

interface OAuthStore {
  clients: Record<string, OAuthClient>;
  codes: Record<string, OAuthCode>;
  tokens: Record<string, OAuthToken>;
}

interface DaemonAttachment {
  role: "daemon";
  connectedAt: string;
  daemonId: string;
  workspaceHash?: string;
  workspaceName?: string;
  policy?: Record<string, unknown>;
  tools?: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  streamId?: string;
}

interface McpClientState {
  clientId: string;
  initializedAt: string;
  capabilities: Record<string, unknown>;
  clientInfo?: Record<string, unknown>;
}

interface McpClientStream {
  id: string;
  clientId: string;
  connectedAt: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

const serverInfoTool = {
  name: "server_info",
  description: "Return bridge metadata, OAuth endpoint details, daemon connection status, and available tools.",
  inputSchema: { type: "object", additionalProperties: true },
} as const;

const workspaceTools = [
  {
    name: "project_overview",
    description: "Summarize the connected local workspace and daemon policy.",
    inputSchema: { type: "object", additionalProperties: true },
  },
  {
    name: "list_roots",
    description: "List workspace roots exposed by the local daemon.",
    inputSchema: { type: "object", additionalProperties: true },
  },
  {
    name: "list_dir",
    description: "List direct children of a workspace directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
      additionalProperties: true,
    },
  },
  {
    name: "list_files",
    description: "Recursively list files under a workspace path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "." },
        max_files: { type: "integer", minimum: 1, maximum: 10000, default: 1000 },
      },
      additionalProperties: true,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file. Relative paths use the daemon workspace; absolute paths and parent-directory paths are allowed. Sensitive files are not hidden by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576 },
      },
      required: ["path"],
      additionalProperties: true,
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file. Relative paths use the daemon workspace; absolute paths and parent-directory paths are allowed. Enabled by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        create_only: { type: "boolean", default: false },
        expected_sha256: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: true,
    },
  },
  {
    name: "search_text",
    description: "Search plain text files under a workspace path for a substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", default: "." },
        max_matches: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        max_files: { type: "integer", minimum: 1, maximum: 100000, default: 10000 },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "git_status",
    description: "Run git status --short in the local workspace.",
    inputSchema: { type: "object", additionalProperties: true },
  },
  {
    name: "git_diff",
    description: "Run git diff for the local workspace and return bounded output.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "." },
        max_bytes: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576 },
      },
      additionalProperties: true,
    },
  },
  {
    name: "exec_command",
    description: "Execute a shell command with cwd set to the daemon workspace. Enabled by default; environment is intentionally minimal unless the daemon is started with full env.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 120 },
      },
      required: ["command"],
      additionalProperties: true,
    },
  },
] as const;

const MCP_INSTRUCTIONS = [
  "You are connected to a local workspace through machine-bridge-mcp.",
  "The Worker is only a relay. File and command operations run on the user's local daemon.",
  "Relative paths use the configured workspace as cwd; absolute paths and parent-directory paths are allowed by default.",
  "Writes and shell execution are enabled by default in this bridge for ease of use.",
  "Prefer inspecting files before editing, make minimal changes, and report commands you ran.",
].join("\n");

export class BridgeRoom extends DurableObject<BridgeEnv> {
  private readonly pending = new Map<string, PendingCall>();
  private readonly pendingClientRequests = new Map<string, PendingCall>();
  private readonly mcpClients = new Map<string, McpClientState>();
  private readonly mcpClientStreams = new Map<string, McpClientStream>();

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const base = baseUrl(request);
    try {
      if (!validateOrigin(request, base, this.env.MBM_ALLOWED_ORIGINS)) {
        return json({ error: "origin_not_allowed" }, 403);
      }

      if (url.pathname === "/" && request.method === "GET") {
        return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, mcp: `${base}/mcp`, daemon: this.daemonStatus(false), mcp_clients: this.mcpClientStatus(false) });
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, daemon: this.daemonStatus(false), mcp_clients: this.mcpClientStatus(false) });
      }
      if (url.pathname === "/.well-known/mcp.json") {
        return json(this.mcpMetadata(base));
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/openid-configuration/mcp"
      ) {
        return json(this.authorizationServerMetadata(base));
      }
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(this.protectedResourceMetadata(base));
      }
      if (url.pathname === "/oauth/register" && request.method === "POST") return await this.registerClient(request);
      if (url.pathname === "/oauth/authorize" && request.method === "GET") return this.authorizePage(request, base);
      if (url.pathname === "/oauth/authorize" && request.method === "POST") return await this.authorizeSubmit(request, base);
      if (url.pathname === "/oauth/token" && request.method === "POST") return await this.exchangeToken(request, base);
      if (url.pathname === "/daemon/ws") return await this.acceptDaemonWebSocket(request);
      if (url.pathname === "/mcp") return await this.handleMcp(request, base);
      if (url.pathname === "/api/daemon/status") return json(this.daemonStatus(false));
      if (url.pathname === "/api/mcp/sampling") return await this.handleSamplingApi(request);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
      console.error(JSON.stringify({ level: "error", message: "request_failed", path: url.pathname, error: errorMessage(error) }));
      return json({ error: "internal_server_error" }, 500);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }

    if (body.type === "hello") {
      const attachment = this.daemonAttachment(ws);
      if (attachment) {
        ws.serializeAttachment({
          ...attachment,
          workspaceHash: stringOrUndefined(body.workspace_hash) ?? attachment.workspaceHash,
          workspaceName: stringOrUndefined(body.workspace_name) ?? attachment.workspaceName,
          policy: asObject(body.policy),
          tools: Array.isArray(body.tools) ? body.tools.filter((item): item is string => typeof item === "string") : attachment.tools,
        });
      }
      ws.send(JSON.stringify({ type: "hello_ack", server: SERVER_NAME, version: SERVER_VERSION }));
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
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(body.id);
    if (body.ok === false) pending.reject(new Error(errorMessage(body.error)));
    else pending.resolve(body.result);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.daemonAttachment(ws);
    if (attachment?.role !== "daemon") return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("daemon disconnected"));
      this.pending.delete(id);
    }
  }

  private async handleMcp(request: Request, base: string): Promise<Response> {
    if (request.method === "DELETE") return new Response(null, { status: 405 });
    if (request.method !== "POST" && request.method !== "GET") return json({ error: "mcp endpoint expects POST JSON-RPC or GET SSE" }, 405);

    const auth = await this.verifyAccessToken(bearerToken(request), base);
    if (!auth) {
      return new Response("OAuth bearer token required", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` },
      });
    }

    if (request.method === "GET") return this.openMcpSseStream(request, auth);

    const body = await parseJsonRequest(request, this.bodyLimitBytes());
    if (isJsonRpcResponse(body)) {
      this.handleClientJsonRpcResponse(body);
      return new Response(null, { status: 202 });
    }
    if (!isJsonRpcRequest(body)) return json(rpcError(null, -32600, "Invalid JSON-RPC request"), 400);
    const response = await this.dispatchJsonRpc(body, base, auth);
    if (response === null) return new Response(null, { status: 202 });
    return json(response);
  }

  private async dispatchJsonRpc(request: JsonRpcRequest, base: string, auth: AuthenticatedClient): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") {
      this.recordClientInitialize(auth, request.params);
      return rpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    if (request.method === "notifications/initialized") return null;
    if (request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") return rpcResult(request.id, { tools: this.allTools() });
    if (request.method === "tools/call") {
      const params = asObject(request.params);
      const name = requiredString(params, "name");
      const args = asObject(params.arguments);
      try {
        const result = await this.callTool(name, args, base);
        return rpcResult(request.id, textToolResult(result));
      } catch (error) {
        return rpcResult(request.id, textToolResult({ error: errorMessage(error) }, true));
      }
    }
    return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }

  private async callTool(name: string, args: Record<string, unknown>, base: string): Promise<unknown> {
    if (name === "server_info") {
      return {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_url: `${base}/mcp`,
        oauth: this.authorizationServerMetadata(base),
        daemon: this.daemonStatus(true),
        mcp_clients: this.mcpClientStatus(true),
        tools: this.allTools().map((tool) => tool.name),
      };
    }
    if (workspaceTools.some((tool) => tool.name === name)) {
      if (!this.daemonToolEnabled(name)) throw new Error(`tool disabled by local daemon policy: ${name}`);
      return this.callDaemonTool(name, args);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async callDaemonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const socket = this.daemonSockets()[0];
    if (!socket) throw new Error("local daemon is not connected; keep the CLI start command running");
    const id = randomToken("call");
    const timeoutMs = daemonToolTimeoutMs(name, args);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon tool timed out: ${name}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "tool_call", id, tool: name, arguments: args, timeout_ms: timeoutMs }));
    });
  }

  private async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const expected = this.env.DAEMON_SHARED_SECRET ?? "";
    const supplied = request.headers.get("X-Bridge-Token") ?? "";
    if (!expected || !(await safeEqual(supplied, expected))) return new Response("Unauthorized daemon", { status: 401 });

    for (const socket of this.daemonSockets()) {
      try {
        socket.close(1012, "replaced by newer daemon");
      } catch {
        // Ignore stale sockets.
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: "daemon",
      connectedAt: new Date().toISOString(),
      daemonId: request.headers.get("X-Daemon-Id") || randomToken("daemon"),
    } satisfies DaemonAttachment);
    server.send(JSON.stringify({ type: "welcome", server: SERVER_NAME, version: SERVER_VERSION }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSamplingApi(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed", message: "POST required" }, 405);
    const expected = this.env.DAEMON_SHARED_SECRET ?? "";
    const supplied = request.headers.get("X-Bridge-Token") ?? "";
    if (!expected || !(await safeEqual(supplied, expected))) return json({ error: "unauthorized", message: "Unauthorized local API bridge request" }, 401);

    const body = await parseRequestBody(request, this.bodyLimitBytes());
    const timeoutMs = clampNumber(body.timeout_ms ?? body.timeoutMs, 180_000, 1_000, 600_000);
    const params = samplingParamsFromApiBody(body);
    const result = await this.requestClientSampling(params, timeoutMs);
    return json({ ok: true, result });
  }

  private openMcpSseStream(request: Request, auth: AuthenticatedClient): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const streamId = randomToken("mcp_stream");
    const stream: McpClientStream = {
      id: streamId,
      clientId: auth.clientId,
      connectedAt: Date.now(),
      writer,
      heartbeat: setInterval(() => {
        void writeSseComment(writer, `keepalive ${Date.now()}`).catch(() => this.closeMcpClientStream(streamId));
      }, 25_000),
    };
    this.mcpClientStreams.set(streamId, stream);
    request.signal.addEventListener("abort", () => this.closeMcpClientStream(streamId), { once: true });
    void writeSseComment(writer, `${SERVER_NAME} connected`).catch(() => this.closeMcpClientStream(streamId));
    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }

  private closeMcpClientStream(streamId: string): void {
    const stream = this.mcpClientStreams.get(streamId);
    if (!stream) return;
    this.mcpClientStreams.delete(streamId);
    clearInterval(stream.heartbeat);
    for (const [id, pending] of this.pendingClientRequests) {
      if (pending.streamId !== streamId) continue;
      clearTimeout(pending.timeout);
      this.pendingClientRequests.delete(id);
      pending.reject(new HttpError(
        409,
        "mcp_client_stream_closed",
        "The MCP client server-to-client stream closed before it answered sampling/createMessage. Reconnect ChatGPT to the MCP Server URL and retry."
      ));
    }
    try {
      void stream.writer.close();
    } catch {
      // Ignore already-closed streams.
    }
  }

  private async requestClientSampling(params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const streams = [...this.mcpClientStreams.values()].sort((left, right) => right.connectedAt - left.connectedAt);
    if (!streams.length) {
      throw new HttpError(
        409,
        "mcp_client_stream_missing",
        "No MCP client has an open server-to-client stream. Connect ChatGPT to the printed MCP Server URL and keep a client stream open so this bridge can send sampling/createMessage requests."
      );
    }

    const capableStreams = streams.filter((stream) => this.clientSupportsSampling(stream.clientId));
    if (!capableStreams.length) {
      throw new HttpError(
        501,
        "mcp_sampling_not_supported",
        "A ChatGPT MCP client stream is connected, but the client did not advertise the MCP sampling capability. This local /v1 API requires a client that can receive sampling/createMessage requests."
      );
    }

    const request: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: randomToken("sampling"),
      method: "sampling/createMessage",
      params,
    };
    return this.sendClientRequest(capableStreams[0], request, timeoutMs);
  }

  private async sendClientRequest(stream: McpClientStream, request: JsonRpcRequest, timeoutMs: number): Promise<unknown> {
    const id = String(request.id);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingClientRequests.delete(id);
        reject(new HttpError(
          504,
          "mcp_sampling_timeout",
          "Timed out waiting for the MCP client to answer sampling/createMessage. Check that ChatGPT is still connected and that the sampling request was approved."
        ));
      }, timeoutMs);
      this.pendingClientRequests.set(id, { resolve, reject, timeout, streamId: stream.id });
      void writeSseJson(stream.writer, request, id).catch((error) => {
        clearTimeout(timeout);
        this.pendingClientRequests.delete(id);
        this.closeMcpClientStream(stream.id);
        reject(new HttpError(409, "mcp_client_stream_unavailable", `MCP client stream is not writable: ${errorMessage(error)}`));
      });
    });
  }

  private handleClientJsonRpcResponse(response: unknown): void {
    const candidate = response as Record<string, unknown>;
    const id = String(candidate.id ?? "");
    if (!id) return;
    const pending = this.pendingClientRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingClientRequests.delete(id);
    if ("error" in candidate) {
      pending.reject(new HttpError(
        502,
        "mcp_sampling_client_error",
        `MCP client returned an error for sampling/createMessage: ${jsonRpcErrorMessage(candidate.error)}`
      ));
    }
    else pending.resolve(candidate.result);
  }

  private recordClientInitialize(auth: AuthenticatedClient, params: unknown): void {
    const body = asObject(params);
    const meta = asObject(body._meta);
    const directCapabilities = asObject(body.capabilities);
    const metaCapabilities = asObject(meta["io.modelcontextprotocol/clientCapabilities"]);
    const capabilities = Object.keys(directCapabilities).length ? directCapabilities : metaCapabilities;
    this.mcpClients.set(auth.clientId, {
      clientId: auth.clientId,
      initializedAt: new Date().toISOString(),
      capabilities,
      clientInfo: asObject(body.clientInfo),
    });
  }

  private clientSupportsSampling(clientId: string): boolean {
    const capabilities = this.mcpClients.get(clientId)?.capabilities;
    return Boolean(capabilities && Object.prototype.hasOwnProperty.call(capabilities, "sampling"));
  }

  private mcpClientStatus(detail: boolean): Record<string, unknown> {
    const streams = [...this.mcpClientStreams.values()];
    const samplingCapableClientIds = new Set([...this.mcpClients.values()].filter((client) => Object.prototype.hasOwnProperty.call(client.capabilities, "sampling")).map((client) => client.clientId));
    const base = {
      stream_count: streams.length,
      initialized_count: this.mcpClients.size,
      sampling_capable_count: samplingCapableClientIds.size,
    };
    if (!detail) return base;
    return {
      ...base,
      streams: streams.map((stream) => ({
        id: stream.id,
        client_id: stream.clientId,
        connected_at: new Date(stream.connectedAt).toISOString(),
        sampling_capable: samplingCapableClientIds.has(stream.clientId),
      })),
    };
  }

  private allTools(): Array<Record<string, unknown>> {
    const advertised = this.daemonAdvertisedTools();
    const localTools = advertised
      ? workspaceTools.filter((tool) => advertised.has(tool.name))
      : workspaceTools;
    return [serverInfoTool, ...localTools].map((tool) => ({ ...tool }));
  }

  private daemonToolEnabled(name: string): boolean {
    const advertised = this.daemonAdvertisedTools();
    return !advertised || advertised.has(name);
  }

  private daemonAdvertisedTools(): Set<string> | null {
    const socket = this.daemonSockets()[0];
    const attachment = socket ? this.daemonAttachment(socket) : undefined;
    if (!attachment?.tools?.length) return null;
    return new Set(attachment.tools);
  }

  private daemonSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = this.daemonAttachment(socket);
      return attachment?.role === "daemon" && socket.readyState === WebSocket.OPEN;
    });
  }

  private daemonAttachment(socket: WebSocket): DaemonAttachment | undefined {
    const raw = socket.deserializeAttachment();
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as Partial<DaemonAttachment>;
    return candidate.role === "daemon" ? (candidate as DaemonAttachment) : undefined;
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
      workspace_hash: attachment?.workspaceHash ?? null,
      workspace_name: attachment?.workspaceName ?? null,
      policy: attachment?.policy ?? null,
      tools,
    };
  }

  private mcpMetadata(base: string): Record<string, unknown> {
    return {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: { type: "streamable-http", url: `${base}/mcp` },
      auth: { type: "oauth" },
      tools: this.allTools().map((tool) => tool.name),
      instructions: MCP_INSTRUCTIONS,
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
    const store = (await this.ctx.storage.get<OAuthStore>("oauth")) ?? { clients: {}, codes: {}, tokens: {} };
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
    if (changed) await this.ctx.storage.put("oauth", store);
    return store;
  }

  private async registerClient(request: Request): Promise<Response> {
    const body = await parseRequestBody(request, this.bodyLimitBytes());
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array" }, 400);
    }
    if (redirectUris.length > 20) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must contain at most 20 entries" }, 400);
    }
    const normalized = redirectUris.map((item) => String(item));
    if (normalized.some((item) => item.length > 2048)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uri is too long" }, 400);
    }
    if (!normalized.every(isAllowedRedirectUri)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be https or local http" }, 400);
    }

    const store = await this.oauthStore();
    const client: OAuthClient = {
      client_id: randomToken("mcp_client"),
      client_name: (stringOrUndefined(body.client_name) ?? "MCP Client").slice(0, 128),
      redirect_uris: normalized,
      created_at: Math.floor(Date.now() / 1000),
    };
    store.clients[client.client_id] = client;
    pruneOAuthClients(store, 100);
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
  }

  private authorizePage(request: Request, base: string, error = "", submitted?: Record<string, unknown>): Response {
    const url = new URL(request.url);
    const sourceEntries = submitted ? Object.entries(submitted) : searchParamsEntries(url.searchParams);
    const hidden = sourceEntries
      .filter(([key]) => key !== "login_token")
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
      .join("\n");
    const resource = String(submitted?.resource ?? url.searchParams.get("resource") ?? `${base}/mcp`);
    const errorBlock = error ? `<p style="color:#b91c1c">${escapeHtml(error)}</p>` : "";
    return html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorize ${SERVER_NAME}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorize ${SERVER_NAME}</h1>
    <p>Enter the MCP connection password printed by <code>machine-bridge-mcp start</code>.</p>
    <p><strong>Resource:</strong> <code>${escapeHtml(resource)}</code></p>
    ${errorBlock}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Connection password<br><input name="login_token" type="password" autofocus style="width: 100%; box-sizing: border-box; padding: 8px;"></label>
      <p><button type="submit">Authorize</button></p>
    </form>
  </body>
</html>`);
  }

  private async authorizeSubmit(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, this.bodyLimitBytes());
    const expectedLogin = this.env.MCP_OAUTH_PASSWORD ?? "";
    if (!expectedLogin || !(await safeEqual(String(body.login_token ?? ""), expectedLogin))) {
      return this.authorizePage(request, base, "Invalid connection password.", body);
    }

    const responseType = String(body.response_type ?? "");
    const clientId = String(body.client_id ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const codeChallenge = String(body.code_challenge ?? "");
    const codeChallengeMethod = String(body.code_challenge_method ?? "");
    const requestedResource = String(body.resource ?? `${base}/mcp`);

    if (responseType !== "code") return this.authorizePage(request, base, "response_type must be code.", body);
    if (requestedResource !== `${base}/mcp`) return this.authorizePage(request, base, "resource mismatch.", body);
    if (codeChallengeMethod !== "S256" || !codeChallenge) return this.authorizePage(request, base, "PKCE S256 is required.", body);

    const store = await this.oauthStore();
    const client = store.clients[clientId];
    if (!client) return this.authorizePage(request, base, "Unknown OAuth client.", body);
    if (!client.redirect_uris.includes(redirectUri)) return this.authorizePage(request, base, "redirect_uri is not registered.", body);

    const code = randomToken("mcp_code");
    store.codes[code] = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      scope: String(body.scope ?? SERVER_NAME),
      resource: requestedResource,
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    await this.ctx.storage.put("oauth", store);

    const params = new URLSearchParams({ code });
    if (typeof body.state === "string" && body.state) params.set("state", body.state);
    return Response.redirect(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${params.toString()}`, 302);
  }

  private async exchangeToken(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, this.bodyLimitBytes());
    if (String(body.grant_type ?? "") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);

    const code = String(body.code ?? "");
    const verifier = String(body.code_verifier ?? "");
    const store = await this.oauthStore();
    const record = store.codes[code];
    delete store.codes[code];
    if (!record) {
      await this.ctx.storage.put("oauth", store);
      return json({ error: "invalid_grant" }, 400);
    }
    if (String(body.client_id ?? "") !== record.client_id || String(body.redirect_uri ?? "") !== record.redirect_uri) {
      await this.ctx.storage.put("oauth", store);
      return json({ error: "invalid_grant", error_description: "client or redirect mismatch" }, 400);
    }
    if (String(body.resource ?? record.resource) !== record.resource) {
      await this.ctx.storage.put("oauth", store);
      return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
    }
    if (!(await safeEqual(await pkceS256(verifier), record.code_challenge))) {
      await this.ctx.storage.put("oauth", store);
      return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
    }

    const accessToken = randomToken("mcp_at");
    store.tokens[`sha256:${await sha256Hex(accessToken)}`] = {
      client_id: record.client_id,
      scope: record.scope,
      resource: `${base}/mcp`,
      version: this.env.OAUTH_TOKEN_VERSION ?? "",
      expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    };
    await this.ctx.storage.put("oauth", store);
    return json({ access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: record.scope });
  }

  private async verifyAccessToken(token: string, base: string): Promise<AuthenticatedClient | null> {
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
    return { clientId: record.client_id, scope: record.scope, resource: record.resource };
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
  return candidate.jsonrpc === JSONRPC_VERSION && typeof candidate.method === "string";
}

function isJsonRpcResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSONRPC_VERSION || !("id" in candidate) || typeof candidate.method === "string") return false;
  return "result" in candidate || "error" in candidate;
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> | null {
  if (id === undefined) return null;
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message } };
}

function textToolResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function samplingParamsFromApiBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, "invalid_sampling_request", "sampling/createMessage requires a non-empty messages array");
  }
  const maxTokens = Number(body.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new HttpError(400, "invalid_sampling_request", "sampling/createMessage requires maxTokens");
  }
  const params = { ...body };
  delete params.timeout_ms;
  delete params.timeoutMs;
  return params;
}

async function writeSseJson(writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown, id?: string): Promise<void> {
  const lines = [];
  if (id) lines.push(`id: ${sseLine(id)}`);
  lines.push("event: message");
  for (const line of JSON.stringify(value).split(/\r?\n/)) lines.push(`data: ${line}`);
  lines.push("", "");
  await writer.write(new TextEncoder().encode(lines.join("\n")));
}

async function writeSseComment(writer: WritableStreamDefaultWriter<Uint8Array>, value: string): Promise<void> {
  await writer.write(new TextEncoder().encode(`: ${sseLine(value)}\n\n`));
}

function sseLine(value: string): string {
  return value.replaceAll("\r", " ").replaceAll("\n", " ");
}

function jsonRpcErrorMessage(error: unknown): string {
  const value = asObject(error);
  const message = typeof value.message === "string" && value.message ? value.message : "MCP client returned an error";
  const code = value.code === undefined ? "" : ` (${String(value.code)})`;
  return `${message}${code}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function html(value: string, status = 200): Response {
  return new Response(value, { status, headers: { "content-type": "text/html; charset=utf-8" } });
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
  return new TextDecoder().decode(combined);
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
  if (name !== "exec_command") return 60_000;
  const seconds = clampNumber(args.timeout_seconds, 120, 1, 600);
  return Math.min((seconds + 5) * 1000, 610_000);
}

function pruneOAuthClients(store: OAuthStore, keep: number): void {
  const clients = Object.values(store.clients).sort((a, b) => b.created_at - a.created_at);
  const allowed = new Set(clients.slice(0, keep).map((client) => client.client_id));
  for (const clientId of Object.keys(store.clients)) if (!allowed.has(clientId)) delete store.clients[clientId];
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

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function validateOrigin(request: Request, base: string, configured = ""): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (isDefaultAllowedOrigin(origin, base)) return true;
  const allowed = configured.split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function isDefaultAllowedOrigin(origin: string, base: string): boolean {
  try {
    const parsed = new URL(origin);
    if (origin === base) return true;
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
