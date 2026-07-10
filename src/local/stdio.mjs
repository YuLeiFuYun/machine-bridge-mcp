import readline from "node:readline";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LocalDaemon } from "./daemon.mjs";
import { formatFields, sanitizeLogText } from "./log.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  rpcError,
  rpcResult,
  toolResult,
  toolsForPolicy,
} from "./tools.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);

export async function runStdioServer({ workspace, policy, verbose = false }) {
  const logger = stderrLogger(verbose);
  const runtime = new LocalDaemon({ workspace, policy, logger });
  const pending = new Map();
  let negotiatedVersion = MCP_PROTOCOL_VERSION;
  let initialized = false;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const writes = new Set();
  const send = (message) => {
    if (message === null || message === undefined) return;
    const line = `${JSON.stringify(message)}\n`;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      process.stdout.write(line, (error) => error ? rejectPromise(error) : resolvePromise());
    }).finally(() => writes.delete(promise));
    writes.add(promise);
  };

  rl.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      send(rpcError(null, -32600, "JSON-RPC message exceeds maximum size"));
      return;
    }
    void handleLine(line).catch((error) => {
      logger.error("stdio request handler failed", { error: errorMessage(error) });
    });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    rl.once("close", resolvePromise);
    rl.once("error", rejectPromise);
  });
  for (const callId of pending.values()) runtime.cancelCall(callId, "stdio input closed");
  await Promise.allSettled([...writes]);
  runtime.stop();

  async function handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      send(rpcError(null, -32700, "Parse error"));
      return;
    }
    if (!isJsonRpcMessage(message)) {
      send(rpcError(null, -32600, "Invalid JSON-RPC message"));
      return;
    }
    if (typeof message.method !== "string") return;

    if (message.method === "initialize") {
      const requested = asObject(message.params).protocolVersion;
      negotiatedVersion = typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      initialized = true;
      send(rpcResult(message.id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: {
          name: "machine-bridge-mcp",
          title: "Machine Bridge MCP",
          version: PACKAGE_VERSION,
          description: "Workspace-scoped local coding tools over MCP stdio or authenticated remote relay.",
        },
        instructions: MCP_INSTRUCTIONS,
      }));
      return;
    }

    if (message.method === "notifications/initialized") return;
    if (message.method === "notifications/cancelled") {
      const requestId = asObject(message.params).requestId;
      const key = jsonRpcIdKey(requestId);
      const callId = pending.get(key);
      if (callId) runtime.cancelCall(callId, "MCP cancellation notification");
      return;
    }
    if (message.method === "logging/setLevel") {
      send(rpcResult(message.id, {}));
      return;
    }
    if (message.method === "ping") {
      send(rpcResult(message.id, {}));
      return;
    }
    if (!initialized) {
      send(rpcError(message.id, -32002, "Server is not initialized"));
      return;
    }
    if (message.method === "tools/list") {
      send(rpcResult(message.id, { tools: toolsForPolicy(policy) }));
      return;
    }
    if (message.method === "tools/call") {
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
      const started = Date.now();
      logger.debug("tool call started", { call_id: callId.slice(0, 20), tool: name });
      try {
        const result = await runtime.executeTool(name, args, { callId });
        send(rpcResult(message.id, toolResult(result)));
        logger.info("tool call completed", { call_id: callId.slice(0, 20), tool: name, duration_ms: Date.now() - started, ok: true });
      } catch (error) {
        const safeError = runtime.safeErrorMessage(error);
        send(rpcResult(message.id, toolResult({ error: safeError }, true)));
        logger.warn("tool call failed", { call_id: callId.slice(0, 20), tool: name, duration_ms: Date.now() - started, ok: false, error_class: classifyError(error) });
      } finally {
        if (key) pending.delete(key);
        runtime.finishCall(callId);
      }
      return;
    }
    send(rpcError(message.id, -32601, `Method not found: ${message.method}`));
  }
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

function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(message)) return "cancelled";
  if (/timed out/i.test(message)) return "timeout";
  if (/outside the configured workspace/i.test(message)) return "path_boundary";
  if (/disabled|requires .* mode/i.test(message)) return "policy_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/maximum|exceeds|max_bytes|too many/i.test(message)) return "limit_exceeded";
  if (/invalid|must|requires|ambiguous|mismatch/i.test(message)) return "invalid_request";
  return "execution_failed";
}

function errorMessage(error) {
  return sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 4096) || "tool call failed";
}

function stderrLogger(verbose) {
  const write = (level, message, fields) => {
    if (level === "debug" && !verbose) return;
    process.stderr.write(`[${level}] stdio: ${sanitizeLogText(message)}${formatFields(fields)}\n`);
  };
  return {
    info(message, fields) { write("info", message, fields); },
    warn(message, fields) { write("warn", message, fields); },
    error(message, fields) { write("error", message, fields); },
    debug(message, fields) { write("debug", message, fields); },
  };
}
