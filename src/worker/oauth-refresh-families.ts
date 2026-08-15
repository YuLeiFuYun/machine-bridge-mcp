import {
  emptyOAuthRefreshStore,
  isCurrentOAuthRefreshStore,
  upgradeOAuthRefreshStore,
  type ConsumedOAuthRefreshToken,
  type OAuthRefreshStore,
  type OAuthRefreshToken,
  type OAuthStore,
} from "./oauth-state.ts";
import { HttpError } from "./http.ts";
import {
  hasOnlyRecordFields, OAUTH_CONSUMED_REFRESH_FIELDS, OAUTH_REFRESH_TOKEN_FIELDS, OAUTH_REVOKED_REFRESH_FAMILY_FIELDS,
} from "./oauth-field-contract.ts";
import {
  loadConsumedRefreshShards,
  mergeLegacyAndShardedConsumed,
  OAUTH_REFRESH_STORE_KEY,
  saveOAuthRefreshStore,
} from "./oauth-refresh-persistence.ts";
export { OAUTH_REFRESH_STORE_KEY } from "./oauth-refresh-persistence.ts";

const MAX_CONSUMED_REFRESH_TOKENS = 4096;
const MAX_REVOKED_REFRESH_FAMILIES = 1024;
export const OAUTH_REFRESH_RETRY_GRACE_SECONDS = 30;
export const MAX_REFRESH_RETRY_ISSUES = 2;
const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FAMILY_ID_PATTERN = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export async function loadOAuthRefreshStore(
  oauthStore: OAuthStore,
  storage: DurableObjectStorage,
): Promise<OAuthRefreshStore> {
  const raw = await storage.get<unknown>(OAUTH_REFRESH_STORE_KEY);
  const shards = await loadConsumedRefreshShards(storage);
  const store = raw === undefined ? emptyOAuthRefreshStore() : upgradeOAuthRefreshStore(raw);
  if (!store || !shards.valid || (raw === undefined && shards.present)) {
    throw new HttpError(503, "oauth_refresh_state_schema_mismatch", "OAuth refresh-token state requires operator repair");
  }
  const migrated = raw !== undefined && !isCurrentOAuthRefreshStore(raw);
  const legacyConsumedPresent = Object.keys(store.consumed).length > 0;
  const mergedConsumed = mergeLegacyAndShardedConsumed(store.consumed, shards.consumed);
  if (!mergedConsumed) {
    throw new HttpError(503, "oauth_refresh_state_schema_mismatch", "OAuth refresh-token state requires operator repair");
  }
  store.consumed = mergedConsumed;
  if (!validRefreshStoreRecords(store)) {
    throw new HttpError(503, "oauth_refresh_state_schema_mismatch", "OAuth refresh-token state requires operator repair");
  }
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  for (const [token, value] of Object.entries(store.tokens)) {
    const account = oauthStore.accounts[value.account_id];
    const client = oauthStore.clients[value.client_id];
    if (
      value.expires_at <= now
      || value.family_expires_at <= now
      || Boolean(store.revoked_families[value.family_id])
      || !account
      || !account.active
      || account.version !== value.account_version
      || account.role !== value.role
      || !client
    ) {
      delete store.tokens[token];
      changed = true;
    }
  }
  for (const [token, value] of Object.entries(store.consumed)) {
    if (value.expires_at <= now) {
      delete store.consumed[token];
      changed = true;
      continue;
    }
    if (Number.isSafeInteger(value.retry_until) && value.retry_until! < now) {
      delete value.retry_until;
      delete value.retry_issues;
      delete value.source;
      delete value.access_scope;
      changed = true;
    }
  }
  for (const [familyId, value] of Object.entries(store.revoked_families)) {
    if (value.expires_at <= now) {
      delete store.revoked_families[familyId];
      changed = true;
    }
  }
  if (pruneOAuthRefreshReplayState(store, oauthStore)) changed = true;
  if (changed || migrated || legacyConsumedPresent) await saveOAuthRefreshStore(storage, store);
  return store;
}


export function recordConsumedRefreshToken(
  oauthStore: OAuthStore,
  store: OAuthRefreshStore,
  tokenHash: string,
  source: OAuthRefreshToken,
  expiresAt: number,
  consumedAt = Math.floor(Date.now() / 1000),
  accessScope = source.scope,
): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash) || !FAMILY_ID_PATTERN.test(source.family_id)) {
    throw new Error("consumed refresh-token identity is invalid");
  }
  if (!Number.isSafeInteger(consumedAt) || !Number.isSafeInteger(expiresAt) || consumedAt <= 0 || expiresAt <= consumedAt) {
    throw new Error("consumed refresh-token lifetime is invalid");
  }
  store.consumed[tokenHash] = {
    family_id: source.family_id,
    consumed_at: consumedAt,
    expires_at: expiresAt,
    retry_until: Math.min(expiresAt, consumedAt + OAUTH_REFRESH_RETRY_GRACE_SECONDS),
    retry_issues: 0,
    source: { ...source },
    access_scope: accessScope,
  };
  pruneOAuthRefreshReplayState(store, oauthStore);
}

export function consumedRefreshRetrySource(
  marker: ConsumedOAuthRefreshToken,
  now = Math.floor(Date.now() / 1000),
): OAuthRefreshToken | null {
  if (!marker.source || !Number.isSafeInteger(marker.retry_until) || marker.retry_until! < now) return null;
  if (!Number.isSafeInteger(marker.retry_issues) || marker.retry_issues! < 0 || marker.retry_issues! >= MAX_REFRESH_RETRY_ISSUES) return null;
  return { ...marker.source };
}

export function recordConsumedRefreshRetry(marker: ConsumedOAuthRefreshToken): void {
  const current = Number.isSafeInteger(marker.retry_issues) ? marker.retry_issues! : 0;
  marker.retry_issues = current + 1;
}

export function pruneOAuthRefreshReplayState(store: OAuthRefreshStore, oauthStore?: OAuthStore): boolean {
  let changed = false;
  const consumed = Object.entries(store.consumed).sort((left, right) => (
    left[1].consumed_at - right[1].consumed_at || left[0].localeCompare(right[0])
  ));
  while (consumed.length > MAX_CONSUMED_REFRESH_TOKENS) {
    const [tokenHash, marker] = consumed.shift()!;
    revokeRefreshFamilyRecords(oauthStore, store, marker.family_id, marker.expires_at);
    delete store.consumed[tokenHash];
    changed = true;
  }
  const revoked = Object.entries(store.revoked_families).sort((left, right) => (
    left[1].expires_at - right[1].expires_at || left[0].localeCompare(right[0])
  ));
  while (revoked.length > MAX_REVOKED_REFRESH_FAMILIES) {
    const [familyId] = revoked.shift()!;
    delete store.revoked_families[familyId];
    changed = true;
  }
  return changed;
}

function validRefreshStoreRecords(store: OAuthRefreshStore): boolean {
  return Object.entries(store.tokens).every(([key, token]) => (
    TOKEN_HASH_PATTERN.test(key) && validRefreshTokenRecord(token)
  )) && Object.entries(store.consumed).every(([key, token]) => (
    TOKEN_HASH_PATTERN.test(key)
    && plainRecord(token)
    && hasOnlyRecordFields(token, OAUTH_CONSUMED_REFRESH_FIELDS)
    && FAMILY_ID_PATTERN.test(token.family_id)
    && validTimestamp(token.consumed_at)
    && validTimestamp(token.expires_at)
    && token.consumed_at < token.expires_at
    && (token.retry_until === undefined || (
      validTimestamp(token.retry_until)
      && token.retry_until >= token.consumed_at
      && token.retry_until <= token.expires_at
    ))
    && (token.retry_issues === undefined || (
      Number.isSafeInteger(token.retry_issues)
      && token.retry_issues >= 0
      && token.retry_issues <= MAX_REFRESH_RETRY_ISSUES
    ))
    && (token.source === undefined || validRefreshTokenRecord(token.source))
    && (token.access_scope === undefined || (
      typeof token.access_scope === "string"
      && token.access_scope.length > 0
      && token.access_scope.length <= 256
      && token.source !== undefined
      && scopeSubset(token.access_scope, token.source.scope)
    ))
    && ((token.source === undefined && token.retry_until === undefined && token.retry_issues === undefined)
      || (token.source !== undefined && token.retry_until !== undefined && token.retry_issues !== undefined
        && token.source.family_id === token.family_id))
  )) && Object.entries(store.revoked_families).every(([familyId, value]) => (
    FAMILY_ID_PATTERN.test(familyId)
    && plainRecord(value)
    && hasOnlyRecordFields(value, OAUTH_REVOKED_REFRESH_FAMILY_FIELDS)
    && value.reason === "replay"
    && validTimestamp(value.expires_at)
  ));
}

function validRefreshTokenRecord(token: OAuthRefreshToken): boolean {
  return plainRecord(token)
    && hasOnlyRecordFields(token, OAUTH_REFRESH_TOKEN_FIELDS)
    && /^mcp_client_[A-Za-z0-9_-]{43}$/.test(token.client_id)
    && /^acct_[A-Za-z0-9_-]{20,96}$/.test(token.account_id)
    && Number.isSafeInteger(token.account_version)
    && token.account_version > 0
    && ["reviewer", "editor", "operator", "owner"].includes(token.role)
    && typeof token.scope === "string"
    && token.scope.length > 0
    && token.scope.length <= 256
    && validHttpsResource(token.resource)
    && typeof token.version === "string"
    && token.version.length > 0
    && token.version.length <= 256
    && FAMILY_ID_PATTERN.test(token.family_id)
    && (token.dpop_jkt === undefined || /^[A-Za-z0-9_-]{43}$/.test(token.dpop_jkt))
    && validTimestamp(token.issued_at)
    && validTimestamp(token.expires_at)
    && validTimestamp(token.family_expires_at)
    && token.issued_at < token.expires_at
    && token.expires_at <= token.family_expires_at;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function scopeSubset(requested: string, granted: string): boolean {
  const requestedScopes = requested.trim().split(/\s+/).filter(Boolean);
  const grantedScopes = new Set(granted.trim().split(/\s+/).filter(Boolean));
  return requestedScopes.length > 0
    && new Set(requestedScopes).size === requestedScopes.length
    && requestedScopes.every((scope) => grantedScopes.has(scope));
}

function validHttpsResource(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (secure || loopback) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function revokeOAuthRefreshFamily(
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  familyId: string,
  expiresAt: number,
): void {
  revokeRefreshFamilyRecords(oauthStore, refreshStore, familyId, expiresAt);
  pruneOAuthRefreshReplayState(refreshStore, oauthStore);
}

function revokeRefreshFamilyRecords(
  oauthStore: OAuthStore | undefined,
  refreshStore: OAuthRefreshStore,
  familyId: string,
  expiresAt: number,
): void {
  for (const [key, token] of Object.entries(refreshStore.tokens)) {
    if (token.family_id === familyId) delete refreshStore.tokens[key];
  }
  if (oauthStore) {
    for (const [key, token] of Object.entries(oauthStore.tokens)) {
      if (token.family_id === familyId) delete oauthStore.tokens[key];
    }
  }
  refreshStore.revoked_families[familyId] = { expires_at: expiresAt, reason: "replay" };
}
