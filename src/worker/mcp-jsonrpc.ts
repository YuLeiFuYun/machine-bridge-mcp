const JSONRPC_VERSION = "2.0";
const MAX_SESSION_INSTRUCTION_BYTES = 3 * 1024 * 1024;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSONRPC_VERSION || typeof candidate.method !== "string" || !candidate.method.trim() || candidate.method.length > 256) return false;
  if ("id" in candidate && !isJsonRpcId(candidate.id)) return false;
  return true;
}

export function isJsonRpcResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSONRPC_VERSION || !("id" in candidate) || !isJsonRpcId(candidate.id) || typeof candidate.method === "string") return false;
  return ("result" in candidate) !== ("error" in candidate);
}

export function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> | null {
  if (id === undefined) return null;
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error };
}

export function textToolResult(value: unknown, isError = false): Record<string, unknown> {
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

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`${key} must be a non-empty string`);
  return field.trim();
}

export function sessionInstructionText(value: unknown): string {
  const object = asObject(value);
  const instructions = typeof object.instructions === "string" ? object.instructions : "";
  if (!instructions) return "";
  if (new TextEncoder().encode(instructions).byteLength > MAX_SESSION_INSTRUCTION_BYTES) return "";
  return instructions;
}

export function validateProtocolVersionHeader(
  request: Request,
  body: JsonRpcRequest,
  supportedVersions: readonly string[],
): Record<string, unknown> | null {
  if (body.method === "initialize") return null;
  const version = request.headers.get("MCP-Protocol-Version");
  if (!version || supportedVersions.includes(version)) return null;
  return rpcError(body.id, -32602, "Unsupported MCP protocol version", {
    requested: version,
    supported: [...supportedVersions],
  });
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
