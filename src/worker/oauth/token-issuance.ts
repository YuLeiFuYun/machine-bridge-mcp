import { pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken, sha256Hex, type OAuthCode, type OAuthRefreshStore, type OAuthRefreshToken, type OAuthStore } from "./state.ts";
import { HttpError, json, workerErrorClass } from "../room/http.ts";
import { writeAuthorityRevocations } from "./authority-revocations.ts";
import type { AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import type { OAuthToken, ConsumedOAuthRefreshToken } from "./state.ts";
import { hasOnlyRecordFields, OAUTH_CONSUMED_REFRESH_FIELDS, OAUTH_REFRESH_SHARD_FIELDS } from "./contracts.ts";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const REFRESH_TOKEN_IDLE_TTL_SECONDS = 60 * 60 * 24 * 14;

const REFRESH_TOKEN_FAMILY_TTL_SECONDS = 60 * 60 * 24 * 30;

const MAX_ACCESS_TOKENS = 500;

const MAX_ACCESS_TOKENS_PER_CLIENT = 20;

const MAX_REFRESH_TOKENS = 500;

const MAX_REFRESH_TOKENS_PER_CLIENT = 20;

type OAuthLock = <T>(callback: () => Promise<T>) => Promise<T>;

export type OAuthRefreshEvent = "rotated" | "retry_issued" | "retry_exhausted" | "family_revoked" | "rejected";

export interface OAuthTokenExchangeOptions {
  storage: DurableObjectStorage;
  tokenVersion: string;
  serverName: string;
  loadOAuthStore: () => Promise<OAuthStore>;
  withLock: OAuthLock;
  onRefreshEvent?: (event: OAuthRefreshEvent) => void;
  saveStores: (oauthStore: OAuthStore, refreshStore: OAuthRefreshStore, revocation?: AuthorityRevocation) => Promise<void>;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function issueTokenPair(
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  source: OAuthCode | OAuthRefreshToken,
  tokenVersion: string,
  dpopJkt?: string,
  issuance: { derivationSeed?: string; issuedAt?: number; accessScope?: string } = {},
): Promise<IssuedTokenPair> {
  if (!tokenVersion) throw new HttpError(503, "server_error", "OAuth token version is not configured");
  const now = Number.isSafeInteger(issuance.issuedAt) && Number(issuance.issuedAt) > 0
    ? Number(issuance.issuedAt)
    : Math.floor(Date.now() / 1000);
  const familyId = "family_id" in source && source.family_id ? source.family_id : randomToken("mcp_family");
  const familyExpiresAt = "family_expires_at" in source && source.family_expires_at
    ? source.family_expires_at
    : now + REFRESH_TOKEN_FAMILY_TTL_SECONDS;
  if (familyExpiresAt <= now) throw new HttpError(400, "invalid_grant", "refresh-token family expired");
  const issued = issuance.derivationSeed
    ? await deriveRefreshReplacementPair(tokenVersion, issuance.derivationSeed)
    : { accessToken: randomToken("mcp_at"), refreshToken: randomToken("mcp_rt") };
  const { accessToken, refreshToken } = issued;
  const accessScope = typeof issuance.accessScope === "string" && issuance.accessScope.trim()
    ? issuance.accessScope.trim()
    : source.scope;
  const common = {
    client_id: source.client_id,
    account_id: source.account_id,
    account_version: source.account_version,
    role: source.role,
    resource: source.resource,
    version: tokenVersion,
    family_id: familyId,
    ...(dpopJkt ? { dpop_jkt: dpopJkt } : {}),
  };
  oauthStore.tokens[`sha256:${await sha256Hex(accessToken)}`] = {
    ...common,
    scope: accessScope,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  refreshStore.tokens[`sha256:${await sha256Hex(refreshToken)}`] = {
    ...common,
    scope: source.scope,
    family_id: familyId,
    family_expires_at: familyExpiresAt,
    issued_at: now,
    expires_at: Math.min(now + REFRESH_TOKEN_IDLE_TTL_SECONDS, familyExpiresAt),
  };
  pruneClientRecordByExpiry(oauthStore.tokens, source.client_id, MAX_ACCESS_TOKENS_PER_CLIENT);
  pruneRecordByExpiry(oauthStore.tokens, MAX_ACCESS_TOKENS);
  pruneClientRecordByExpiry(refreshStore.tokens, source.client_id, MAX_REFRESH_TOKENS_PER_CLIENT);
  pruneRecordByExpiry(refreshStore.tokens, MAX_REFRESH_TOKENS);
  return { accessToken, refreshToken };
}

export function tokenResponse(issued: IssuedTokenPair, scope: string, dpopJkt?: string): Response {
  return json({
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    token_type: dpopJkt ? "DPoP" : "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  }, 200, { pragma: "no-cache" });
}

export async function saveOAuthStores(
  oauthStore: OAuthStore, refreshStore: OAuthRefreshStore, storage: DurableObjectStorage,
  revocations: readonly AuthorityRevocation[] = [],
): Promise<void> {
  let stage = "oauth";
  try {
    await storage.transaction(async (tx) => {
      await tx.put("oauth", oauthStore); stage = "refresh";
      await writeOAuthRefreshPersistenceEntries(tx, refreshStore);
      await writeAuthorityRevocations(tx, revocations); stage = "commit";
    });
  } catch (error) {
    const wrapped = new Error("OAuth store persistence failed", { cause: error });
    wrapped.name = `oauth_store_persist_${stage}_${workerErrorClass(error)}`; throw wrapped;
  }
}
const DERIVATION_DOMAIN = "machine-bridge-mcp/oauth-refresh-replacement/v1";

export async function deriveRefreshReplacementPair(
  keyMaterial: string,
  consumedRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (!keyMaterial) throw new Error("OAuth token derivation key is not configured");
  if (!/^mcp_rt_[A-Za-z0-9_-]{43}$/.test(consumedRefreshToken)) {
    throw new Error("refresh replacement seed is invalid");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [accessDigest, refreshDigest] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(`${DERIVATION_DOMAIN}\0access\0${consumedRefreshToken}`)),
    crypto.subtle.sign("HMAC", key, encoder.encode(`${DERIVATION_DOMAIN}\0refresh\0${consumedRefreshToken}`)),
  ]);
  return {
    accessToken: `mcp_at_${base64Url(new Uint8Array(accessDigest))}`,
    refreshToken: `mcp_rt_${base64Url(new Uint8Array(refreshDigest))}`,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function refreshFamilyAuthority(
  source: OAuthRefreshToken | undefined,
  oauthStore: OAuthStore,
  refreshTokens: Record<string, OAuthRefreshToken>,
  familyId: string,
): AuthorityRevocation | undefined {
  let token: OAuthToken | undefined = source;
  if (!token) {
    for (const value of Object.values(refreshTokens)) {
      if (value.family_id === familyId) { token = value; break; }
    }
  }
  if (!token) {
    for (const value of Object.values(oauthStore.tokens)) {
      if (value.family_id === familyId) { token = value; break; }
    }
  }
  return token ? {
    accountId: token.account_id,
    accountVersion: token.account_version,
    clientId: token.client_id,
    familyId,
  } : undefined;
}
export const OAUTH_REFRESH_STORE_KEY = "oauth-refresh";

const CONSUMED_SHARD_PREFIX = "oauth-refresh-consumed:";

const CONSUMED_SHARD_SCHEMA_VERSION = 1;

const CONSUMED_SHARD_COUNT = 8;

const MAX_CONSUMED_PER_SHARD = 1024;

const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type OAuthRefreshPersistenceRead = Pick<DurableObjectStorage, "get">;

export type OAuthRefreshPersistenceWrite = Pick<DurableObjectStorage, "transaction">;

type ConsumedShard = {
  schema_version: number;
  records: Record<string, ConsumedOAuthRefreshToken>;
};

export interface LoadedConsumedRefreshShards {
  consumed: Record<string, ConsumedOAuthRefreshToken>;
  present: boolean;
  complete: boolean;
  valid: boolean;
}

export async function loadConsumedRefreshShards(
  storage: OAuthRefreshPersistenceRead,
): Promise<LoadedConsumedRefreshShards> {
  const keys = consumedShardKeys();
  const raw = await storage.get<unknown>(keys);
  if (!(raw instanceof Map)) throw new Error("OAuth refresh shard multi-read returned an invalid result");
  const consumed: Record<string, ConsumedOAuthRefreshToken> = {};
  let presentCount = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const value = raw.get(key);
    if (value === undefined) continue;
    presentCount += 1;
    if (!validShardEnvelope(value) || Object.keys(value.records).length > MAX_CONSUMED_PER_SHARD) {
      return { consumed: {}, present: presentCount > 0, complete: false, valid: false };
    }
    for (const [tokenHash, marker] of Object.entries(value.records)) {
      if (!TOKEN_HASH_PATTERN.test(tokenHash) || consumedShardIndex(tokenHash) !== index || Object.hasOwn(consumed, tokenHash)
          || !marker || typeof marker !== "object" || Array.isArray(marker)
          || !hasOnlyRecordFields(marker, OAUTH_CONSUMED_REFRESH_FIELDS)) {
        return { consumed: {}, present: presentCount > 0, complete: false, valid: false };
      }
      consumed[tokenHash] = marker;
    }
  }
  return { consumed, present: presentCount > 0, complete: presentCount === keys.length, valid: true };
}

export function oauthRefreshPersistenceEntries(
  store: OAuthRefreshStore,
): Readonly<Record<string, unknown>> {
  const shards = Array.from({ length: CONSUMED_SHARD_COUNT }, () => ({
    schema_version: CONSUMED_SHARD_SCHEMA_VERSION,
    records: {} as Record<string, ConsumedOAuthRefreshToken>,
  }));
  const counts = Array.from({ length: CONSUMED_SHARD_COUNT }, () => 0);
  for (const [tokenHash, marker] of Object.entries(store.consumed)) {
    if (!TOKEN_HASH_PATTERN.test(tokenHash)) throw new Error("OAuth refresh consumed-token key is invalid");
    const index = consumedShardIndex(tokenHash);
    const shard = shards[index];
    if (shard === undefined) throw new Error("OAuth refresh consumed-token shard index is out of range");
    const count = (counts[index] ?? 0) + 1;
    if (count > MAX_CONSUMED_PER_SHARD) throw new Error("OAuth refresh consumed-token shard capacity exceeded");
    counts[index] = count;
    shard.records[tokenHash] = marker;
  }
  const entries: Record<string, unknown> = {
    [OAUTH_REFRESH_STORE_KEY]: { ...store, consumed: {} },
  };
  const keys = consumedShardKeys();
  for (const [index, key] of keys.entries()) {
    const shard = shards[index];
    if (shard === undefined) throw new Error("OAuth refresh consumed-token shard index is out of range");
    entries[key] = shard;
  }
  return entries;
}

export async function saveOAuthRefreshStore(
  storage: OAuthRefreshPersistenceWrite,
  store: OAuthRefreshStore,
): Promise<void> {
  await storage.transaction((transaction) => writeOAuthRefreshPersistenceEntries(transaction, store));
}

export async function writeOAuthRefreshPersistenceEntries(
  storage: Pick<DurableObjectStorage, "put">,
  store: OAuthRefreshStore,
): Promise<void> {
  for (const [key, value] of Object.entries(oauthRefreshPersistenceEntries(store))) await storage.put(key, value);
}

function consumedShardIndex(tokenHash: string): number {
  return Number.parseInt(tokenHash.slice(7, 8), 16) % CONSUMED_SHARD_COUNT;
}

function consumedShardKeys(): string[] {
  return Array.from({ length: CONSUMED_SHARD_COUNT }, (_, index) => `${CONSUMED_SHARD_PREFIX}${index.toString(16)}`);
}

function validShardEnvelope(value: unknown): value is ConsumedShard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const shard = value as Partial<ConsumedShard>;
  return hasOnlyRecordFields(value, OAUTH_REFRESH_SHARD_FIELDS)
    && shard.schema_version === CONSUMED_SHARD_SCHEMA_VERSION
    && Boolean(shard.records) && typeof shard.records === "object" && !Array.isArray(shard.records);
}
