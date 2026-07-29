import {
  MCP_HEADER_MISMATCH,
  MCP_MODERN_PROTOCOL_VERSIONS,
  McpProtocolError,
  requestProtocolVersion,
  validateModernRequestMetadata,
} from "../shared/mcp-protocol.mjs";
import type { JsonRpcRequest } from "./mcp-jsonrpc.ts";

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
const MIRRORED_NAME_METHODS = new Map([
  ["tools/call", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
]);

type JsonObject = Record<string, unknown>;
type ToolDefinition = { name: string; inputSchema?: unknown };
type HeaderBinding = { headerName: string; path: string[]; type: "string" | "integer" | "boolean" };

export type McpRequestEra = "modern" | "legacy";

export type ModernHttpRequestContext = {
  era: "modern";
  version: string;
  clientCapabilities: JsonObject;
  clientInfo: JsonObject | null;
  progressToken: unknown;
  logLevel: unknown;
};

export class McpHttpContractError extends Error {
  readonly status: number;
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown, status = 400) {
    super(message);
    this.name = "McpHttpContractError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function detectHttpMcpEra(request: Pick<Request, "headers">, body: JsonRpcRequest): McpRequestEra {
  const bodyVersion = requestProtocolVersion(body);
  const headerVersion = request.headers.get("mcp-protocol-version")?.trim() ?? "";
  const legacySession = request.headers.get("mcp-session-id")?.trim() ?? "";
  if (body.method === "server/discover" || bodyVersion || headerVersion === MCP_MODERN_PROTOCOL_VERSIONS[0]) return "modern";
  if (body.method === "initialize" || legacySession) return "legacy";
  return "legacy";
}

export function validateModernHttpRequest(input: {
  request: Pick<Request, "headers">;
  body: JsonRpcRequest;
  tools?: readonly ToolDefinition[];
  supportedVersions?: readonly string[];
}): ModernHttpRequestContext {
  const supportedVersions = input.supportedVersions ?? MCP_MODERN_PROTOCOL_VERSIONS;
  validateAcceptHeader(input.request.headers);
  const bodyVersion = requestProtocolVersion(input.body);
  if (!bodyVersion) {
    try { validateModernRequestMetadata(input.body, supportedVersions); }
    catch (error) {
      if (error instanceof McpProtocolError) throw new McpHttpContractError(error.code, error.message, error.data);
      throw error;
    }
  }
  const headerVersion = requiredHeader(input.request.headers, "MCP-Protocol-Version");
  if (headerVersion !== bodyVersion) {
    throw headerMismatch("MCP-Protocol-Version does not match request metadata");
  }
  const method = requiredHeader(input.request.headers, "Mcp-Method");
  if (method !== input.body.method) {
    throw headerMismatch("Mcp-Method does not match the JSON-RPC method");
  }

  const params = asObject(input.body.params);
  const nameField = MIRRORED_NAME_METHODS.get(input.body.method);
  if (nameField) validateMirroredName(input.request.headers, params, nameField);
  if (input.body.method === "tools/call") {
    validateToolParameterHeaders(input.request.headers, params, input.tools ?? []);
  }

  let metadata;
  try { metadata = validateModernRequestMetadata(input.body, supportedVersions); }
  catch (error) {
    if (error instanceof McpProtocolError) throw new McpHttpContractError(error.code, error.message, error.data);
    throw error;
  }
  return { era: "modern", ...metadata };
}

export function validateToolHeaderSchemas(tools: readonly ToolDefinition[]): void {
  toolParameterHeaderNames(tools);
}

export function toolParameterHeaderNames(tools: readonly ToolDefinition[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    for (const binding of collectHeaderBindings(tool.inputSchema, tool.name)) names.add(binding.headerName.toLowerCase());
  }
  return names;
}

export function decodeMcpHeaderValue(value: string): string {
  const match = value.match(BASE64_SENTINEL);
  if (!match) {
    if (!isSafePlainHeaderValue(value)) throw headerMismatch("Mirrored MCP header contains an invalid plain value");
    return value;
  }
  const encoded = match[1];
  if (encoded.length % 4 !== 0) throw headerMismatch("Mirrored MCP header contains invalid Base64");
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw headerMismatch("Mirrored MCP header contains invalid Base64");
  }
  const canonical = btoa(String.fromCharCode(...bytes));
  if (canonical !== encoded) throw headerMismatch("Mirrored MCP header contains non-canonical Base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw headerMismatch("Mirrored MCP header contains invalid UTF-8");
  }
}

function validateAcceptHeader(headers: Headers): void {
  const value = headers.get("Accept") ?? "";
  const accepted = new Set<string>();
  for (const entry of value.split(",")) {
    const [rawType, ...parameters] = entry.split(";");
    const mediaType = rawType.trim().toLowerCase();
    if (!mediaType) continue;
    const qualities = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .filter((parameter) => parameter.startsWith("q="));
    if (qualities.length > 1) continue;
    if (qualities.length === 1 && !positiveHttpQuality(qualities[0].slice(2))) continue;
    accepted.add(mediaType);
  }
  if (!accepted.has("application/json") || !accepted.has("text/event-stream")) {
    throw new McpHttpContractError(-32600, "Accept header must include application/json and text/event-stream");
  }
}

function positiveHttpQuality(value: string): boolean {
  if (!/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return false;
  return Number(value) > 0;
}

function validateMirroredName(headers: Headers, params: JsonObject, field: string): void {
  const bodyValue = params[field];
  if (typeof bodyValue !== "string") throw new McpHttpContractError(-32602, `${field} must be a string`);
  const headerValue = decodeMcpHeaderValue(requiredHeader(headers, "Mcp-Name"));
  if (headerValue !== bodyValue) {
    throw headerMismatch(`Mcp-Name does not match params.${field}`);
  }
}

function validateToolParameterHeaders(headers: Headers, params: JsonObject, tools: readonly ToolDefinition[]): void {
  const toolName = params.name;
  if (typeof toolName !== "string") return;
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) return;
  const bindings = collectHeaderBindings(tool.inputSchema, tool.name);
  const argumentsValue = asObject(params.arguments);
  for (const binding of bindings) {
    const bodyValue = valueAtPath(argumentsValue, binding.path);
    const headerValue = headers.get(binding.headerName);
    if (bodyValue === undefined || bodyValue === null) {
      if (headerValue !== null) throw headerMismatch(`${binding.headerName} is present without a body value`);
      continue;
    }
    if (headerValue === null) throw headerMismatch(`${binding.headerName} is required for this tool call`);
    if (!mirroredValueEquals(decodeMcpHeaderValue(headerValue), bodyValue, binding.type)) {
      throw headerMismatch(`${binding.headerName} does not match the tool argument`);
    }
  }
}

function collectHeaderBindings(schema: unknown, toolName: string): HeaderBinding[] {
  const bindings: HeaderBinding[] = [];
  const names = new Set<string>();
  visitSchema(schema, [], true, toolName, bindings, names);
  return bindings;
}

function visitSchema(
  value: unknown,
  path: string[],
  reachable: boolean,
  toolName: string,
  bindings: HeaderBinding[],
  names: Set<string>,
): void {
  if (!isObject(value)) return;
  const annotation = value["x-mcp-header"];
  if (annotation !== undefined) {
    if (!reachable) throw new Error(`tool ${toolName} has x-mcp-header outside a properties-only path`);
    if (typeof annotation !== "string" || !annotation || !HEADER_TOKEN.test(annotation)) {
      throw new Error(`tool ${toolName} has an invalid x-mcp-header name`);
    }
    const type = value.type;
    if (type !== "string" && type !== "integer" && type !== "boolean") {
      throw new Error(`tool ${toolName} uses x-mcp-header on a non-primitive property`);
    }
    const normalized = annotation.toLowerCase();
    if (names.has(normalized)) throw new Error(`tool ${toolName} has duplicate x-mcp-header names`);
    names.add(normalized);
    bindings.push({ headerName: `Mcp-Param-${annotation}`, path, type });
  }

  const properties = isObject(value.properties) ? value.properties : null;
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      visitSchema(child, [...path, key], reachable, toolName, bindings, names);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties" || key === "x-mcp-header") continue;
    if (Array.isArray(child)) {
      for (const item of child) visitSchema(item, path, false, toolName, bindings, names);
    } else if (isObject(child)) {
      visitSchema(child, path, false, toolName, bindings, names);
    }
  }
}

function mirroredValueEquals(headerValue: string, bodyValue: unknown, type: HeaderBinding["type"]): boolean {
  if (type === "string") return typeof bodyValue === "string" && headerValue === bodyValue;
  if (type === "boolean") return typeof bodyValue === "boolean" && headerValue === String(bodyValue);
  if (typeof bodyValue !== "number" || !Number.isSafeInteger(bodyValue)) return false;
  const parsed = Number(headerValue);
  return Number.isSafeInteger(parsed) && parsed === bodyValue;
}

function valueAtPath(value: JsonObject, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || !value) throw headerMismatch(`${name} header is required`);
  return value;
}

function headerMismatch(message: string, data?: unknown): McpHttpContractError {
  return new McpHttpContractError(MCP_HEADER_MISMATCH, `Header mismatch: ${message}`, data);
}

function isSafePlainHeaderValue(value: string): boolean {
  if (value !== value.trim() || BASE64_SENTINEL.test(value)) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code !== 9 && (code < 32 || code > 126)) return false;
  }
  return true;
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
