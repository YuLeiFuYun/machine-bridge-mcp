const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export const BUILT_IN_BROWSER_ORIGINS = Object.freeze([
  "https://chatgpt.com",
  "https://grok.com",
  "https://x.com",
]);

const BUILT_IN_BROWSER_ORIGIN_SET = new Set(BUILT_IN_BROWSER_ORIGINS);

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: {
      allow,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function oauthRedirect(location: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: location.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function authorizationRedirectLocation(redirectUri: string, code: string, state: string, issuer: string): URL {
  const location = new URL(redirectUri);
  location.searchParams.append("code", code);
  if (state) location.searchParams.append("state", state);
  location.searchParams.append("iss", issuer);
  return location;
}

export function json(value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const [name, headerValue] of new Headers(extraHeaders)) headers.set(name, headerValue);
  return new Response(JSON.stringify(value), { status, headers });
}

export function html(value: string, status = 200, formActionOrigin = ""): Response {
  const allowedFormActions = new Set(["'self'"]);
  for (const source of authorizationFormActionSources(formActionOrigin)) allowedFormActions.add(source);
  const formAction = [...allowedFormActions].join(" ");
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function authorizationFormActionSources(value: string): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    if (url.origin === "null") return [];
    const sources = [url.origin];
    const microsoftConsentHost = url.hostname === "consent.azure-apim.net" || url.hostname.endsWith(".consent.azure-apim.net");
    if (url.protocol === "https:" && !url.port && microsoftConsentHost) {
      // Power Platform redirects global consent to a regional endpoint and then back to Copilot Studio; CSP checks every hop.
      sources.push("https://*.consent.azure-apim.net", "https://copilotstudio.microsoft.com");
    }
    return sources;
  } catch {
    // Invalid values are ignored; callers pass a validated OAuth redirect origin.
    return [];
  }
}

export function baseUrl(request: Request): string {
  return new URL(request.url).origin;
}

export function oauthAccessToken(request: Request): { scheme: "bearer" | "dpop" | ""; token: string } {
  const match = (request.headers.get("Authorization") ?? "").match(/^(Bearer|DPoP)\s+(.+)$/i);
  if (!match) return { scheme: "", token: "" };
  return { scheme: match[1].toLowerCase() as "bearer" | "dpop", token: match[2].trim() };
}

export async function parseJsonRequest(request: Request, limit: number): Promise<unknown> {
  const text = await readBoundedText(request, limit);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export async function parseRequestBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBoundedText(request, limit);
  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "bad_request", "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  return searchParamsObject(new URLSearchParams(text));
}

export async function discardRequestBody(request: Pick<Request, "body" | "headers">, limit: number): Promise<{ bytes_read: number; exceeded: boolean }> {
  const boundedLimit = normalizeBodyLimit(limit);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  const declaredExceeded = Number.isFinite(declaredLength) && declaredLength > boundedLimit;
  if (!request.body) return { bytes_read: 0, exceeded: declaredExceeded };
  const reader = request.body.getReader();
  let observed = 0;
  try {
    if (declaredExceeded) {
      await cancelBodyReader(reader);
      return { bytes_read: 0, exceeded: true };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes_read: observed, exceeded: false };
      if (!value) continue;
      observed = Math.min(boundedLimit + 1, observed + value.byteLength);
      if (observed > boundedLimit) {
        await cancelBodyReader(reader);
        return { bytes_read: observed, exceeded: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedBytes(
  request: Pick<Request, "body" | "headers">,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const boundedLimit = normalizeBodyLimit(limit);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  const declaredExceeded = Number.isFinite(declaredLength) && declaredLength > boundedLimit;
  const reader = request.body?.getReader();
  if (declaredExceeded) {
    if (reader) {
      try { await cancelBodyReader(reader); } finally { reader.releaseLock(); }
    }
    throw new HttpError(413, "request_body_too_large", `request body exceeds ${boundedLimit} bytes`);
  }
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let observed = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const nextObserved = Math.min(boundedLimit + 1, observed + value.byteLength);
      if (observed + value.byteLength <= boundedLimit) chunks.push(value);
      else { exceeded = true; await cancelBodyReader(reader); }
      observed = nextObserved;
      if (exceeded) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (exceeded) throw new HttpError(413, "request_body_too_large", `request body exceeds ${boundedLimit} bytes`);
  const combined = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

export async function readBoundedText(request: Pick<Request, "body" | "headers">, limit: number): Promise<string> {
  const combined = await readBoundedBytes(request, limit);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new HttpError(400, "invalid_encoding", "Request body must be valid UTF-8");
  }
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel("request body limit reached");
  } catch {
    // Cancellation is cleanup after the size decision; it must not replace the bounded response.
  }
}

function normalizeBodyLimit(value: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function normalizeRedirectUri(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:" && url.hostname) return url.toString();
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

export function mcpOriginRejection(request: Request, base: string, configured: string): Response | null {
  const origin = request.headers.get("Origin") ?? "";
  if (!origin || isConfiguredOrSameOrigin(origin, base, configured)) return null;
  return json({ error: "origin_not_allowed" }, 403);
}

export function corsPreflight(
  request: Request, base: string, configured: string, allowedParameterHeaders: ReadonlySet<string> = EMPTY_CORS_HEADER_SET,
): Response {
  const origin = request.headers.get("Origin") ?? "";
  if (!isConfiguredOrSameOrigin(origin, base, configured)) return json({ error: "origin_not_allowed" }, 403);
  const requestedMethod = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (requestedMethod && !["GET", "POST"].includes(requestedMethod)) return methodNotAllowed("GET, POST, OPTIONS");
  const requestedHeaders = requestedCorsHeaders(request);
  if (!requestedHeaders) return json({ error: "cors_header_invalid" }, 400);
  const rejected = requestedHeaders.filter((name) => !isAllowedMcpCorsHeader(name, allowedParameterHeaders));
  if (rejected.length > 0) return json({ error: "cors_header_not_allowed" }, 403);
  const allowedHeaders = [...new Set([...DEFAULT_MCP_CORS_HEADERS, ...requestedHeaders])];
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": allowedHeaders.join(", "),
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

const DEFAULT_MCP_CORS_HEADERS = Object.freeze([
  "authorization", "content-type", "dpop", "mcp-protocol-version", "mcp-method", "mcp-name",
  "traceparent", "tracestate", "baggage",
]);
const EMPTY_CORS_HEADER_SET: ReadonlySet<string> = new Set();
const CORS_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const MAX_CORS_REQUEST_HEADER_BYTES = 8192;
const MAX_CORS_REQUEST_HEADERS = 64;

function requestedCorsHeaders(request: Request): string[] | null {
  const raw = request.headers.get("Access-Control-Request-Headers") ?? "";
  if (new TextEncoder().encode(raw).byteLength > MAX_CORS_REQUEST_HEADER_BYTES) return null;
  const values = [...new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (values.length > MAX_CORS_REQUEST_HEADERS || values.some((name) => !CORS_HEADER_NAME.test(name))) return null;
  return values;
}

function isAllowedMcpCorsHeader(name: string, allowedParameterHeaders: ReadonlySet<string>): boolean {
  return DEFAULT_MCP_CORS_HEADERS.includes(name) || allowedParameterHeaders.has(name);
}

export function applyCors(response: Response, request: Request, base: string, configured: string): Response {
  if (response.status === 101) return response;
  const origin = request.headers.get("Origin") ?? "";
  if (!origin || !isConfiguredOrSameOrigin(origin, base, configured)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "www-authenticate");
  appendVary(headers, "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function searchParamsEntries(params: URLSearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  return entries;
}

export function searchParamsObject(params: URLSearchParams): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  params.forEach((value, key) => {
    if (!Object.hasOwn(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) (out[key] as string[]).push(value);
    else out[key] = [out[key] as string, value];
  });
  return out;
}

export function normalizeDisplayText(value: string, maxLength: number, fallback = "MCP Client"): string {
  const normalized = value.replace(UNSAFE_DISPLAY_CONTROLS, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, maxLength);
}

export function sanitizeMetadataText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(UNSAFE_DISPLAY_CONTROLS, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function workerErrorClass(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return error.name.replace(/[^A-Za-z0-9_-]/g, "_").toLowerCase().slice(0, 64) || "error";
  return "unknown_error";
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  const values = new Set((existing ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function isConfiguredOrSameOrigin(origin: string, base: string, configured: string): boolean {
  if (isDefaultAllowedOrigin(origin, base) || BUILT_IN_BROWSER_ORIGIN_SET.has(origin)) return true;
  const allowed = configured.split(",").map((item) => item.trim()).filter((item) => item && item !== "null");
  return allowed.includes(origin);
}

function isDefaultAllowedOrigin(origin: string, base: string): boolean {
  try {
    return new URL(origin).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
