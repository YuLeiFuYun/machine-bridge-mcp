import type { AuthorizedToken } from "./access.ts";
import type { McpController } from "./mcp-controller.ts";
import { validateHttpRequestMedia, validateOptionalCompatibilityMirrors, McpHttpContractError } from "./mcp-http-contract.ts";
import type { JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { asObject, rpcError, rpcResult } from "./mcp-jsonrpc.ts";
import { json } from "./http.ts";
import { MCP_INITIALIZATION_COMPATIBILITY_VERSIONS } from "./worker-mcp-config.ts";
export { MCP_INITIALIZATION_COMPATIBILITY_VERSIONS } from "./worker-mcp-config.ts";

const COMPATIBILITY_VERSIONS = new Set(MCP_INITIALIZATION_COMPATIBILITY_VERSIONS);
const LEGACY_METHODS = new Set([
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

type CompatibilityInput = {
  request: Request;
  body: JsonRpcRequest;
  base: string;
  authorized: AuthorizedToken;
  controller: McpController;
  capabilities: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  instructions: string;
  tools: readonly { name: string; inputSchema?: unknown }[];
};

export async function initializationCompatibilityResponse(input: CompatibilityInput): Promise<Response | null> {
  const version = compatibilityVersion(input.request, input.body);
  if (!version) return null;
  validateHttpRequestMedia(input.request.headers);
  rejectRemovedSessionHeader(input.request.headers);
  validateOptionalCompatibilityMirrors({ headers: input.request.headers, body: input.body, tools: input.tools });

  if (input.body.method === "initialize") return initializeResponse(input, version);
  validateDeclaredVersion(input.request.headers, version);
  if (!LEGACY_METHODS.has(input.body.method)) {
    return json(rpcError(input.body.id, -32601, "Method not found"), 404);
  }
  if (input.body.method === "notifications/initialized") {
    if (input.body.id !== undefined) {
      return json(rpcError(input.body.id, -32600, "notifications/initialized must be a notification"), 400);
    }
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  if (input.body.method === "ping") {
    if (input.body.id === undefined || input.body.id === null) {
      return json(rpcError(input.body.id, -32600, "ping requires a non-null request id"), 400);
    }
    return json(rpcResult(input.body.id, {}));
  }
  return input.controller.handleRequest({
    request: compatibilityControllerRequest(input.request),
    body: input.body,
    base: input.base,
    authorized: input.authorized,
    proxyMode: "",
  });
}

function compatibilityVersion(request: Pick<Request, "headers">, body: JsonRpcRequest): string | null {
  const headerVersion = boundedVersion(request.headers.get("MCP-Protocol-Version"));
  if (body.method === "initialize") {
    const requestedVersion = boundedVersion(asObject(body.params).protocolVersion);
    if (requestedVersion && COMPATIBILITY_VERSIONS.has(requestedVersion)) return requestedVersion;
    if (headerVersion && COMPATIBILITY_VERSIONS.has(headerVersion)) return headerVersion;
    return null;
  }
  return headerVersion && COMPATIBILITY_VERSIONS.has(headerVersion) ? headerVersion : null;
}

function initializeResponse(input: CompatibilityInput, version: string): Response {
  if (input.body.id === undefined || input.body.id === null) {
    return json(rpcError(input.body.id, -32600, "initialize requires a non-null request id"), 400);
  }
  const params = asObject(input.body.params);
  const requestedVersion = boundedVersion(params.protocolVersion);
  if (requestedVersion !== version || !COMPATIBILITY_VERSIONS.has(version)) {
    return json(rpcError(input.body.id, -32602, "Unsupported initialization protocol version", {
      supported: [...MCP_INITIALIZATION_COMPATIBILITY_VERSIONS],
    }), 400);
  }
  const headerVersion = boundedVersion(input.request.headers.get("MCP-Protocol-Version"));
  if (headerVersion && headerVersion !== version) {
    throw new McpHttpContractError(-32020, "MCP-Protocol-Version does not match initialize params.protocolVersion");
  }
  if (!isObject(params.capabilities)) {
    return json(rpcError(input.body.id, -32602, "initialize requires a capabilities object"), 400);
  }
  if (!validClientInfo(params.clientInfo)) {
    return json(rpcError(input.body.id, -32602, "initialize requires valid clientInfo"), 400);
  }
  const result: Record<string, unknown> = {
    protocolVersion: version,
    capabilities: structuredClone(input.capabilities),
    serverInfo: structuredClone(input.serverInfo),
  };
  if (input.instructions) result.instructions = input.instructions;
  return json(rpcResult(input.body.id, result));
}

function validateDeclaredVersion(headers: Headers, expected: string): void {
  const declared = boundedVersion(headers.get("MCP-Protocol-Version"));
  if (declared !== expected) {
    throw new McpHttpContractError(-32020, "MCP-Protocol-Version does not match the compatibility protocol");
  }
}

function rejectRemovedSessionHeader(headers: Headers): void {
  if (!headers.has("Mcp-Session-Id")) return;
  throw new McpHttpContractError(-32600, "Mcp-Session-Id is not supported by the stateless compatibility transport", {
    sessionless: true,
  });
}

function compatibilityControllerRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json");
  return new Request(request.url, { method: "POST", headers, signal: request.signal });
}

function boundedVersion(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= 64 ? normalized : "";
}

function validClientInfo(value: unknown): boolean {
  if (!isObject(value)) return false;
  return boundedText(value.name, 256) && boundedText(value.version, 256);
}

function boundedText(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
