export async function statefulRateLimitKey(request: Request): Promise<string> {
  const url = new URL(request.url);
  const route = statefulRouteClass(url.pathname);
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const credential = authorization.match(/^[A-Za-z][A-Za-z0-9_-]*\s+(.+)$/)?.[1]?.trim() ?? "";
  if (credential) return `stateful:${route}:auth:${await opaqueDigest(credential)}`;

  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (clientAddress) return `stateful:${route}:network:${await opaqueDigest(clientAddress)}`;
  return `stateful:${route}:anonymous:${url.host.toLowerCase()}`;
}

export function globalStatefulRateLimitKey(request: Request): string {
  const url = new URL(request.url);
  return `stateful:global:${statefulRouteClass(url.pathname)}:${url.host.toLowerCase()}`;
}

export function statefulRouteClass(pathname: string): string {
  if (pathname === "/mcp") return "mcp";
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
