import { normalizeAccountRole, type AccountRole } from "./access.ts";

const OAUTH_STORE_SCHEMA_VERSION = 1;
const OAUTH_REFRESH_STORE_SCHEMA_VERSION = 2;
export const OFFLINE_ACCESS_SCOPE = "offline_access";
const PASSWORD_TOKEN_PATTERN = /^[a-z][a-z0-9_]{2,31}_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const LEGACY_ACCOUNT_NAME_PATTERN = /^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]{1,62}[a-z0-9])$/;

export interface AccountRecord {
  account_id: string;
  name: string;
  display_name: string;
  role: AccountRole;
  active: boolean;
  version: number;
  password_salt: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  last_used_at: number;
  has_been_authorized?: boolean;
  registration_identity?: string;
}

export interface OAuthCode {
  client_id: string;
  account_id: string;
  account_version: number;
  role: AccountRole;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: number;
}

export interface OAuthToken {
  client_id: string;
  account_id: string;
  account_version: number;
  role: AccountRole;
  scope: string;
  resource: string;
  version: string;
  expires_at: number;
  family_id?: string;
}

export interface OAuthRefreshToken extends OAuthToken {
  family_id: string;
  family_expires_at: number;
  issued_at: number;
}

export interface ConsumedOAuthRefreshToken {
  family_id: string;
  consumed_at: number;
  expires_at: number;
}

export interface RevokedOAuthRefreshFamily {
  expires_at: number;
  reason: "replay";
}

export interface OAuthRefreshStore {
  schema_version: number;
  tokens: Record<string, OAuthRefreshToken>;
  consumed: Record<string, ConsumedOAuthRefreshToken>;
  revoked_families: Record<string, RevokedOAuthRefreshFamily>;
}

export interface OAuthFailure {
  count: number;
  window_started: number;
  blocked_until: number;
  last_attempt: number;
}

export interface OAuthStore {
  schema_version: number;
  accounts: Record<string, AccountRecord>;
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

export function emptyOAuthStore(): OAuthStore {
  return {
    schema_version: OAUTH_STORE_SCHEMA_VERSION,
    accounts: {},
    clients: {},
    codes: {},
    tokens: {},
    auth_failures: {},
  };
}

export function emptyOAuthRefreshStore(): OAuthRefreshStore {
  return {
    schema_version: OAUTH_REFRESH_STORE_SCHEMA_VERSION,
    tokens: {},
    consumed: {},
    revoked_families: {},
  };
}

export function isCurrentOAuthStore(value: unknown): value is OAuthStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Partial<OAuthStore>;
  return store.schema_version === OAUTH_STORE_SCHEMA_VERSION
    && isRecord(store.accounts)
    && isRecord(store.clients)
    && isRecord(store.codes)
    && isRecord(store.tokens)
    && isRecord(store.auth_failures);
}

export function isCurrentOAuthRefreshStore(value: unknown): value is OAuthRefreshStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Partial<OAuthRefreshStore>;
  return store.schema_version === OAUTH_REFRESH_STORE_SCHEMA_VERSION
    && isRecord(store.tokens)
    && isRecord(store.consumed)
    && isRecord(store.revoked_families);
}

export function upgradeOAuthRefreshStore(value: unknown): OAuthRefreshStore | null {
  if (isCurrentOAuthRefreshStore(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const legacy = value as { schema_version?: unknown; tokens?: unknown };
  if (legacy.schema_version !== 1 || !isRecord(legacy.tokens)) return null;
  const upgraded = emptyOAuthRefreshStore();
  const now = Math.floor(Date.now() / 1000);
  for (const [key, raw] of Object.entries(legacy.tokens)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const token = raw as OAuthToken;
    if (!Number.isSafeInteger(token.expires_at) || token.expires_at <= now) continue;
    const familyId = randomToken("mcp_family");
    upgraded.tokens[key] = {
      ...token,
      family_id: familyId,
      family_expires_at: token.expires_at,
      issued_at: now,
    };
  }
  return upgraded;
}

export function normalizeOAuthScope(value: unknown, serverName: string): string | null {
  const raw = value === undefined ? serverName : String(value).trim();
  if (!raw) return null;
  const requested = raw.split(/\s+/);
  const scopes = new Set(requested);
  if (scopes.size !== requested.length || !scopes.has(serverName)) return null;
  for (const scope of scopes) {
    if (scope !== serverName && scope !== OFFLINE_ACCESS_SCOPE) return null;
  }
  return scopes.has(OFFLINE_ACCESS_SCOPE) ? `${serverName} ${OFFLINE_ACCESS_SCOPE}` : serverName;
}

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
  const scope = normalizeOAuthScope(body.scope, serverName);
  const state = body.state === undefined ? "" : typeof body.state === "string" ? body.state : "";

  if (responseType !== "code") return { error: "response_type must be code.", status: 400 };
  if (requestedResource !== `${base}/mcp`) return { error: "resource mismatch.", status: 400 };
  if (!scope) return { error: "unsupported scope.", status: 400 };
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

export function normalizeAccountName(value: unknown): string | null {
  const name = String(value ?? "").trim().toLowerCase();
  return ACCOUNT_NAME_PATTERN.test(name) ? name : null;
}

export function accountByName(store: OAuthStore, name: unknown): AccountRecord | null {
  const candidate = String(name ?? "").trim().toLowerCase();
  const normalized = LEGACY_ACCOUNT_NAME_PATTERN.test(candidate) ? candidate : null;
  if (!normalized) return null;
  return Object.values(store.accounts).find((account) => account.name === normalized) ?? null;
}

export async function createAccount(input: { name: unknown; displayName?: unknown; role: unknown; password: unknown; now: number }): Promise<AccountRecord> {
  const name = normalizeAccountName(input.name);
  const role = normalizeAccountRole(input.role);
  const password = normalizePassword(input.password);
  if (!name) throw new Error("account name must be 3-64 lowercase letters, digits, dots, underscores, or hyphens");
  if (!role) throw new Error("account role is invalid");
  const displayName = normalizeDisplayName(input.displayName, name);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return {
    account_id: randomToken("acct"),
    name,
    display_name: displayName,
    role,
    active: true,
    version: 1,
    password_salt: base64Url(salt),
    password_hash: await derivePasswordHash(password, salt),
    created_at: input.now,
    updated_at: input.now,
  };
}

export async function replaceAccountPassword(account: AccountRecord, passwordValue: unknown, now: number): Promise<void> {
  const password = normalizePassword(passwordValue);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  account.password_salt = base64Url(salt);
  account.password_hash = await derivePasswordHash(password, salt);
  account.version += 1;
  account.updated_at = now;
}

export async function verifyAccountPassword(account: AccountRecord, passwordValue: unknown): Promise<boolean> {
  try {
    const password = normalizePassword(passwordValue);
    const salt = base64UrlDecode(account.password_salt);
    const hash = await derivePasswordHash(password, salt);
    return safeEqual(hash, account.password_hash);
  } catch {
    return false;
  }
}

export function publicAccount(account: AccountRecord): Record<string, unknown> {
  return {
    account_id: account.account_id,
    name: account.name,
    display_name: account.display_name,
    role: account.role,
    active: account.active,
    version: account.version,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

export function updateAccount(account: AccountRecord, input: { displayName?: unknown; role?: unknown; active?: unknown }, now: number): void {
  let changed = false;
  if (input.displayName !== undefined) {
    account.display_name = normalizeDisplayName(input.displayName, account.name);
    changed = true;
  }
  if (input.role !== undefined) {
    const role = normalizeAccountRole(input.role);
    if (!role) throw new Error("account role is invalid");
    if (role !== account.role) {
      account.role = role;
      changed = true;
    }
  }
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw new Error("active must be a boolean");
    if (account.active !== input.active) {
      account.active = input.active;
      changed = true;
    }
  }
  if (changed) {
    account.version += 1;
    account.updated_at = now;
  }
}

export function revokeAccountCredentials(store: OAuthStore, accountId: string): void {
  for (const [key, value] of Object.entries(store.codes)) if (value.account_id === accountId) delete store.codes[key];
  for (const [key, value] of Object.entries(store.tokens)) if (value.account_id === accountId) delete store.tokens[key];
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
  return `hmac-sha256:${hex(new Uint8Array(digest))}`;
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
  return hex(new Uint8Array(digest));
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

function normalizePassword(value: unknown): string {
  if (typeof value !== "string" || !PASSWORD_TOKEN_PATTERN.test(value)) {
    throw new Error("account password must be a generated 256-bit token");
  }
  return value;
}

function normalizeDisplayName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").slice(0, 128) : "";
  return text || fallback;
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  if (salt.byteLength !== 16) throw new Error("account password salt is invalid");
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", saltBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
