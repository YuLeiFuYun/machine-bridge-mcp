import {
  applyCors,
  baseUrl,
  corsPreflight,
  json,
  methodNotAllowed,
} from "./http.ts";

export function respondWithoutDurableObject(
  request: Request,
  identity: { server: string; version: string },
  extraOrigins = "",
): Response | null {
  const url = new URL(request.url);
  const base = baseUrl(request);
  const path = url.pathname;
  const serverName = identity.server;
  const serverVersion = identity.version;

  if (request.method === "OPTIONS" && request.headers.has("Origin")) {
    // CORS preflight does not need Durable Object state and must not consume DO quota.
    return corsPreflight(request, base, extraOrigins);
  }

  if (path === "/healthz") {
    if (request.method !== "GET") return applyCors(methodNotAllowed("GET"), request, base, extraOrigins);
    return applyCors(json({ ok: true, server: serverName, version: serverVersion }), request, base, extraOrigins);
  }

  if (path === "/") {
    if (request.method !== "GET") return applyCors(methodNotAllowed("GET"), request, base, extraOrigins);
    return applyCors(
      json({ ok: true, server: serverName, version: serverVersion, mcp: `${base}/mcp` }),
      request,
      base,
      extraOrigins,
    );
  }

  return null;
}

export function isDurableObjectQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Exceeded allowed volume of requests in Durable Objects free tier/i.test(message)
    || /Durable Objects free tier/i.test(message);
}

export function durableObjectQuotaResponse(request: Request, extraOrigins = ""): Response {
  return applyCors(
    json({
      error: "durable_object_quota_exceeded",
      message: "Durable Objects free-tier request volume is exhausted until the daily UTC reset.",
      retryable: true,
    }, 503),
    request,
    baseUrl(request),
    extraOrigins,
  );
}
