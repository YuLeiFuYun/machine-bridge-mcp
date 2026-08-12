import {
  MCP_HEADER_MISMATCH,
  MCP_PROTOCOL_VERSIONS,
  McpProtocolError,
  requestProtocolVersion,
  validateRequestMetadata,
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

export type McpHttpRequestContext = {
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

export function httpHeaderContractError(request: Pick<Request, "headers">): McpHttpContractError | null {
  try { validateHttpContentType(request.headers); return null; }
  catch (error) { if (error instanceof McpHttpContractError) return error; throw error; }
}

export function validateHttpRequestMedia(headers: Headers): void {
  validateHttpContentType(headers);
  validateAcceptHeader(headers);
}

export function validateHttpRequest(input: {
  request: Pick<Request, "headers">;
  body: JsonRpcRequest;
  tools?: readonly ToolDefinition[];
  supportedVersions?: readonly string[];
}): McpHttpRequestContext {
  const supportedVersions = input.supportedVersions ?? MCP_PROTOCOL_VERSIONS;
  validateHttpRequestMedia(input.request.headers);
  const bodyVersion = requestProtocolVersion(input.body);
  const headerVersion = requiredHeader(input.request.headers, "MCP-Protocol-Version");
  if (headerVersion !== bodyVersion) {
    throw headerMismatch("MCP-Protocol-Version does not match request metadata");
  }
  validateMirroredMethod(input.request.headers, input.body.method);

  const params = asObject(input.body.params);
  const nameField = MIRRORED_NAME_METHODS.get(input.body.method);
  if (nameField) validateMirroredName(input.request.headers, params, nameField);
  else rejectUnexpectedMirroredName(input.request.headers);
  if (input.body.method === "tools/call") {
    validateToolParameterHeaders(input.request.headers, params, input.tools ?? []);
  } else rejectUnexpectedToolParameterHeaders(input.request.headers, []);

  let metadata;
  try { metadata = validateRequestMetadata(input.body, supportedVersions); }
  catch (error) {
    if (error instanceof McpProtocolError) throw new McpHttpContractError(error.code, error.message, error.data);
    throw error;
  }
  return metadata;
}

export function validateOptionalCompatibilityMirrors(input: {
  headers: Headers;
  body: JsonRpcRequest;
  tools?: readonly ToolDefinition[];
}): void {
  validateMirroredMethod(input.headers, input.body.method, false);
  const params = asObject(input.body.params);
  const nameField = MIRRORED_NAME_METHODS.get(input.body.method);
  if (nameField) validateMirroredName(input.headers, params, nameField, false);
  else rejectUnexpectedMirroredName(input.headers);
  if (input.body.method === "tools/call") validateToolParameterHeaders(input.headers, params, input.tools ?? [], false);
  else rejectUnexpectedToolParameterHeaders(input.headers, []);
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

export function validateHttpContentType(headers: Headers): void {
  const value = headers.get("Content-Type") ?? "";
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new McpHttpContractError(-32600, "Content-Type must be application/json", undefined, 415);
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

function validateMirroredMethod(headers: Headers, bodyMethod: string, required = true): void {
  const headerValue = headers.get("Mcp-Method");
  if (headerValue === null) {
    if (required) throw headerMismatch("Mcp-Method header is required");
    return;
  }
  if (required && !headerValue) throw headerMismatch("Mcp-Method header is required");
  if (headerValue !== bodyMethod) throw headerMismatch("Mcp-Method does not match the JSON-RPC method");
}

function validateMirroredName(headers: Headers, params: JsonObject, field: string, required = true): void {
  const bodyValue = params[field];
  if (required && typeof bodyValue !== "string") {
    throw new McpHttpContractError(-32602, `${field} must be a string`);
  }
  const headerValue = headers.get("Mcp-Name");
  if (headerValue === null) {
    if (required) throw headerMismatch("Mcp-Name header is required");
    return;
  }
  if (required && !headerValue) throw headerMismatch("Mcp-Name header is required");
  if (typeof bodyValue !== "string") {
    throw headerMismatch(`Mcp-Name does not match params.${field}`);
  }
  if (decodeMcpHeaderValue(headerValue) !== bodyValue) throw headerMismatch(`Mcp-Name does not match params.${field}`);
}

function rejectUnexpectedMirroredName(headers: Headers): void {
  if (headers.has("Mcp-Name")) throw headerMismatch("Mcp-Name is not applicable to this JSON-RPC method");
}

function validateToolParameterHeaders(headers: Headers, params: JsonObject, tools: readonly ToolDefinition[], required = true): void {
  const toolName = params.name;
  const tool = typeof toolName === "string" ? tools.find((candidate) => candidate.name === toolName) : undefined;
  const bindings = tool ? collectHeaderBindings(tool.inputSchema, tool.name) : [];
  rejectUnexpectedToolParameterHeaders(headers, bindings);
  if (!tool) return;
  const argumentsValue = asObject(params.arguments);
  for (const binding of bindings) {
    const bodyValue = valueAtPath(argumentsValue, binding.path);
    const headerValue = headers.get(binding.headerName);
    if (bodyValue === undefined || bodyValue === null) {
      if (headerValue !== null) throw headerMismatch(`${binding.headerName} is present without a body value`);
      continue;
    }
    if (headerValue === null) {
      if (required) throw headerMismatch(`${binding.headerName} is required for this tool call`);
      continue;
    }
    if (!mirroredValueEquals(decodeMcpHeaderValue(headerValue), bodyValue, binding.type)) {
      throw headerMismatch(`${binding.headerName} does not match the tool argument`);
    }
  }
}

function rejectUnexpectedToolParameterHeaders(headers: Headers, bindings: readonly HeaderBinding[]): void {
  const allowed = new Set(bindings.map((binding) => binding.headerName.toLowerCase()));
  for (const name of headers.keys()) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("mcp-param-") && !allowed.has(normalized)) {
      throw headerMismatch("Mcp-Param header is not declared for this tool call");
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
