import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LocalRuntime } from "./runtime.mjs";
import { classifyOperationalError, createLogger } from "./log.mjs";
import { publicError } from "./errors.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_NAME,
  rpcError,
  rpcResult,
  toolResult,
  toolsForPolicy,
} from "./tools.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);

export async function runStdioServer({ workspace, policy, logLevel = "info", jobRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "" }) {
  const logger = createLogger({ component: "stdio", level: logLevel, stderrOnly: true, color: false });
  const runtime = new LocalRuntime({ workspace, policy, logger, jobRoot, resources, resourceStatePath, browserStateRoot });
  const pending = new Map();
  let negotiatedVersion = MCP_PROTOCOL_VERSION;
  let initialized = false;

  const writes = new Set();
  const send = (message) => {
    if (message === null || message === undefined) return;
    const line = `${JSON.stringify(message)}\n`;
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
    if (!message || typeof message.method !== "string") return;
    if (await handleControlMessage(message)) return;
    if (!initialized) {
      send(rpcError(message.id, -32002, "Server is not initialized"));
      return;
    }
    await handleInitializedMessage(message);
  }

  async function handleControlMessage(message) {
    if (message.method === "initialize") {
      const requested = asObject(message.params).protocolVersion;
      negotiatedVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      initialized = true;
      send(rpcResult(message.id, await initializationResult(negotiatedVersion, runtime)));
      return true;
    }
    if (message.method === "notifications/initialized") return true;
    if (message.method === "notifications/cancelled") {
      const requestId = asObject(message.params).requestId;
      const callId = pending.get(jsonRpcIdKey(requestId));
      if (callId) runtime.cancelCall(callId, "MCP cancellation notification");
      return true;
    }
    if (message.method === "logging/setLevel" || message.method === "ping") {
      send(rpcResult(message.id, {}));
      return true;
    }
    return false;
  }

  async function handleInitializedMessage(message) {
    if (message.method === "tools/list") {
      send(rpcResult(message.id, { tools: toolsForPolicy(policy) }));
      return;
    }
    if (message.method === "tools/call") {
      await handleToolCall(message);
      return;
    }
    send(rpcError(message.id, -32601, `Method not found: ${message.method}`));
  }

  async function handleToolCall(message) {
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
    const args = asObject(params.arguments);
    const callId = `stdio_${randomBytes(16).toString("hex")}`;
    const key = jsonRpcIdKey(message.id);
    if (key && pending.has(key)) {
      send(rpcError(message.id, -32600, "Duplicate in-flight JSON-RPC request id"));
      return;
    }
    if (key) pending.set(key, callId);
    try {
      const result = await runtime.executeTool(name, args, { callId, origin: "stdio" });
      send(rpcResult(message.id, toolResult(result)));
    } catch (error) {
      send(rpcResult(message.id, toolResult({ error: publicError(error) }, true)));
    } finally {
      if (key) pending.delete(key);
    }
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

async function initializationResult(protocolVersion, runtime) {
  const bootstrap = await runtime.sessionBootstrap({ path: "." }).catch((error) => {
    runtime.logger?.debug?.("session bootstrap unavailable during initialize", { error_class: classifyOperationalError(error) });
    return null;
  });
  const localInstructions = bootstrap?.instructions ? `\n\n--- LOCAL SESSION INSTRUCTIONS ---\n${bootstrap.instructions}` : "";
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false }, logging: {} },
    serverInfo: {
      name: SERVER_NAME,
      title: "Machine Bridge MCP",
      version: PACKAGE_VERSION,
      description: "Workspace-scoped local coding tools over MCP stdio or authenticated remote relay.",
    },
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
