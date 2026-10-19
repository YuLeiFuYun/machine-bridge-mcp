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
  MCP_PROTOCOL_VERSIONS, MCP_REMOVED_PROTOCOL_MESSAGE, McpProtocolError, cacheableResult,
  discoverResult, emptySubscriptionAcknowledgement, serverImplementation, subscriptionCompleteResult,
  validateRequestMetadata, validateSubscriptionRequest,
} from "../shared/mcp-protocol.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS = 32;
const MAX_STDIO_OUTPUT_QUEUE_BYTES = 8 * 1024 * 1024;
const MCP_SERVER_INFO = Object.freeze(serverImplementation({
  name: SERVER_NAME, title: "Machine Bridge MCP", version: packageVersion,
  description: "Workspace-scoped local coding tools over MCP stdio or authenticated remote relay.",
}));
const MCP_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
const MCP_DISCOVERY_TTL_MS = 0;
const MCP_TOOL_LIST_TTL_MS = 0;
const MCP_LIMIT_EXCEEDED = -31900;

const COMPAT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const COMPAT_DEFAULT_META = Object.freeze({ [META_CLIENT_CAPABILITIES]: Object.freeze({}) });
// Legacy clients do not send request-scoped metadata. Compatibility mode keeps the
// server on its own protocol version: `initialize` advertises the supported version
// (never an echoed client version) and each request's `_meta` is normalized to that
// same version, so negotiation and per-request validation cannot disagree.

export async function runStdioServer({
  workspace, policy, logLevel = "info", jobRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "",
  serviceControlRoot = "", compatMode = false, verboseErrors = process.env.MBM_VERBOSE_ERRORS === "1",
}) {
  const logger = createLogger({ component: "stdio", level: logLevel, stderrOnly: true, color: false });
  const runtime = new LocalRuntime({ workspace, policy, logger, jobRoot, resources, resourceStatePath, browserStateRoot, serviceControlRoot });
  const pending = new Map();
  const requestHandlers = new Set();
  const outputWriter = createBoundedStdioWriter({
    inputStream: process.stdin,
    outputStream: process.stdout,
    maxQueuedBytes: MAX_STDIO_OUTPUT_QUEUE_BYTES,
    onOverload: (details) => {
      process.exitCode = 1;
      logger.warn("stdio output queue limit exceeded", details);
    },
    onFailure: (error) => {
      process.exitCode = 1;
      logger.warn("stdio output write failed", { error_class: classifyOperationalError(error) });
    },
  });
  const send = outputWriter.send;

  await consumeBoundedJsonLines(process.stdin, {
    maxLineBytes: MAX_LINE_BYTES,
    onOversize() { send(rpcError(null, -32600, "JSON-RPC message exceeds maximum size")); },
    onLine(line) {
      if (outputWriter.overloaded || outputWriter.outputFailed) return;
      const request = handleLine(line).catch((error) => {
        logger.error("stdio request handler failed", { error_class: classifyOperationalError(error) });
      }).finally(() => requestHandlers.delete(request));
      requestHandlers.add(request);
    },
  });
  for (const callId of pending.values()) runtime.cancelCall(callId, "stdio input closed");
  while (requestHandlers.size) await Promise.allSettled([...requestHandlers]);
  await outputWriter.waitForPendingWrites();
  await runtime.stop();

  async function handleLine(line) {
    if (outputWriter.overloaded || outputWriter.outputFailed) return;
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
    if (message.method === "initialize") {
      if (compatMode) {
        send(rpcResult(message.id, {
          protocolVersion: COMPAT_PROTOCOL_VERSION,
          capabilities: MCP_SERVER_CAPABILITIES,
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }));
        return;
      }
      send(rpcError(message.id, -32601, MCP_REMOVED_PROTOCOL_MESSAGE, { supported: [...MCP_PROTOCOL_VERSIONS] }));
      return;
    }
    if (compatMode && message.method === "notifications/initialized") {
      return;
    }
    if (compatMode) {
      const params = asObject(message.params);
      const meta = asObject(params._meta);
      message.params = {
        ...params,
        _meta: {
          ...meta,
          ...(!Object.hasOwn(meta, META_PROTOCOL_VERSION) ? { [META_PROTOCOL_VERSION]: COMPAT_PROTOCOL_VERSION } : {}),
          ...(!Object.hasOwn(meta, META_CLIENT_CAPABILITIES) ? { [META_CLIENT_CAPABILITIES]: COMPAT_DEFAULT_META[META_CLIENT_CAPABILITIES] } : {}),
        },
      };
    }
    try {
      validateRequestMetadata(message, MCP_PROTOCOL_VERSIONS);
    } catch (error) {
      if (error instanceof McpProtocolError) {
        send(rpcError(message.id, error.code, error.message, error.data));
        return;
      }
      throw error;
    }
    await handleMessage(message);
  }

  function cancelRequest(message) {
    const requestId = asObject(message.params).requestId;
    const callId = pending.get(jsonRpcIdKey(requestId));
    if (callId) runtime.cancelCall(callId, "MCP cancellation notification");
  }

  async function handleMessage(message) {
    if (!("id" in message) || message.id === null) {
      if (!message.method.startsWith("notifications/")) {
        send(rpcError(null, -32600, "MCP requests require a non-null request id"));
      }
      return;
    }
    if (message.method === "server/discover") {
      send(rpcResult(message.id, discoverResult({
        supportedVersions: MCP_PROTOCOL_VERSIONS,
        capabilities: MCP_SERVER_CAPABILITIES,
        instructions: MCP_INSTRUCTIONS,
        ttlMs: MCP_DISCOVERY_TTL_MS,
        serverInfo: MCP_SERVER_INFO,
      })));
      return;
    }
    if (message.method === "tools/list") {
      send(rpcResult(message.id, cacheableResult(
        { tools: toolsForPolicy(policy) },
        { ttlMs: MCP_TOOL_LIST_TTL_MS, cacheScope: "private", serverInfo: MCP_SERVER_INFO },
      )));
      return;
    }
    if (message.method === "subscriptions/listen") {
      try {
        validateSubscriptionRequest(message);
        send(emptySubscriptionAcknowledgement(message.id));
        send(rpcResult(message.id, subscriptionCompleteResult(message.id, MCP_SERVER_INFO)));
      } catch (error) {
        if (error instanceof McpProtocolError) send(rpcError(message.id, error.code, error.message, error.data));
        else throw error;
      }
      return;
    }
    if (message.method === "tools/call") {
      await handleToolCall(message);
      return;
    }
    send(rpcError(message.id, -32601, "Method not found"));
  }

  async function handleToolCall(message) {
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
    if (pending.size >= MAX_PENDING_TOOL_CALLS) {
      send(rpcError(message.id, MCP_LIMIT_EXCEEDED, "Too many concurrent tool calls"));
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
      const result = await runtime.executeTool(name, rawArgs, { callId, origin: "stdio" });
      send(rpcResult(message.id, toolResult(result, false, MCP_SERVER_INFO)));
    } catch (error) {
      send(rpcResult(message.id, toolResult({ error: publicError(error, { verbose: verboseErrors }) }, true, MCP_SERVER_INFO)));
    } finally {
      if (key) pending.delete(key);
    }
  }
}

export function createBoundedStdioWriter({
  inputStream,
  outputStream,
  maxQueuedBytes = MAX_STDIO_OUTPUT_QUEUE_BYTES,
  onOverload = () => {},
  onFailure = () => {},
}) {
  if (!inputStream || !outputStream || !Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1) {
    throw new TypeError("stdio writer requires input/output streams and a positive integer queue limit");
  }
  let queuedBytes = 0;
  let overloaded = false;
  let outputFailed = false;
  let outputTail = Promise.resolve();
  const writes = new Set();

  const send = (message) => {
    if (message === null || message === undefined || overloaded || outputFailed) return Promise.resolve(false);
    const line = `${JSON.stringify(message)}\n`;
    const responseBytes = Buffer.byteLength(line);
    if (responseBytes > maxQueuedBytes || queuedBytes + responseBytes > maxQueuedBytes) {
      overloaded = true;
      inputStream.pause?.();
      try { onOverload({ queuedBytes, responseBytes, maxQueuedBytes }); } catch {
        // The overload state is already latched; a callback failure must not reopen input.
      }
      inputStream.destroy?.();
      return Promise.resolve(false);
    }

    queuedBytes += responseBytes;
    if (queuedBytes >= maxQueuedBytes * 0.75) inputStream.pause?.();
    let promise;
    promise = outputTail.then(async () => {
      if (!outputFailed) await writeLineRespectingBackpressure(outputStream, line);
    }).catch((error) => {
      outputFailed = true;
      try { onFailure(error); } catch {
        // The output failure is already latched; diagnostics must not replace stream shutdown.
      }
      inputStream.destroy?.();
    }).finally(() => {
      queuedBytes = Math.max(0, queuedBytes - responseBytes);
      writes.delete(promise);
      if (!overloaded && !outputFailed && queuedBytes < maxQueuedBytes / 2) inputStream.resume?.();
    });
    writes.add(promise);
    outputTail = promise;
    return promise;
  };

  const waitForPendingWrites = async () => {
    while (writes.size) await Promise.allSettled([...writes]);
  };
  return {
    send,
    waitForPendingWrites,
    get queuedBytes() { return queuedBytes; },
    get overloaded() { return overloaded; },
    get outputFailed() { return outputFailed; },
  };
}

function writeLineRespectingBackpressure(stream, line) {
  return new Promise((resolvePromise, rejectPromise) => {
    let callbackDone = false;
    let drainDone = true;
    let drainSeen = false;
    let settled = false;
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const maybeFinish = () => {
      if (settled || !callbackDone || !drainDone) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const onDrain = () => {
      drainSeen = true;
      drainDone = true;
      maybeFinish();
    };
    const onError = (error) => finishError(error);
    const onClose = () => finishError(new Error("stdio output closed before the response was flushed"));
    stream.on("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      const accepted = stream.write(line, (error) => {
        if (error) return finishError(error);
        callbackDone = true;
        maybeFinish();
      });
      if (accepted) {
        drainDone = true;
        stream.off("drain", onDrain);
      } else {
        drainDone = drainSeen;
      }
      maybeFinish();
    } catch (error) {
      finishError(error);
    }
  });
}

function parseJsonRpcLine(line, send) {
  let message;
  try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line)); } catch {
    send(rpcError(null, -32700, "Parse error"));
    return null;
  }
  if (!isJsonRpcMessage(message)) {
    send(rpcError(null, -32600, "Invalid JSON-RPC message"));
    return null;
  }
  return message;
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
      onLine(line);
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
