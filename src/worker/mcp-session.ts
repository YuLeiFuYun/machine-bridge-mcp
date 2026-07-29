const SESSION_PATTERN = /^mcp_([A-Za-z0-9_-]{32})_([A-Za-z0-9_-]{43})$/;

export async function createMcpSessionId(identityKey: string, tokenKey: string): Promise<string> {
  const nonceBytes = new Uint8Array(24);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64Url(nonceBytes);
  const signature = await sessionSignature(identityKey, tokenKey, nonce);
  return `mcp_${nonce}_${signature}`;
}

export async function validateMcpSessionId(sessionId: string, identityKey: string, tokenKey: string): Promise<boolean> {
  const match = String(sessionId || "").match(SESSION_PATTERN);
  if (!match) return false;
  const expected = await sessionSignature(identityKey, tokenKey, match[1]);
  return constantTimeTextEqual(match[2], expected);
}

async function sessionSignature(identityKey: string, tokenKey: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(identityKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`machine-bridge-mcp-session-v1\0${tokenKey}\0${nonce}`),
  );
  return base64Url(new Uint8Array(signature));
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export type McpSessionResolution =
  | { kind: "initialize"; sessionId: string }
  | { kind: "active"; sessionId: string }
  | { kind: "invalid"; sessionId: string };

export async function resolveMcpSession(
  request: Request,
  method: string,
  identityKey: string,
  tokenKey: string,
): Promise<McpSessionResolution> {
  if (method === "initialize") {
    return { kind: "initialize", sessionId: await createMcpSessionId(identityKey, tokenKey) };
  }
  const sessionId = request.headers.get("mcp-session-id")?.trim() || "";
  if (sessionId && !(await validateMcpSessionId(sessionId, identityKey, tokenKey))) {
    return { kind: "invalid", sessionId };
  }
  return { kind: "active", sessionId };
}

export function legacyMcpClientRequestKey(tokenKey: string, sessionId: string, requestId: unknown): string | undefined {
  if (!sessionId || !isRequestId(requestId)) return undefined;
  return `${tokenKey}:legacy:${sessionId}:${typeof requestId}:${String(requestId)}`;
}

export function modernMcpStreamRequestKey(streamId: string): string | undefined {
  if (!/^stream_[A-Za-z0-9_-]{43}$/.test(streamId)) return undefined;
  return `modern:${streamId}`;
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
