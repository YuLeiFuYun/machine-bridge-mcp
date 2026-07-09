import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger } from "./log.mjs";

export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8765;
export const DEFAULT_UPSTREAM_URL = "https://api.openai.com/v1";
export const DEFAULT_UPSTREAM_MODEL = "gpt-4.1-mini";
export const DEFAULT_API_MAX_BODY_BYTES = 32 * 1024 * 1024;

const PROXY_ROUTES = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/completions",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key",
]);

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
  if (/[/\\\s]/.test(host)) throw new Error(`Invalid API host: ${value}`);
  return host;
}

export function normalizeBaseUrl(value, fallback = DEFAULT_UPSTREAM_URL) {
  const raw = value === undefined || value === null || value === true || value === "" ? fallback : String(value).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid upstream API URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Invalid upstream API URL protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error("Upstream API URL must not contain credentials; pass keys with --api-upstream-key or environment variables.");
  if (parsed.search || parsed.hash) throw new Error("Upstream API URL must be a base URL without query strings or fragments.");
  return parsed.toString().replace(/\/+$/, "");
}

export async function startLocalApiServer(options = {}) {
  const logger = options.logger || createLogger({ component: "api", quiet: options.quiet });
  const host = normalizeApiHost(options.host);
  const port = parseApiPort(options.port);
  const apiKey = String(options.apiKey || "");
  const upstreamUrl = normalizeBaseUrl(options.upstreamUrl);
  const upstreamKey = String(options.upstreamKey || "");
  const upstreamModel = String(options.upstreamModel || options.model || DEFAULT_UPSTREAM_MODEL);
  const loadConfig = typeof options.loadConfig === "function" ? options.loadConfig : null;
  const maxBodyBytes = Number(options.maxBodyBytes || DEFAULT_API_MAX_BODY_BYTES);

  if (!apiKey) throw new Error("Local API key is missing");

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { logger, apiKey, upstreamUrl, upstreamKey, upstreamModel, loadConfig, maxBodyBytes });
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
  logger.success("local OpenAI-compatible API proxy started", { baseUrl, upstream: upstreamUrl, upstreamModel, upstreamConfigured: Boolean(upstreamKey), chatgptWebBacked: false });

  return {
    server,
    host,
    port: actualPort,
    baseUrl,
    url: `http://${urlHost}:${actualPort}`,
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
    const config = await currentConfig(context);
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "machine-bridge-mcp-local-api", api_key_sha256: sha256String(context.apiKey), upstream_configured: Boolean(config.upstreamKey), upstream_model: config.upstreamModel, chatgpt_web_backed: false });

    if (!isAuthorized(req, context.apiKey)) return sendOpenAiError(res, 401, "invalid_api_key", "Missing or invalid local API key.");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      context.logger.info("request completed", { requestId, method: req.method, path: url.pathname, status: 200, durationMs: Date.now() - started });
      return sendJson(res, 200, modelsPayload(config));
    }

    if (req.method === "POST" && PROXY_ROUTES.has(url.pathname)) {
      if (!config.upstreamKey) {
        return sendOpenAiError(res, 503, "upstream_not_configured", missingUpstreamMessage());
      }
      context.logger.info("proxy request started", { requestId, path: url.pathname, upstream: config.upstreamUrl });
      await proxyRequest(req, res, url, { ...context, ...config });
      context.logger.info("proxy request completed", { requestId, path: url.pathname, status: res.statusCode, durationMs: Date.now() - started });
      return;
    }

    return sendOpenAiError(res, 404, "not_found", `Unknown local API endpoint: ${url.pathname}`);
  } catch (error) {
    context.logger.error("request failed", { requestId, path: url.pathname, error: error.message, durationMs: Date.now() - started });
    if (!res.headersSent) {
      if (error?.code === "BODY_TOO_LARGE") return sendOpenAiError(res, 413, "request_too_large", error.message);
      return sendOpenAiError(res, 502, "upstream_error", error.message || "Local API request failed.");
    }
    res.destroy(error);
  }
}


async function currentConfig(context) {
  let dynamic = {};
  if (context.loadConfig) {
    try {
      dynamic = await context.loadConfig();
    } catch (error) {
      context.logger.warn("could not reload local API configuration", { error: error.message });
    }
  }
  return {
    upstreamUrl: normalizeBaseUrl(dynamic.upstreamUrl || context.upstreamUrl),
    upstreamKey: String(dynamic.upstreamKey || context.upstreamKey || ""),
    upstreamModel: String(dynamic.upstreamModel || context.upstreamModel || DEFAULT_UPSTREAM_MODEL),
  };
}

function missingUpstreamMessage() {
  return "This local OpenAI-compatible endpoint is not backed by ChatGPT web. ChatGPT web connects to your machine through the Remote MCP bridge, not through /v1/chat/completions. To use this endpoint with desktop clients, configure a separate OpenAI-compatible model API provider with `machine-mcp api configure`, or disable it with `machine-mcp --no-api`.";
}

async function proxyRequest(req, res, url, context) {
  const body = await readBody(req, context.maxBodyBytes);
  const outboundBody = normalizeJsonModel(body, req.headers["content-type"], context);
  const upstreamTarget = `${context.upstreamUrl}${url.pathname.slice(3)}${url.search}`;
  const headers = copyProxyHeaders(req.headers, context.upstreamKey);
  const response = await fetch(upstreamTarget, {
    method: "POST",
    headers,
    body: outboundBody,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}


function normalizeJsonModel(body, contentType, context) {
  if (!String(contentType || "").toLowerCase().includes("application/json")) return body;
  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return body;
    if (!payload.model) payload.model = context.upstreamModel;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function copyProxyHeaders(source, upstreamKey) {
  const out = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) out.set(key, value.join(", "));
    else if (value !== undefined) out.set(key, String(value));
  }
  out.set("authorization", `Bearer ${upstreamKey}`);
  if (!out.has("content-type")) out.set("content-type", "application/json");
  return out;
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

function modelsPayload(config) {
  if (!config.upstreamKey) return { object: "list", data: [] };
  return {
    object: "list",
    data: [{
      id: config.upstreamModel,
      object: "model",
      created: 0,
      owned_by: "upstream",
    }],
  };
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

function withPortHint(error, port) {
  if (error?.code === "EADDRINUSE") {
    error.message = `Local API port ${port} is already in use. Re-run with \`machine-mcp --api-port <free_port>\` or \`machine-mcp api --api-port <free_port>\`.`;
  }
  if (error?.code === "EACCES") {
    error.message = `Local API port ${port} is not permitted. Re-run with \`machine-mcp --api-port <free_port>\` or \`machine-mcp api --api-port <free_port>\`.`;
  }
  return error;
}
