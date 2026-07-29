import type { AuthorizedToken } from "./oauth-controller.ts";
import { publicWorkerToolError } from "./errors.ts";
import { legacyMcpClientRequestKey } from "./mcp-session.ts";
import { inspectWorkerToolCall } from "./mcp-tool-call-input.ts";
import {
  asObject, rpcError, rpcResult, sessionInstructionText, textToolResult,
  type JsonRpcRequest,
} from "./mcp-jsonrpc.ts";

type LegacyMcpConfig = Readonly<{
  defaultVersion: string;
  supportedVersions: readonly string[];
  serverInfo: Record<string, unknown>;
  instructions: string;
  daemonToolEnabled: (name: string) => boolean;
  callDaemonTool: (name: string, args: Record<string, unknown>, authorized: AuthorizedToken) => Promise<unknown>;
  recordError: (code: string) => void;
  cancelClientRequest: (requestKey?: string) => Promise<void>;
  tools: (authorized: AuthorizedToken) => Array<Record<string, unknown>>;
  callTool: (input: {
    name: string;
    args: Record<string, unknown>;
    base: string;
    authorized: AuthorizedToken;
    requestKey?: string;
  }) => Promise<unknown>;
}>;

export class LegacyMcpDispatcher {
  private readonly config: LegacyMcpConfig;

  constructor(config: LegacyMcpConfig) {
    this.config = config;
  }

  async dispatch(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    if (request.method === "initialize") return this.initialize(request, authorized);
    if (request.method === "notifications/initialized") return null;
    if (request.method === "notifications/cancelled") {
      await this.config.cancelClientRequest(legacyMcpClientRequestKey(
        authorized.tokenKey, sessionId, asObject(request.params).requestId,
      ));
      return null;
    }
    if (request.method === "logging/setLevel" || request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") return rpcResult(request.id, { tools: this.config.tools(authorized) });
    if (request.method === "tools/call") return this.callTool(request, base, authorized, sessionId);
    return rpcError(request.id, -32601, "Method not found");
  }

  private async initialize(request: JsonRpcRequest, authorized: AuthorizedToken): Promise<Record<string, unknown> | null> {
    const requested = asObject(request.params).protocolVersion;
    const protocolVersion = typeof requested === "string" && this.config.supportedVersions.includes(requested)
      ? requested
      : this.config.defaultVersion;
    let bootstrap = null;
    if (this.config.daemonToolEnabled("session_bootstrap")) {
      try { bootstrap = await this.config.callDaemonTool("session_bootstrap", { path: "." }, authorized); }
      catch { this.config.recordError("session_bootstrap_failed"); }
    }
    const localInstructions = sessionInstructionText(bootstrap);
    return rpcResult(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: this.config.serverInfo,
      instructions: localInstructions
        ? `${this.config.instructions}\n\n--- LOCAL SESSION INSTRUCTIONS ---\n${localInstructions}`
        : this.config.instructions,
    });
  }

  private async callTool(
    request: JsonRpcRequest,
    base: string,
    authorized: AuthorizedToken,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    if (request.id === undefined || request.id === null) {
      return rpcError(null, -32600, "tools/call requires a non-null request id");
    }
    const inspected = inspectWorkerToolCall(request.params, this.config.tools(authorized));
    if (!inspected.ok) {
      const message = inspected.reason === "missing_name" ? "tools/call requires a tool name"
        : inspected.reason === "unknown_tool" ? "Unknown tool"
          : "Tool arguments do not match the input schema";
      return rpcError(request.id, -32602, message, inspected.issues ? { side_effects_started: false, validation_issues: [...inspected.issues] } : undefined);
    }
    const { name, args } = inspected;
    try {
      const result = await this.config.callTool({
        name, args, base, authorized,
        requestKey: legacyMcpClientRequestKey(authorized.tokenKey, sessionId, request.id),
      });
      return rpcResult(request.id, textToolResult(result))!;
    } catch (error) {
      return rpcResult(request.id, textToolResult({ error: publicWorkerToolError(error) }, true))!;
    }
  }
}
