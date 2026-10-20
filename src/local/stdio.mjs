import { randomBytes } from "node:crypto";
import { MAX_TOOL_RESULT_BYTES } from "./tool-result-boundary.mjs";
import { LocalRuntime } from "./runtime.mjs";
import { packageVersion } from "./package-identity.mjs";
import { validateToolArguments } from "./tool-executor.mjs";
import { classifyOperationalError, createLogger } from "./log.mjs";
import { actionableGuidance, publicError } from "./errors.mjs";
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
  completeResult, discoverResult, emptySubscriptionAcknowledgement, progressNotification, serverImplementation, subscriptionCompleteResult,
  validateRequestMetadata, validateSubscriptionRequest,
} from "../shared/mcp-protocol.mjs";
import { createProgressReporter } from "../shared/progress-reporter.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS = 32;
// One tool result may legally reach MAX_TOOL_RESULT_BYTES, so the queue must never be
// sized like a single result: two maximum-size results must be able to wait for a slow
// client at the same time. The reserve keeps room for the rejection error of a response
// that did not fit, which is what lets the transport stay alive instead of being torn down.
const MAX_STDIO_OUTPUT_QUEUE_BYTES = MAX_TOOL_RESULT_BYTES * 2 + 4 * 1024 * 1024;
const MAX_STDIO_OUTPUT_RESERVE_BYTES = 64 * 1024;
const MCP_SERVER_INFO = Object.freeze(serverImplementation({
  name: SERVER_NAME, title: "Machine Bridge MCP", version: packageVersion,
  description: "Workspace-scoped local coding tools over MCP stdio or authenticated remote relay.",
}));
const MCP_SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({ listChanged: false }),
  prompts: Object.freeze({ listChanged: false }),
  resources: Object.freeze({}),
});
const MCP_DISCOVERY_TTL_MS = 0;
const MCP_TOOL_LIST_TTL_MS = 0;
const MCP_LIMIT_EXCEEDED = -31900;

export async function runStdioServer({
  workspace, policy, logLevel = "info", jobRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "",
  serviceControlRoot = "", verboseErrors = process.env.MBM_VERBOSE_ERRORS === "1",
}) {
  const logger = createLogger({ component: "stdio", level: logLevel, stderrOnly: true, color: false });
  const runtime = new LocalRuntime({ workspace, policy, logger, jobRoot, resources, resourceStatePath, browserStateRoot, serviceControlRoot });
  const pending = new Map();
  const requestHandlers = new Set();
  const inputState = { closed: false };
  const outputWriter = createBoundedStdioWriter({
    inputStream: process.stdin,
    outputStream: process.stdout,
    maxQueuedBytes: MAX_STDIO_OUTPUT_QUEUE_BYTES,
    onOverload: (details) => {
      // A single rejected response is a bounded, reported failure the client can act on;
      // only a latched overload means the transport itself became unusable.
      if (outputWriter.overloaded) process.exitCode = 1;
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
  inputState.closed = true;
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
      send(rpcError(message.id, -32601, MCP_REMOVED_PROTOCOL_MESSAGE, { supported: [...MCP_PROTOCOL_VERSIONS] }));
      return;
    }
    try {
      const metadata = validateRequestMetadata(message, MCP_PROTOCOL_VERSIONS);
      await handleMessage(message, metadata);
    } catch (error) {
      if (error instanceof McpProtocolError) {
        send(rpcError(message.id, error.code, error.message, error.data));
        return;
      }
      throw error;
    }
  }

  function cancelRequest(message) {
    const requestId = asObject(message.params).requestId;
    const callId = pending.get(jsonRpcIdKey(requestId));
    if (callId) runtime.cancelCall(callId, "MCP cancellation notification");
  }

  async function handleMessage(message, metadata = null) {
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
      await handleStdioToolCall({ message, progressToken: metadata?.progressToken, policy, pending, runtime, send, verboseErrors, inputState });
      return;
    }
    if (message.method === "prompts/list" || message.method === "prompts/get") {
      await executePromptOperation(runtime, message.method, message, send, verboseErrors);
      return;
    }
    if (message.method === "resources/list" || message.method === "resources/templates/list" || message.method === "resources/read") {
      await executeResourceOperation(runtime, message.method, message, send, verboseErrors);
      return;
    }
    send(rpcError(message.id, -32601, "Method not found"));
  }
}

async function handleStdioToolCall({ message, progressToken, policy, pending, runtime, send, verboseErrors, inputState }) {
  // EOF can race a request handler that has not registered its call ID yet. Do not
  // start a side effect after the input transport has closed.
  if (inputState.closed) return;
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
    const result = await withProgress(progressToken, name, send, () => runtime.executeTool(name, rawArgs, { callId, origin: "stdio" }));
    send(rpcResult(message.id, toolResult(result, false, MCP_SERVER_INFO)));
  } catch (error) {
    const errorObject = publicError(error, { verbose: verboseErrors });
    const remedy = actionableGuidance(error);
    if (remedy && !errorObject.actionable_remedy) errorObject.actionable_remedy = remedy;
    send(rpcResult(message.id, toolResult({ error: errorObject }, true, MCP_SERVER_INFO)));
  } finally {
    if (key) pending.delete(key);
  }
}

async function executePromptOperation(runtime, method, message, send, verboseErrors) {
  const callId = `stdio_prompt_${randomBytes(16).toString("hex")}`;
  const params = asObject(message.params);
  try {
    if (method === "prompts/list") {
      const prompts = [
        {
          name: "agent_instructions",
          description: "Project-specific developer instructions and operating constraints",
          arguments: [],
        },
        {
          name: "code_review",
          description: "Review current staged or unstaged git changes",
          arguments: [
            { name: "staged", description: "Whether to review staged changes only (boolean)", required: false },
          ],
        },
        {
          name: "run_skill",
          description: "Load instructions for a discovered local agent skill; loading does not execute its files",
          arguments: [
            { name: "skill", description: "Name of the skill to load", required: true },
          ],
        },
      ];
      send(rpcResult(message.id, completeResult({ prompts }, MCP_SERVER_INFO)));
      return;
    }
    if (method === "prompts/get") {
      const name = String(params.name || "");
      if (!name) {
        send(rpcError(message.id, -32602, "prompts/get requires a prompt name"));
        return;
      }
      const args = asObject(params.arguments);
      if (name === "agent_instructions") {
        if (Object.keys(args).length) {
          send(rpcError(message.id, -32602, "agent_instructions does not accept arguments"));
          return;
        }
        const result = await runtime.executeTool("agent_context", {}, { callId, origin: "stdio" });
        const instructions = result?.instructions || result?.agent_instructions || "No specific instructions configured.";
        send(rpcResult(message.id, completeResult({
          description: "Project developer instructions",
          messages: [{ role: "user", content: { type: "text", text: String(instructions) } }],
        }, MCP_SERVER_INFO)));
        return;
      }
      if (name === "code_review") {
        if (Object.keys(args).some((key) => key !== "staged") || (args.staged !== undefined && typeof args.staged !== "boolean")) {
          send(rpcError(message.id, -32602, "code_review accepts only an optional boolean staged argument"));
          return;
        }
        const staged = args.staged === true;
        const diffResult = await runtime.executeTool("git_diff", { staged }, { callId, origin: "stdio" });
        const diffText = String(diffResult?.diff || diffResult?.output || "No changes found.");
        send(rpcResult(message.id, completeResult({
          description: `Code review prompt for ${staged ? "staged" : "unstaged"} changes`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Please review the following git diff for correctness, security, and architecture:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
              },
            },
          ],
        }, MCP_SERVER_INFO)));
        return;
      }
      if (name === "run_skill") {
        const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
        if (!skillName || Object.keys(args).some((key) => key !== "skill")) {
          send(rpcError(message.id, -32602, "run_skill requires only a non-empty skill argument"));
          return;
        }
        const skillResult = await runtime.executeTool("load_local_skill", { skill: skillName }, { callId, origin: "stdio" });
        const content = String(skillResult?.content || skillResult?.skill?.content || JSON.stringify(skillResult));
        send(rpcResult(message.id, completeResult({
          description: `Skill: ${skillName}`,
          messages: [{ role: "user", content: { type: "text", text: content } }],
        }, MCP_SERVER_INFO)));
        return;
      }
      send(rpcError(message.id, -32602, `Unknown prompt: ${name}`));
      return;
    }
  } catch (error) {
    send(rpcError(message.id, -32603, "Prompt operation failed", publicError(error, { verbose: verboseErrors })));
  }
}

async function executeResourceOperation(runtime, method, message, send, verboseErrors) {
  const callId = `stdio_res_${randomBytes(16).toString("hex")}`;
  const params = asObject(message.params);
  try {
    if (method === "resources/list") {
      const resources = [
        {
          uri: "diff://workspace/unstaged",
          name: "Unstaged Git Diff",
          description: "Current unstaged working directory git diff",
          mimeType: "text/x-diff",
        },
        {
          uri: "diff://workspace/staged",
          name: "Staged Git Diff",
          description: "Current staged git index diff",
          mimeType: "text/x-diff",
        },
        {
          uri: "diag://runtime/status",
          name: "Runtime Diagnostics",
          description: "Machine Bridge local runtime and host status snapshot",
          mimeType: "application/json",
        },
      ];
      send(rpcResult(message.id, { resources }));
      return;
    }
    if (method === "resources/templates/list") {
      const resourceTemplates = [
        {
          uriTemplate: "diff://workspace/{mode}",
          name: "Workspace Git Diff",
          description: "Workspace git diff for mode 'staged' or 'unstaged'",
          mimeType: "text/x-diff",
        },
      ];
      send(rpcResult(message.id, { resourceTemplates }));
      return;
    }
    if (method === "resources/read") {
      const uri = String(params.uri || "");
      if (!uri) {
        send(rpcError(message.id, -32602, "resources/read requires a uri"));
        return;
      }
      if (uri === "diff://workspace/staged" || uri === "diff://workspace/unstaged") {
        const staged = uri === "diff://workspace/staged";
        const result = await runtime.executeTool("git_diff", { staged }, { callId, origin: "stdio" });
        const text = String(result?.diff || result?.output || "");
        send(rpcResult(message.id, {
          contents: [{ uri, mimeType: "text/x-diff", text }],
        }));
        return;
      }
      if (uri === "diag://runtime/status") {
        const result = await runtime.executeTool("diagnose_runtime", {}, { callId, origin: "stdio" });
        send(rpcResult(message.id, {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
        }));
        return;
      }
      send(rpcError(message.id, -32602, `Unsupported resource URI: ${uri}`));
      return;
    }
  } catch (error) {
    send(rpcResult(message.id, { error: publicError(error, { verbose: verboseErrors }) }));
  }
}

export function createBoundedStdioWriter({
  inputStream,
  outputStream,
  maxQueuedBytes = MAX_STDIO_OUTPUT_QUEUE_BYTES,
  reserveBytes = MAX_STDIO_OUTPUT_RESERVE_BYTES,
  onOverload = () => {},
  onFailure = () => {},
}) {
  if (!inputStream || !outputStream || !Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1
    || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new TypeError("stdio writer requires input/output streams and a positive integer queue limit");
  }
  let queuedBytes = 0;
  let overloaded = false;
  let outputFailed = false;
  let outputTail = Promise.resolve();
  const writes = new Set();

  const handleOutputError = (error) => {
    if (outputFailed) return;
    outputFailed = true;
    try { onFailure(error); } catch {
      // The output failure is already latched; diagnostics must not replace stream shutdown.
    }
    inputStream.destroy?.();
  };
  outputStream.on?.("error", handleOutputError);

  const enqueue = (line, responseBytes) => {
    queuedBytes += responseBytes;
    if (queuedBytes >= maxQueuedBytes * 0.75) inputStream.pause?.();
    let promise;
    promise = outputTail.then(async () => {
      if (!outputFailed) await writeLineRespectingBackpressure(outputStream, line);
    }).catch((error) => {
      handleOutputError(error);
    }).finally(() => {
      queuedBytes = Math.max(0, queuedBytes - responseBytes);
      writes.delete(promise);
      if (!overloaded && !outputFailed && queuedBytes < maxQueuedBytes / 2) inputStream.resume?.();
    });
    writes.add(promise);
    outputTail = promise;
    return promise;
  };

  const send = (message) => {
    if (message === null || message === undefined || overloaded || outputFailed) return Promise.resolve(false);
    const line = `${JSON.stringify(message)}\n`;
    const responseBytes = Buffer.byteLength(line);
    if (responseBytes <= maxQueuedBytes && queuedBytes + responseBytes <= maxQueuedBytes) {
      return enqueue(line, responseBytes);
    }
    const details = { queuedBytes, responseBytes, maxQueuedBytes };
    const rejection = rejectionFor(message, details);
    if (rejection === null) {
      // Notifications carry no request id, so there is nothing to answer; dropping one is
      // bounded and must not cost the transport.
      try { onOverload(details); } catch {
        // Diagnostics must not change the drop decision.
      }
      return Promise.resolve(false);
    }
    const rejectionLine = `${JSON.stringify(rejection)}\n`;
    const rejectionBytes = Buffer.byteLength(rejectionLine);
    if (queuedBytes + rejectionBytes <= maxQueuedBytes + reserveBytes) {
      try { onOverload(details); } catch {
        // Diagnostics must not change the rejection decision.
      }
      return enqueue(rejectionLine, rejectionBytes);
    }
    // Even the rejection cannot be queued: the client stopped reading, so the stream
    // cannot stay consistent. This is the only path that tears the transport down.
    overloaded = true;
    inputStream.pause?.();
    try { onOverload(details); } catch {
      // The overload state is already latched; a callback failure must not reopen input.
    }
    inputStream.destroy?.();
    return Promise.resolve(false);
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

// A client that supplies a progress token is told the call is still alive; one that does not
// pays nothing. Reporting stops when the operation settles, so no notification can trail the
// response that answers the same request.
async function withProgress(progressToken, label, send, run) {
  const stop = createProgressReporter({
    progressToken,
    label,
    emit: (params) => { send(progressNotification(params)); },
  });
  try {
    return await run();
  } finally {
    stop();
  }
}

// Every response with an id, including an existing error response, needs a bounded rejection if it cannot be queued.
function rejectionFor(message, details) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (!("id" in message) || message.id === null || message.id === undefined) return null;
  return rpcError(message.id, MCP_LIMIT_EXCEEDED, "Response exceeds the stdio output queue limit", details);
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
