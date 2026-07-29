export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MODERN_PROTOCOL_VERSIONS = Object.freeze([MCP_MODERN_PROTOCOL_VERSION]);
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze([MCP_LEGACY_PROTOCOL_VERSION]);
export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MCP_RESULT_COMPLETE = "complete";

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const LOG_LEVELS = new Set(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
const META_KEY = /^(?:(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/;
const MAX_MCP_JSON_DEPTH = 32;
const MAX_MCP_JSON_NODES = 4096;
const MAX_MCP_JSON_KEY_LENGTH = 256;

export class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

export function asMcpObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requestMeta(value) {
  return asMcpObject(asMcpObject(value).params)._meta;
}

export function requestProtocolVersion(value) {
  const version = asMcpObject(requestMeta(value))[PROTOCOL_VERSION_KEY];
  return typeof version === "string" ? version : "";
}

export function isModernMcpRequest(value) {
  return requestProtocolVersion(value) !== "" || asMcpObject(value).method === "server/discover";
}

export function validateModernRequestMetadata(value, supportedVersions = MCP_MODERN_PROTOCOL_VERSIONS) {
  const params = asMcpObject(asMcpObject(value).params);
  const meta = asMcpObject(params._meta);
  assertBoundedMcpJsonStructure(meta, "request metadata");
  const version = meta[PROTOCOL_VERSION_KEY];
  if (typeof version !== "string" || !version) {
    throw new McpProtocolError(-32602, `Missing required request metadata: ${PROTOCOL_VERSION_KEY}`);
  }
  if (!supportedVersions.includes(version)) {
    throw new McpProtocolError(MCP_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      supported: [...supportedVersions],
      requested: boundedProtocolVersion(version),
    });
  }
  validateMetaKeys(meta);
  const clientCapabilities = meta[CLIENT_CAPABILITIES_KEY];
  if (!isPlainObject(clientCapabilities)) {
    throw new McpProtocolError(-32602, `Missing required request metadata: ${CLIENT_CAPABILITIES_KEY}`);
  }
  validateClientCapabilities(clientCapabilities);
  const clientInfo = meta[CLIENT_INFO_KEY];
  if (clientInfo !== undefined && !isImplementation(clientInfo)) {
    throw new McpProtocolError(-32602, `Invalid request metadata: ${CLIENT_INFO_KEY}`);
  }
  const progressToken = meta.progressToken;
  if (progressToken !== undefined && !isProgressToken(progressToken)) {
    throw new McpProtocolError(-32602, "Invalid request metadata: progressToken");
  }
  const logLevel = meta["io.modelcontextprotocol/logLevel"];
  if (logLevel !== undefined && !LOG_LEVELS.has(logLevel)) {
    throw new McpProtocolError(-32602, "Invalid request metadata: io.modelcontextprotocol/logLevel");
  }
  return {
    version,
    clientCapabilities,
    clientInfo: clientInfo ?? null,
    progressToken,
    logLevel,
  };
}

export function serverImplementation({ name, version, title, description }) {
  const implementation = { name: String(name), version: String(version) };
  if (title) implementation.title = String(title);
  if (description) implementation.description = String(description);
  return implementation;
}

export function modernCompleteResult(fields = {}, serverInfo) {
  return modernResult(MCP_RESULT_COMPLETE, fields, serverInfo);
}


export function modernCacheableResult(fields, { ttlMs, cacheScope, serverInfo }) {
  const normalizedTtl = Number(ttlMs);
  if (!Number.isFinite(normalizedTtl) || normalizedTtl < 0) throw new Error("ttlMs must be a non-negative number");
  if (cacheScope !== "public" && cacheScope !== "private") throw new Error("cacheScope must be public or private");
  return modernCompleteResult({ ...fields, ttlMs: normalizedTtl, cacheScope }, serverInfo);
}

export function modernDiscoverResult({ supportedVersions, capabilities, instructions, ttlMs = 0, serverInfo }) {
  const fields = {
    supportedVersions: [...supportedVersions],
    capabilities: structuredClone(capabilities),
  };
  if (instructions) fields.instructions = String(instructions);
  return modernCacheableResult(fields, { ttlMs, cacheScope: "public", serverInfo });
}


export function resultForProtocol(version, fields, { serverInfo, ttlMs, cacheScope } = {}) {
  if (version !== MCP_MODERN_PROTOCOL_VERSION) return structuredClone(fields);
  if (ttlMs !== undefined || cacheScope !== undefined) {
    return modernCacheableResult(fields, {
      ttlMs: ttlMs ?? 0,
      cacheScope: cacheScope ?? "private",
      serverInfo,
    });
  }
  return modernCompleteResult(fields, serverInfo);
}

function modernServerInfoMeta(serverInfo) {
  return serverInfo ? { [SERVER_INFO_KEY]: structuredClone(serverInfo) } : undefined;
}

function modernResult(resultType, fields, serverInfo) {
  const result = { ...structuredClone(fields), resultType };
  const meta = modernServerInfoMeta(serverInfo);
  if (meta) result._meta = { ...asMcpObject(result._meta), ...meta };
  return result;
}


export function assertBoundedMcpJsonStructure(value, label = "MCP value") {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_MCP_JSON_NODES || current.depth > MAX_MCP_JSON_DEPTH) {
      throw new McpProtocolError(-32602, `${label} exceeds bounded structural limits`);
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_MCP_JSON_NODES - nodes - stack.length) {
        throw new McpProtocolError(-32602, `${label} exceeds bounded structural limits`);
      }
      for (let index = 0; index < current.value.length; index += 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (!isPlainObject(current.value)) throw new McpProtocolError(-32602, `${label} contains a non-JSON object`);
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) continue;
      if (key.length > MAX_MCP_JSON_KEY_LENGTH || stack.length + nodes >= MAX_MCP_JSON_NODES) {
        throw new McpProtocolError(-32602, `${label} exceeds bounded structural limits`);
      }
      stack.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
}

function validateMetaKeys(meta) {
  for (const key in meta) {
    if (!Object.hasOwn(meta, key)) continue;
    if (key.length > MAX_MCP_JSON_KEY_LENGTH || !META_KEY.test(key)) {
      throw new McpProtocolError(-32602, "Invalid request metadata key");
    }
  }
}

function validateClientCapabilities(value) {
  validateCapabilityObject(value, "roots");
  validateCapabilityMap(value, "experimental");
  validateCapabilityFields(value, "sampling", ["context", "tools"]);
  validateCapabilityFields(value, "elicitation", ["form", "url"]);
  const extensions = value.extensions;
  if (extensions === undefined) return;
  if (!isPlainObject(extensions)) throw new McpProtocolError(-32602, "Invalid client capability: extensions");
  for (const key in extensions) {
    if (!Object.hasOwn(extensions, key)) continue;
    const settings = extensions[key];
    if (key.length > MAX_MCP_JSON_KEY_LENGTH || !key.includes("/") || !META_KEY.test(key) || !isPlainObject(settings)) {
      throw new McpProtocolError(-32602, "Invalid client extension capability");
    }
  }
}

function validateCapabilityObject(value, key) {
  if (value[key] !== undefined && !isPlainObject(value[key])) {
    throw new McpProtocolError(-32602, `Invalid client capability: ${key}`);
  }
}

function validateCapabilityMap(value, key) {
  validateCapabilityObject(value, key);
  if (value[key] === undefined) return;
  for (const name in value[key]) {
    if (!Object.hasOwn(value[key], name)) continue;
    if (name.length > MAX_MCP_JSON_KEY_LENGTH || !isPlainObject(value[key][name])) {
      throw new McpProtocolError(-32602, `Invalid client capability: ${key}`);
    }
  }
}

function validateCapabilityFields(value, key, fields) {
  validateCapabilityObject(value, key);
  if (value[key] === undefined) return;
  for (const field of fields) {
    if (value[key][field] !== undefined && !isPlainObject(value[key][field])) {
      throw new McpProtocolError(-32602, `Invalid client capability: ${key}.${field}`);
    }
  }
}

function boundedProtocolVersion(value) {
  return value.length <= 128 ? value : "<invalid-length>";
}

function isProgressToken(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isImplementation(value) {
  if (!isPlainObject(value) || typeof value.name !== "string" || typeof value.version !== "string") return false;
  for (const field of ["title", "description"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.websiteUrl !== undefined && !isAbsoluteUri(value.websiteUrl)) return false;
  if (value.icons !== undefined && (!Array.isArray(value.icons) || !value.icons.every(isIcon))) return false;
  return true;
}

function isIcon(value) {
  if (!isPlainObject(value) || !isAbsoluteUri(value.src)) return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") return false;
  if (value.sizes !== undefined && (!Array.isArray(value.sizes) || !value.sizes.every((size) => typeof size === "string"))) return false;
  return value.theme === undefined || value.theme === "light" || value.theme === "dark";
}

function isAbsoluteUri(value) {
  if (typeof value !== "string" || !value) return false;
  try { return Boolean(new URL(value).protocol); } catch { return false; }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
