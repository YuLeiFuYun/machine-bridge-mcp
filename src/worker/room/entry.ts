import { proxyMcpResponseStream, sanitizeBridgeRequest } from "../mcp/response-proxy.ts";
import { createThrottledEdgeLogger } from "./observability.ts";
import { applyCors, baseUrl, json, corsPreflight, mcpOriginRejection, methodNotAllowed, GEMINI_MCP_PATH, isMcpResourcePath, NATIVE_MCP_PATH, PROTECTED_RESOURCE_METADATA_PREFIX, type McpResourcePath } from "./http.ts";
import { workerToolParameterHeaders } from "../mcp/tool-catalog.ts";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import type { OAuthControllerEnv } from "../oauth/controller.ts";

type OuterBridgeStub = { fetch(request: Request): Promise<Response> };

type OuterBridgeNamespace = { getByName(name: string): OuterBridgeStub };

export interface OuterWorkerEnv {
  BRIDGE: OuterBridgeNamespace;
  STATEFUL_GLOBAL_RATE_LIMITER: RateLimit;
  STATEFUL_RATE_LIMITER: RateLimit;
  MBM_ALLOWED_ORIGINS?: string;
}

const logOuterFetchFailure = createThrottledEdgeLogger();

// One bridge-specific Durable Object per deployment is the documented topology: it
// owns OAuth clients, tokens, the daemon registry, and pending calls as one
// consistency domain. A request-supplied workspace name must never select that
// object, because it is unauthenticated and would fork authoritative state.
const BRIDGE_OBJECT_NAME = "default";

export async function handleOuterWorkerFetch(
  request: Request,
  env: OuterWorkerEnv,
  ctx: ExecutionContext,
  identity: { server: string; version: string },
): Promise<Response> {
  const extraOrigins = env.MBM_ALLOWED_ORIGINS ?? "";
  const staticResponse = respondWithoutDurableObject(request, identity, extraOrigins);
  if (staticResponse) return staticResponse;

  try {
    const globallyLimited = await admitGlobalStatefulRequest(request, env.STATEFUL_GLOBAL_RATE_LIMITER, extraOrigins);
    if (globallyLimited) return globallyLimited;
    const limited = await admitStatefulRequest(request, env.STATEFUL_RATE_LIMITER, extraOrigins);
    if (limited) return limited;
    const stub = env.BRIDGE.getByName(BRIDGE_OBJECT_NAME);
    const streamed = await proxyMcpResponseStream({ request, bridge: stub, ctx });
    return streamed ?? await stub.fetch(sanitizeBridgeRequest(request));
  } catch (error) {
    if (isDurableObjectQuotaError(error)) return durableObjectQuotaResponse(request, extraOrigins);
    logOuterFetchFailure("error", "outer.fetch.failed", {
      route: statefulRouteClass(new URL(request.url).pathname),
      error_class: outerWorkerErrorClass(error),
    });
    return workerGatewayErrorResponse(request, extraOrigins);
  }
}
type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };

const logLimiterFailure = createThrottledEdgeLogger();

export async function admitGlobalStatefulRequest(request: Request, limiter: RateLimiter, extraOrigins = ""): Promise<Response | null> {
  return admitRateLimit(request, limiter, globalStatefulRateLimitKey(request), extraOrigins);
}

export async function admitStatefulRequest(request: Request, limiter: RateLimiter, extraOrigins = ""): Promise<Response | null> {
  return admitRateLimit(request, limiter, await statefulRateLimitKey(request), extraOrigins);
}

async function admitRateLimit(request: Request, limiter: RateLimiter, key: string, extraOrigins: string): Promise<Response | null> {
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key });
  } catch {
    logLimiterFailure("warn", "stateful.rate_limiter.unavailable");
    return null;
  }
  if (result.success) return null;
  return applyCors(json({
    error: "rate_limit_exceeded",
    message: "The remote bridge is temporarily limiting stateful requests.",
    retryable: true,
  }, 429, { "retry-after": "60" }), request, baseUrl(request), extraOrigins);
}

export function isDurableObjectQuotaError(error: unknown): boolean {
  for (const current of boundedErrorChain(error)) {
    const message = current instanceof Error ? current.message : String(current ?? "");
    const code = typeof current === "object" && current !== null ? String((current as { code?: unknown }).code ?? "") : "";
    if (/Exceeded allowed volume of requests in Durable Objects free tier/i.test(message)) return true;
    if (/Durable Objects free tier/i.test(message) && /quota|limit|exceed|volume/i.test(message)) return true;
    if (code === "ERR_DURABLE_OBJECT_QUOTA_EXCEEDED") return true;
  }
  return false;
}

export function durableObjectQuotaResponse(request: Request, extraOrigins = ""): Response {
  return errorResponse(request, extraOrigins, 503, "durable_object_quota_exceeded",
    "Durable Objects free-tier capacity is exhausted until the daily UTC reset.", "3600");
}

export function workerGatewayErrorResponse(request: Request, extraOrigins = ""): Response {
  return errorResponse(request, extraOrigins, 502, "worker_gateway_error",
    "The remote bridge could not reach its durable state owner.", "1");
}

export function outerWorkerErrorClass(error: unknown): string {
  const parts: string[] = [];
  for (const current of boundedErrorChain(error)) {
    if (typeof current !== "object" || current === null) break;
    const name = String((current as { name?: unknown }).name ?? "");
    const code = String((current as { code?: unknown }).code ?? "");
    if (name) parts.push(name);
    if (code) parts.push(code);
  }
  return (parts.join(":") || "unknown").toLowerCase().replace(/[^a-z0-9._:-]/g, "_").slice(0, 160);
}

function errorResponse(request: Request, extraOrigins: string, status: number, error: string, message: string, retryAfter: string): Response {
  return applyCors(json({ error, message, retryable: true }, status, { "retry-after": retryAfter }),
    request, baseUrl(request), extraOrigins);
}

function boundedErrorChain(value: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = value;
  while (current !== undefined && chain.length < 8) {
    if (!isObjectLike(current)) {
      chain.push(current);
      break;
    }
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
const STATEFUL_METHODS = new Map([
  ["/admin/accounts", "GET, POST, PATCH, DELETE"],
  ["/admin/accounts/rotate-password", "POST"],
  ["/admin/clients", "GET, DELETE"],
  ["/daemon/http", "POST"],
  ["/daemon/ws", "GET"],
  [NATIVE_MCP_PATH, "POST"],
  [GEMINI_MCP_PATH, "POST"],
  ["/oauth/authorize", "GET, POST"],
  ["/oauth/register", "POST"],
  ["/oauth/token", "POST"],
]);

const AUTHORIZATION_METADATA_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-authorization-server/mcp/gemini",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
  "/.well-known/openid-configuration/mcp/gemini",
]);

const PROTECTED_RESOURCE_PATHS = new Map<string, McpResourcePath>([
  [PROTECTED_RESOURCE_METADATA_PREFIX, NATIVE_MCP_PATH],
  [PROTECTED_RESOURCE_METADATA_PREFIX + NATIVE_MCP_PATH, NATIVE_MCP_PATH],
  [PROTECTED_RESOURCE_METADATA_PREFIX + GEMINI_MCP_PATH, GEMINI_MCP_PATH],
]);

export function respondWithoutDurableObject(request: Request, identity: WorkerIdentity, extraOrigins = ""): Response | null {
  const url = new URL(request.url);
  const base = baseUrl(request);
  const path = url.pathname;
  if (request.method === "OPTIONS" && request.headers.has("Origin")) return corsPreflight(request, base, extraOrigins, workerToolParameterHeaders);
  if (isMcpResourcePath(path)) {
    const originRejection = mcpOriginRejection(request, base, extraOrigins);
    if (originRejection) return originRejection;
  }
  const statefulMethods = STATEFUL_METHODS.get(path);
  if (statefulMethods) {
    const allowed = new Set(statefulMethods.split(",").map((method) => method.trim()));
    if (allowed.has(request.method)) return null;
    return applyCors(methodNotAllowed(statefulMethods), request, base, extraOrigins);
  }

  const resourcePath = PROTECTED_RESOURCE_PATHS.get(path);
  let response: Response;
  if (path === "/healthz") response = getOnly(request, json({ ok: true, server: identity.server, version: identity.version }));
  else if (path === "/") response = getOnly(request, json({ ok: true, server: identity.server, version: identity.version, mcp: `${base}/mcp` }));
  else if (path === "/.well-known/mcp.json") response = getOnly(request, json(mcpMetadata(base, identity)));
  else if (AUTHORIZATION_METADATA_PATHS.has(path)) response = getOnly(request, json(authorizationServerMetadata(base, identity.server)));
  else if (resourcePath) response = getOnly(request, json(protectedResourceMetadata(base, identity.server, resourcePath)));
  else response = json({ error: "not_found" }, 404);
  return applyCors(response, request, base, extraOrigins);
}

function getOnly(request: Request, response: Response): Response {
  return request.method === "GET" ? response : methodNotAllowed("GET");
}
export type WorkerIdentity = { server: string; version: string };

export function mcpMetadata(base: string, identity: WorkerIdentity): Record<string, unknown> {
  return {
    name: identity.server,
    version: identity.version,
    protocolVersion: String(serverMetadata.protocolVersion),
    protocolVersions: serverMetadata.supportedProtocolVersions.map((value) => String(value)),
    transport: {
      type: "streamable-http",
      url: `${base}/mcp`,
      methods: ["POST"],
    },
    auth: { type: "oauth", authorization_servers: [base] },
  };
}

export function authorizationServerMetadata(base: string, serverName: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [serverName, "offline_access"],
  };
}

export function protectedResourceMetadata(base: string, serverName: string, path: McpResourcePath = NATIVE_MCP_PATH): Record<string, unknown> {
  return {
    resource: base + path,
    authorization_servers: [base],
    scopes_supported: [serverName],
    bearer_methods_supported: ["header"],
    resource_name: serverName,
  };
}
export async function statefulRateLimitKey(request: Request): Promise<string> {
  const url = new URL(request.url);
  const route = statefulRouteClass(url.pathname);
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const credential = authorization.match(/^[A-Za-z][A-Za-z0-9_-]*\s+(.+)$/)?.[1]?.trim() ?? "";
  if (route === "mcp" && credential) return `stateful:${route}:auth:${await opaqueDigest(credential)}`;

  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (clientAddress) return `stateful:${route}:network:${await opaqueDigest(clientAddress)}`;
  return `stateful:${route}:anonymous:${url.host.toLowerCase()}`;
}

export function globalStatefulRateLimitKey(request: Request): string {
  const url = new URL(request.url);
  return `stateful:global:${statefulRouteClass(url.pathname)}:${url.host.toLowerCase()}`;
}

export function statefulRouteClass(pathname: string): string {
  if (isMcpResourcePath(pathname)) return "mcp";
  if (pathname === "/daemon/ws" || pathname === "/daemon/http") return "daemon";
  if (pathname.startsWith("/oauth/")) return "oauth";
  if (pathname.startsWith("/admin/")) return "admin";
  return "other";
}

async function opaqueDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BridgeEnv extends OAuthControllerEnv {
  BRIDGE: DurableObjectNamespace;
  DAEMON_DEVICE_PUBLIC_KEY: string;
  OAUTH_TOKEN_VERSION: string;
  MBM_WORKER_MAX_BODY_BYTES?: string;
  MBM_ALLOWED_ORIGINS?: string;
  STATEFUL_GLOBAL_RATE_LIMITER: RateLimit;
  STATEFUL_RATE_LIMITER: RateLimit;
}

export function workerBodyLimitBytes(configured: string | undefined): number {
  const parsed = Number.parseInt(configured ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(parsed, MAX_BODY_BYTES);
}
interface WorkerTaskContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function retainWorkerTask(
  context: WorkerTaskContext,
  task: Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  const retained = Promise.resolve(task).then(
    () => undefined,
    (error) => {
      try { onError(error); } catch { /* diagnostic callbacks must not create a second rejection */ }
    },
  );
  context.waitUntil(retained);
  return retained;
}
