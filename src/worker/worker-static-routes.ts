import { applyCors, baseUrl, corsPreflight, json, mcpOriginRejection, methodNotAllowed } from "./http.ts";
import { workerToolParameterHeaders } from "./tool-catalog.ts";
import {
  authorizationServerMetadata, mcpMetadata, protectedResourceMetadata, type WorkerIdentity,
} from "./worker-metadata.ts";

const STATEFUL_METHODS = new Map([
  ["/admin/accounts", "GET, POST, PATCH, DELETE"],
  ["/admin/accounts/rotate-password", "POST"],
  ["/admin/clients", "GET, DELETE"],
  ["/daemon/http", "POST"],
  ["/daemon/ws", "GET"],
  ["/mcp", "GET, POST"],
  ["/oauth/authorize", "GET, POST"],
  ["/oauth/register", "POST"],
  ["/oauth/token", "POST"],
]);
const AUTHORIZATION_METADATA_PATHS = new Set([
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration", "/.well-known/openid-configuration/mcp",
]);
const PROTECTED_RESOURCE_PATHS = new Set([
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
]);

export function respondWithoutDurableObject(request: Request, identity: WorkerIdentity, extraOrigins = ""): Response | null {
  const url = new URL(request.url);
  const base = baseUrl(request);
  const path = url.pathname;
  if (request.method === "OPTIONS" && request.headers.has("Origin")) return corsPreflight(request, base, extraOrigins, workerToolParameterHeaders);
  if (path === "/mcp") {
    const originRejection = mcpOriginRejection(request, base, extraOrigins);
    if (originRejection) return originRejection;
  }
  const statefulMethods = STATEFUL_METHODS.get(path);
  if (statefulMethods) {
    const allowed = new Set(statefulMethods.split(",").map((method) => method.trim()));
    if (allowed.has(request.method)) return null;
    return applyCors(methodNotAllowed(statefulMethods), request, base, extraOrigins);
  }

  let response: Response;
  if (path === "/healthz") response = getOnly(request, json({ ok: true, server: identity.server, version: identity.version }));
  else if (path === "/") response = getOnly(request, json({ ok: true, server: identity.server, version: identity.version, mcp: `${base}/mcp` }));
  else if (path === "/.well-known/mcp.json") response = getOnly(request, json(mcpMetadata(base, identity)));
  else if (AUTHORIZATION_METADATA_PATHS.has(path)) response = getOnly(request, json(authorizationServerMetadata(base, identity.server)));
  else if (PROTECTED_RESOURCE_PATHS.has(path)) response = getOnly(request, json(protectedResourceMetadata(base, identity.server)));
  else response = json({ error: "not_found" }, 404);
  return applyCors(response, request, base, extraOrigins);
}

function getOnly(request: Request, response: Response): Response {
  return request.method === "GET" ? response : methodNotAllowed("GET");
}
