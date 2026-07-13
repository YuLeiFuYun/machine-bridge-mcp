export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  last_used_at: number;
  registration_identity?: string;
}

export interface OAuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: number;
}

export interface OAuthToken {
  client_id: string;
  scope: string;
  resource: string;
  version: string;
  expires_at: number;
}

export interface OAuthFailure {
  count: number;
  window_started: number;
  blocked_until: number;
  last_attempt: number;
}

export interface OAuthStore {
  clients: Record<string, OAuthClient>;
  codes: Record<string, OAuthCode>;
  tokens: Record<string, OAuthToken>;
  auth_failures: Record<string, OAuthFailure>;
}

export interface ValidatedAuthorization {
  client: OAuthClient;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  requestedResource: string;
  scope: string;
  state: string;
}

const AUTH_FAILURE_WINDOW_SECONDS = 10 * 60;
export const AUTH_BLOCK_SECONDS = 15 * 60;
const AUTH_FAILURE_LIMIT = 10;

export function validateAuthorizationRequest(
  body: Record<string, unknown>,
  base: string,
  serverName: string,
  store: OAuthStore,
): { value: ValidatedAuthorization } | { error: string; status: number } {
  const responseType = String(body.response_type ?? "");
  const clientId = String(body.client_id ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeChallenge = String(body.code_challenge ?? "");
  const codeChallengeMethod = String(body.code_challenge_method ?? "");
  const requestedResource = String(body.resource ?? `${base}/mcp`);
  const scope = String(body.scope ?? serverName).trim();
  const state = body.state === undefined ? "" : typeof body.state === "string" ? body.state : "";

  if (responseType !== "code") return { error: "response_type must be code.", status: 400 };
  if (requestedResource !== `${base}/mcp`) return { error: "resource mismatch.", status: 400 };
  if (scope !== serverName) return { error: "unsupported scope.", status: 400 };
  if (body.state !== undefined && typeof body.state !== "string") return { error: "state must be a string.", status: 400 };
  if (state.length > 1024) return { error: "state is too long.", status: 400 };
  if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return { error: "A valid PKCE S256 challenge is required.", status: 400 };
  }
  const client = store.clients[clientId];
  if (!client) return { error: "Unknown OAuth client.", status: 400 };
  if (!client.redirect_uris.includes(redirectUri)) return { error: "redirect_uri is not registered.", status: 400 };
  return { value: { client, clientId, redirectUri, codeChallenge, requestedResource, scope, state } };
}

export function pruneClientRecordByExpiry<T extends { client_id: string; expires_at: number }>(record: Record<string, T>, clientId: string, keep: number): void {
  const allowed = new Set(Object.entries(record)
    .filter(([, value]) => value.client_id === clientId)
    .sort((left, right) => right[1].expires_at - left[1].expires_at)
    .slice(0, keep)
    .map(([key]) => key));
  for (const [key, value] of Object.entries(record)) {
    if (value.client_id === clientId && !allowed.has(key)) delete record[key];
  }
}

export function pruneRecordByExpiry<T extends { expires_at: number }>(record: Record<string, T>, keep: number): void {
  const allowed = new Set(Object.entries(record)
    .sort((left, right) => right[1].expires_at - left[1].expires_at)
    .slice(0, keep)
    .map(([key]) => key));
  for (const key of Object.keys(record)) if (!allowed.has(key)) delete record[key];
}

export async function authorizationIdentity(request: Request, keyMaterial: string): Promise<string> {
  const source = (request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 128);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(source));
  return `hmac-sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function recordAuthorizationFailure(store: OAuthStore, identity: string, now: number): void {
  const current = store.auth_failures[identity];
  const activeWindow = current && current.window_started + AUTH_FAILURE_WINDOW_SECONDS > now;
  const count = activeWindow ? current.count + 1 : 1;
  store.auth_failures[identity] = {
    count,
    window_started: activeWindow ? current.window_started : now,
    blocked_until: count >= AUTH_FAILURE_LIMIT ? now + AUTH_BLOCK_SECONDS : 0,
    last_attempt: now,
  };
}

export function pruneAuthFailures(store: OAuthStore, keep: number): void {
  const allowed = new Set(Object.entries(store.auth_failures)
    .sort((left, right) => right[1].last_attempt - left[1].last_attempt)
    .slice(0, keep)
    .map(([key]) => key));
  for (const key of Object.keys(store.auth_failures)) if (!allowed.has(key)) delete store.auth_failures[key];
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64Url(bytes)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
