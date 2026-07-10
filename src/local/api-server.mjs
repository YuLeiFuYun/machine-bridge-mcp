import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "./log.mjs";

export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8765;
export const DEFAULT_API_MODEL = "chatgpt-mcp";
export const DEFAULT_API_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SAMPLING_TIMEOUT_MS = 180_000;

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

export function parseApiPort(value, fallback = DEFAULT_API_PORT) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid API port: ${value}`);
  return port;
}

export function normalizeApiHost(value, fallback = DEFAULT_API_HOST) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const host = String(value).trim();
  if (!host) return fallback;
  if (/[\\/\s]/.test(host)) throw new Error(`Invalid API host: ${value}`);
  return host;
}

export async function startLocalApiServer(options = {}) {
  const logger = options.logger || createLogger({ component: "api", quiet: options.quiet });
  const host = normalizeApiHost(options.host);
  const port = parseApiPort(options.port);
  const apiKey = String(options.apiKey || "");
  const model = String(options.model || DEFAULT_API_MODEL);
  const workerUrl = String(options.workerUrl || "").replace(/\/+$/, "");
  const daemonSecret = String(options.daemonSecret || "");
  const maxBodyBytes = Number(options.maxBodyBytes || DEFAULT_API_MAX_BODY_BYTES);
  const samplingTimeoutMs = Number(options.samplingTimeoutMs || DEFAULT_SAMPLING_TIMEOUT_MS);

  if (!apiKey) throw new Error("Local API key is missing");

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { logger, apiKey, model, workerUrl, daemonSecret, maxBodyBytes, samplingTimeoutMs });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(withPortHint(error, port));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const baseUrl = `http://${urlHost}:${actualPort}/v1`;
  logger.success("local OpenAI-compatible API started", { baseUrl, model, backend: "chatgpt-mcp", mcpBridgeConfigured: Boolean(workerUrl && daemonSecret) });

  return {
    server,
    host,
    port: actualPort,
    baseUrl,
    url: `http://${urlHost}:${actualPort}`,
    apiKey,
    model,
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

async function handleRequest(req, res, context) {
  const requestId = randomUUID().slice(0, 8);
  const started = Date.now();
  const url = new URL(req.url || "/", "http://127.0.0.1");
  setCorsHeaders(res);

  try {
    if (req.method === "OPTIONS") return sendEmpty(res, 204);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "machine-bridge-mcp-local-api",
        backend: "chatgpt-mcp",
        api_key_sha256: sha256String(context.apiKey),
        mcp_bridge_configured: Boolean(context.workerUrl && context.daemonSecret),
        model: context.model,
      });
    }

    if (!isAuthorized(req, context.apiKey)) return sendOpenAiError(res, 401, "invalid_api_key", "Missing or invalid local API key.");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      context.logger.info("request completed", { requestId, method: req.method, path: url.pathname, status: 200, durationMs: Date.now() - started });
      return sendJson(res, 200, modelsPayload(context));
    }

    if (req.method === "POST" && ["/v1/responses", "/v1/completions", "/v1/embeddings"].includes(url.pathname)) {
      return sendOpenAiError(res, 501, "unsupported_endpoint", "Only /v1/chat/completions is available through the ChatGPT MCP-backed local API. Embeddings, legacy completions, and Responses API are not exposed by MCP sampling.");
    }

    if (req.method === "POST" && url.pathname === CHAT_COMPLETIONS_PATH) {
      if (!context.workerUrl || !context.daemonSecret) {
        return sendOpenAiError(res, 503, "mcp_bridge_not_configured", "Local API is not connected to a Remote MCP bridge yet. Run `machine-mcp` normally so the Worker URL and MCP daemon secret exist, then reconnect ChatGPT to the printed MCP Server URL.");
      }
      const payload = await readJsonBody(req, context.maxBodyBytes);
      const { params: samplingRequest, modelHint } = samplingRequestFromOpenAiChat(payload, context.model);
      context.logger.info("MCP sampling request started", { requestId, path: url.pathname, modelHint: modelHint || null });
      const result = await requestMcpSampling(context, samplingRequest);
      const text = extractSamplingText(result);
      const model = String(result?.model || modelHint || context.model);
      const finishReason = finishReasonFromSampling(result);
      if (payload.stream === true) sendChatCompletionStream(res, { text, model, finishReason });
      else sendJson(res, 200, chatCompletionPayload({ text, model, finishReason }));
      context.logger.info("MCP sampling request completed", { requestId, path: url.pathname, status: res.statusCode, durationMs: Date.now() - started });
      return;
    }

    return sendOpenAiError(res, 404, "not_found", `Unknown local API endpoint: ${url.pathname}`);
  } catch (error) {
    context.logger.error("request failed", safeErrorLogFields(error, { requestId, path: url.pathname, durationMs: Date.now() - started }));
    if (!res.headersSent) {
      if (error?.code === "BODY_TOO_LARGE") return sendOpenAiError(res, 413, "request_too_large", error.message);
      if (error instanceof ApiError) return sendOpenAiError(res, error.status, error.code, error.message);
      return sendOpenAiError(res, 502, "mcp_sampling_error", error.message || "Local API request failed.");
    }
    res.destroy(error);
  }
}

function samplingRequestFromOpenAiChat(payload, advertisedModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "invalid_request_error", "Request body must be a JSON object.");
  if (!Array.isArray(payload.messages)) throw new ApiError(400, "invalid_request_error", "messages must be an array.");
  const requestedModel = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : "";
  const modelHint = requestedModel && requestedModel !== advertisedModel ? requestedModel : "";
  const messages = [];
  const systemParts = [];
  for (const message of payload.messages) {
    const role = normalizeRole(message?.role);
    const text = contentToText(message?.content);
    if (!text) continue;
    if (role === "system") systemParts.push(text);
    else messages.push({ role, content: { type: "text", text } });
  }
  if (!messages.length) throw new ApiError(400, "invalid_request_error", "No user/assistant message content was provided.");
  const params = {
    messages,
    systemPrompt: systemParts.join("\n\n") || undefined,
    maxTokens: clampInt(payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens, 1024, 1, 128000),
    stopSequences: Array.isArray(payload.stop) ? payload.stop.map(String) : typeof payload.stop === "string" ? [payload.stop] : undefined,
  };
  if (typeof payload.temperature === "number" && Number.isFinite(payload.temperature)) params.temperature = payload.temperature;
  if (modelHint) params.modelPreferences = { hints: [{ name: modelHint }] };
  return { params: removeUndefined(params), modelHint };
}

async function requestMcpSampling(context, samplingRequest) {
  let response;
  try {
    response = await fetch(`${context.workerUrl}/api/mcp/sampling`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Bridge-Token": context.daemonSecret,
      },
      body: JSON.stringify({ ...samplingRequest, timeout_ms: context.samplingTimeoutMs }),
      signal: AbortSignal.timeout(context.samplingTimeoutMs + 5_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "mcp_sampling_timeout", "Timed out waiting for the Worker and connected MCP client to complete sampling/createMessage.");
    }
    throw error;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, String(body?.error || "mcp_sampling_error"), String(body?.message || `MCP sampling request failed with HTTP ${response.status}`));
  }
  return body?.result ?? body;
}

function extractSamplingText(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (content?.type === "text" && typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(item => item?.type === "text" ? item.text : "").filter(Boolean).join("\n");
  if (typeof result?.text === "string") return result.text;
  return JSON.stringify(result ?? {});
}

function finishReasonFromSampling(result) {
  const reason = String(result?.stopReason || "").toLowerCase();
  if (reason === "maxtokens" || reason === "max_tokens" || reason === "length") return "length";
  if (reason === "tooluse" || reason === "tool_use") return "tool_calls";
  return "stop";
}

function chatCompletionPayload({ text, model, finishReason }) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage: null,
  };
}

function sendChatCompletionStream(res, { text, model, finishReason }) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const first = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  const done = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function modelsPayload(context) {
  return {
    object: "list",
    data: [{ id: context.model, object: "model", created: 0, owned_by: "chatgpt-mcp" }],
  };
}

function normalizeRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function contentToText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentPartToText).filter(Boolean).join("\n");
  return contentPartToText(content);
}

function contentPartToText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentPartToText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if ((content.type === "text" || content.type === "input_text") && typeof content.text === "string") return content.text;
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (content.type === "text" && typeof content.value === "string") return content.value;
    if (typeof content.type === "string" && content.type) {
      throw new ApiError(400, "unsupported_content", `Only text message content is supported by this MCP-backed local chat API; unsupported content part: ${content.type}.`);
    }
    return "";
  }
  return String(content);
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function readJsonBody(req, maxBytes) {
  return readBody(req, maxBytes).then(buffer => {
    try {
      const text = buffer.toString("utf8");
      return text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
    }
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        error.code = "BODY_TOO_LARGE";
        req.destroy(error);
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sha256String(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function isAuthorized(req, expectedKey) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ") && auth.slice(7) === expectedKey) return true;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey === expectedKey;
}

function sendOpenAiError(res, status, code, message) {
  return sendJson(res, status, { error: { message, type: "invalid_request_error", param: null, code } });
}

function sendJson(res, status, payload) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendEmpty(res, status) {
  res.statusCode = status;
  res.end();
}

function setCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key,openai-beta,openai-organization,openai-project");
}

function safeErrorLogFields(error, fields) {
  if (error instanceof ApiError) return { ...fields, status: error.status, code: error.code };
  if (error?.code === "BODY_TOO_LARGE") return { ...fields, status: 413, code: "request_too_large" };
  return { ...fields, error: error?.name || "Error" };
}

function withPortHint(error, port) {
  if (error?.code === "EADDRINUSE") {
    error.message = `Local API port ${port} is already in use. Re-run with \`machine-mcp --api-port <free_port>\` or \`machine-mcp api --api-port <free_port>\`.`;
  }
  if (error?.code === "EACCES") {
    error.message = `Local API port ${port} is not permitted. Re-run with \`machine-mcp --api-port <free_port>\` or \`machine-mcp api --api-port <free_port>\`.`;
  }
  return error;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
