import {
  emptyOAuthRefreshStore,
  isCurrentOAuthRefreshStore,
  upgradeOAuthRefreshStore,
  type OAuthRefreshStore,
  type OAuthStore,
} from "./oauth-state.ts";
import { HttpError } from "./http.ts";

export const OAUTH_REFRESH_STORE_KEY = "oauth-refresh";
const MAX_CONSUMED_REFRESH_TOKENS = 4096;
const MAX_REVOKED_REFRESH_FAMILIES = 1024;
const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FAMILY_ID_PATTERN = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export async function loadOAuthRefreshStore(
  oauthStore: OAuthStore,
  storage: DurableObjectStorage,
): Promise<OAuthRefreshStore> {
  const raw = await storage.get<unknown>(OAUTH_REFRESH_STORE_KEY);
  const store = raw === undefined ? emptyOAuthRefreshStore() : upgradeOAuthRefreshStore(raw);
  if (!store || !validRefreshStoreRecords(store)) {
    throw new HttpError(503, "oauth_refresh_state_schema_mismatch", "OAuth refresh-token state requires operator repair");
  }
  const migrated = raw !== undefined && !isCurrentOAuthRefreshStore(raw);
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
    }
  }
  for (const [familyId, value] of Object.entries(store.revoked_families)) {
    if (value.expires_at <= now) {
      delete store.revoked_families[familyId];
      changed = true;
    }
  }
  if (pruneOAuthRefreshReplayState(store, oauthStore)) changed = true;
  if (changed || migrated) await storage.put(OAUTH_REFRESH_STORE_KEY, store);
  return store;
}


export function recordConsumedRefreshToken(
  oauthStore: OAuthStore,
  store: OAuthRefreshStore,
  tokenHash: string,
  familyId: string,
  expiresAt: number,
  consumedAt = Math.floor(Date.now() / 1000),
): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash) || !FAMILY_ID_PATTERN.test(familyId)) {
    throw new Error("consumed refresh-token identity is invalid");
  }
  if (!Number.isSafeInteger(consumedAt) || !Number.isSafeInteger(expiresAt) || consumedAt <= 0 || expiresAt <= consumedAt) {
    throw new Error("consumed refresh-token lifetime is invalid");
  }
  store.consumed[tokenHash] = { family_id: familyId, consumed_at: consumedAt, expires_at: expiresAt };
  pruneOAuthRefreshReplayState(store, oauthStore);
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
    TOKEN_HASH_PATTERN.test(key)
    && plainRecord(token)
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
    && token.expires_at <= token.family_expires_at
  )) && Object.entries(store.consumed).every(([key, token]) => (
    TOKEN_HASH_PATTERN.test(key)
    && plainRecord(token)
    && FAMILY_ID_PATTERN.test(token.family_id)
    && validTimestamp(token.consumed_at)
    && validTimestamp(token.expires_at)
    && token.consumed_at < token.expires_at
  )) && Object.entries(store.revoked_families).every(([familyId, value]) => (
    FAMILY_ID_PATTERN.test(familyId)
    && plainRecord(value)
    && value.reason === "replay"
    && validTimestamp(value.expires_at)
  ));
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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
