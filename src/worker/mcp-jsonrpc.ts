import { projectMcpResult } from "../shared/result-projection.mjs";
import { completeResult } from "../shared/mcp-protocol.mjs";
const JSONRPC_VERSION = "2.0";

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

export function textToolResult(
  value: unknown,
  isError = false,
  serverInfo?: Record<string, unknown>,
): Record<string, unknown> {
  const special = asObject(value).$mcp;
  if (special && typeof special === "object" && !Array.isArray(special)) {
    const specialObject = special as Record<string, unknown>;
    if (Array.isArray(specialObject.content)) {
      const result: Record<string, unknown> = { content: specialObject.content, isError };
      if (Object.prototype.hasOwnProperty.call(specialObject, "structuredContent")) {
        result.structuredContent = structuredClone(specialObject.structuredContent);
      }
      return completeResult(result, serverInfo);
    }
  }
  const projection = projectMcpResult(value);
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: projection.text }],
    isError,
  };
  if (projection.hasStructuredContent) result.structuredContent = structuredClone(projection.structuredContent);
  return completeResult(result, serverInfo);
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

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
