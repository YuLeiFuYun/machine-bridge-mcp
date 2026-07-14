const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

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

export function authorizationRedirectLocation(redirectUri: string, code: string, state: string): URL {
  const location = new URL(redirectUri);
  location.searchParams.append("code", code);
  if (state) location.searchParams.append("state", state);
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

export function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

export function baseUrl(request: Request): string {
  return new URL(request.url).origin;
}

export function bearerToken(request: Request): string {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
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

export async function readBoundedText(request: Request, limit: number): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > limit) {
    throw new HttpError(413, "request_body_too_large", `request body exceeds ${limit} bytes`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(413, "request_body_too_large", `request body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new HttpError(400, "invalid_encoding", "Request body must be valid UTF-8");
  }
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

export function corsPreflight(request: Request, base: string, configured: string): Response {
  const origin = request.headers.get("Origin") ?? "";
  if (!isConfiguredOrSameOrigin(origin, base, configured)) return json({ error: "origin_not_allowed" }, 403);
  const requestedMethod = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (requestedMethod && !["GET", "POST"].includes(requestedMethod)) return methodNotAllowed("GET, POST, OPTIONS");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

export function applyCors(response: Response, request: Request, base: string, configured: string): Response {
  if (response.status === 101) return response;
  const origin = request.headers.get("Origin") ?? "";
  if (!origin || !isConfiguredOrSameOrigin(origin, base, configured)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "www-authenticate, mcp-session-id");
  appendVary(headers, "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function validateOrigin(request: Request, base: string, configured = ""): boolean {
  const origin = request.headers.get("Origin");
  return !origin || isConfiguredOrSameOrigin(origin, base, configured);
}

export function searchParamsEntries(params: URLSearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  return entries;
}

export function searchParamsObject(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  params.forEach((value, key) => {
    if (out[key] === undefined) out[key] = value;
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
  if (isDefaultAllowedOrigin(origin, base)) return true;
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
