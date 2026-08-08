import { randomBytes } from "node:crypto";
import { LocalRuntime } from "./runtime.mjs";
import { packageVersion } from "./package-identity.mjs";
import { validateToolArguments } from "./tool-executor.mjs";
import { classifyOperationalError, createLogger } from "./log.mjs";
import { publicError } from "./errors.mjs";
import {
  MCP_INSTRUCTIONS,
  SERVER_NAME,
  rpcError,
  rpcResult,
  toolResult,
  toolsForPolicy,
} from "./tools.mjs";
import {
  MCP_LEGACY_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSIONS, McpProtocolError, isModernMcpRequest, modernCacheableResult,
  modernDiscoverResult, serverImplementation, validateModernRequestMetadata,
} from "../shared/mcp-protocol.mjs";
import {
  acceptedSubscriptionFilter, subscriptionAcknowledgedNotification, subscriptionCompleteResult, validateSubscriptionFilter,
} from "../shared/mcp-subscriptions.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS = 32;
const MCP_SERVER_INFO = Object.freeze(serverImplementation({
  name: SERVER_NAME, title: "Machine Bridge MCP", version: packageVersion,
  description: "Workspace-scoped local coding tools over MCP stdio or authenticated remote relay.",
}));
const MCP_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
const MCP_DISCOVERY_TTL_MS = 300_000;
const MCP_TOOL_LIST_TTL_MS = 300_000;
const MODERN_LIMIT_EXCEEDED = -31900;

export async function runStdioServer({ workspace, policy, logLevel = "info", jobRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "" }) {
  const logger = createLogger({ component: "stdio", level: logLevel, stderrOnly: true, color: false });
  const runtime = new LocalRuntime({ workspace, policy, logger, jobRoot, resources, resourceStatePath, browserStateRoot });
  const pending = new Map();
  let legacyInitialized = false;
  let legacyVersion = MCP_LEGACY_PROTOCOL_VERSION;
  const writes = new Set();
  const send = (message) => {
    if (message === null || message === undefined) return;
    const line = `${JSON.stringify(message)}
`;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      process.stdout.write(line, (error) => error ? rejectPromise(error) : resolvePromise());
    }).catch((error) => {
      logger.warn("stdio output write failed", { error_class: classifyOperationalError(error) });
    }).finally(() => writes.delete(promise));
    writes.add(promise);
  };

  await consumeBoundedJsonLines(process.stdin, {
    maxLineBytes: MAX_LINE_BYTES,
    onOversize() { send(rpcError(null, -32600, "JSON-RPC message exceeds maximum size")); },
    onLine(line) {
      void handleLine(line).catch((error) => {
        logger.error("stdio request handler failed", { error_class: classifyOperationalError(error) });
      });
    },
  });
  for (const callId of pending.values()) runtime.cancelCall(callId, "stdio input closed");
  await Promise.allSettled([...writes]);
  runtime.stop();

  async function handleLine(line) {
    const message = parseJsonRpcLine(line, send);
    if (!message) return;
    if (typeof message.method !== "string") {
      send(rpcError(message.id, -32600, "Clients must not send JSON-RPC responses"));
      return;
    }
    if (message.method === "notifications/cancelled") {
      cancelRequest(message);
      return;
    }
    if (isModernMcpRequest(message)) {
      let context;
      try {
        context = validateModernRequestMetadata(message, MCP_MODERN_PROTOCOL_VERSIONS);
      } catch (error) {
        if (error instanceof McpProtocolError) {
          send(rpcError(message.id, error.code, error.message, error.data));
          return;
        }
        throw error;
      }
      await handleModernMessage(message, context.version);
      return;
    }

    if (message.method === "initialize") {
      await initializeLegacy(message);
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "logging/setLevel" || message.method === "ping") {
      send(rpcResult(message.id, {}));
      return;
    }
    if (!legacyInitialized) {
      send(rpcError(message.id, -32002, "Server is not initialized"));
      return;
    }
    await handleLegacyMessage(message);
  }

  async function initializeLegacy(message) {
    const requested = asObject(message.params).protocolVersion;
    legacyVersion = typeof requested === "string" && MCP_LEGACY_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : MCP_LEGACY_PROTOCOL_VERSION;
    legacyInitialized = true;
    send(rpcResult(message.id, await legacyInitializationResult(legacyVersion, runtime)));
  }

  function cancelRequest(message) {
    const requestId = asObject(message.params).requestId;
    const callId = pending.get(jsonRpcIdKey(requestId));
    if (callId) runtime.cancelCall(callId, "MCP cancellation notification");
  }

  async function handleModernMessage(message, protocolVersion) {
    if (!("id" in message) || message.id === null) {
      if (!message.method.startsWith("notifications/")) {
        send(rpcError(null, -32600, "Modern MCP requests require a non-null request id"));
      }
      return;
    }
    if (message.method === "server/discover") {
      send(rpcResult(message.id, modernDiscoverResult({
        supportedVersions: MCP_MODERN_PROTOCOL_VERSIONS,
        capabilities: MCP_SERVER_CAPABILITIES,
        instructions: MCP_INSTRUCTIONS,
        ttlMs: MCP_DISCOVERY_TTL_MS,
        serverInfo: MCP_SERVER_INFO,
      })));
      return;
    }
    if (message.method === "tools/list") {
      send(rpcResult(message.id, modernCacheableResult(
        { tools: toolsForPolicy(policy) },
        { ttlMs: MCP_TOOL_LIST_TTL_MS, cacheScope: "private", serverInfo: MCP_SERVER_INFO },
      )));
      return;
    }
    if (message.method === "subscriptions/listen") {
      const requested = subscriptionFilterOrError(asObject(message.params).notifications, message.id, send);
      if (!requested) return;
      const accepted = acceptedSubscriptionFilter(requested, MCP_SERVER_CAPABILITIES);
      send(subscriptionAcknowledgedNotification(message.id, accepted));
      send(rpcResult(message.id, subscriptionCompleteResult(message.id, MCP_SERVER_INFO)));
      return;
    }
    if (message.method === "tools/call") {
      await handleToolCall(message, protocolVersion);
      return;
    }
    send(rpcError(message.id, -32601, "Method not found"));
  }

  async function handleLegacyMessage(message) {
    if (message.method === "tools/list") {
      send(rpcResult(message.id, { tools: toolsForPolicy(policy) }));
      return;
    }
    if (message.method === "tools/call") {
      await handleToolCall(message, legacyVersion);
      return;
    }
    send(rpcError(message.id, -32601, "Method not found"));
  }

  async function handleToolCall(message, protocolVersion) {
    if (!("id" in message) || message.id === null) {
      send(rpcError(null, -32600, "tools/call requires a non-null request id"));
      return;
    }
    const params = asObject(message.params);
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) {
      send(rpcError(message.id, -32602, "tools/call requires a tool name"));
      return;
    }
    if (!toolsForPolicy(policy).some((tool) => tool.name === name)) {
      send(rpcError(message.id, -32602, "Unknown or unavailable tool"));
      return;
    }
    const rawArgs = params.arguments === undefined ? {} : params.arguments;
    const validation = validateToolArguments(name, rawArgs);
    if (!validation.known || !validation.valid) {
      send(rpcError(message.id, -32602, !validation.known
        ? "Unknown tool"
        : "Tool arguments do not match the input schema", validation.valid ? undefined : {
          validation_issues: validation.issues,
        }));
      return;
    }
    const args = rawArgs;
    const modern = protocolVersion === MCP_MODERN_PROTOCOL_VERSION;
    if (pending.size >= MAX_PENDING_TOOL_CALLS) {
      send(rpcError(message.id, modern ? MODERN_LIMIT_EXCEEDED : -32000, "Too many concurrent tool calls"));
      return;
    }
    const key = jsonRpcIdKey(message.id);
    if (key && pending.has(key)) {
      send(rpcError(message.id, -32600, "Duplicate in-flight JSON-RPC request id"));
      return;
    }
    const callId = `stdio_${randomBytes(16).toString("hex")}`;
    if (key) pending.set(key, callId);
    try {
      const result = await runtime.executeTool(name, args, { callId, origin: "stdio" });
      send(rpcResult(message.id, toolResult(result, false, protocolVersion, MCP_SERVER_INFO)));
    } catch (error) {
      send(rpcResult(message.id, toolResult({ error: publicError(error) }, true, protocolVersion, MCP_SERVER_INFO)));
    } finally {
      if (key) pending.delete(key);
    }
  }
}

function subscriptionFilterOrError(value, requestId, send) {
  try { return validateSubscriptionFilter(value); }
  catch (error) {
    if (!(error instanceof McpProtocolError)) throw error;
    send(rpcError(requestId, error.code, error.message, error.data));
    return null;
  }
}

function parseJsonRpcLine(line, send) {
  let message;
  try { message = JSON.parse(line); } catch {
    send(rpcError(null, -32700, "Parse error"));
    return null;
  }
  if (!isJsonRpcMessage(message)) {
    send(rpcError(null, -32600, "Invalid JSON-RPC message"));
    return null;
  }
  return message;
}

async function legacyInitializationResult(protocolVersion, runtime) {
  const bootstrap = await runtime.sessionBootstrap({ path: "." }).catch((error) => {
    runtime.logger?.debug?.("session bootstrap unavailable during initialize", { error_class: classifyOperationalError(error) });
    return null;
  });
  const localInstructions = bootstrap?.instructions ? `\n\n--- LOCAL SESSION INSTRUCTIONS ---\n${bootstrap.instructions}` : "";
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false }, logging: {} },
    serverInfo: MCP_SERVER_INFO,
    instructions: `${MCP_INSTRUCTIONS}${localInstructions}`,
  };
}

function consumeBoundedJsonLines(stream, { maxLineBytes, onLine, onOversize }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let chunks = [];
    let bytes = 0;
    let discarding = false;
    let settled = false;

    const resetLine = () => { chunks = []; bytes = 0; };
    const emitLine = () => {
      let line = bytes ? Buffer.concat(chunks, bytes) : Buffer.alloc(0);
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      resetLine();
      onLine(line.toString("utf8"));
    };
    const onData = (input) => {
      const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < buffer.length) {
        const newline = buffer.indexOf(10, offset);
        const end = newline === -1 ? buffer.length : newline;
        const segment = buffer.subarray(offset, end);
        if (discarding) {
          if (newline !== -1) discarding = false;
        } else if (bytes + segment.length > maxLineBytes) {
          resetLine();
          onOversize();
          if (newline === -1) discarding = true;
        } else {
          if (segment.length) chunks.push(segment);
          bytes += segment.length;
          if (newline !== -1) emitLine();
        }
        offset = newline === -1 ? buffer.length : newline + 1;
      }
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      stream.off("error", onError);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!discarding && bytes > 0) emitLine();
      resolvePromise();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onError);
  });
}

function isJsonRpcMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.jsonrpc !== "2.0") return false;
  if ("id" in value && !isJsonRpcId(value.id)) return false;
  return true;
}

function isJsonRpcId(value) {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function jsonRpcIdKey(value) {
  if (!isJsonRpcId(value) || value === null) return "";
  return `${typeof value}:${String(value)}`;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
