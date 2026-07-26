import {
  pruneClientRecordByExpiry,
  pruneRecordByExpiry,
  randomToken,
  sha256Hex,
  type OAuthCode,
  type OAuthRefreshStore,
  type OAuthRefreshToken,
  type OAuthStore,
} from "./oauth-state.ts";
import { HttpError, json } from "./http.ts";
import { OAUTH_REFRESH_STORE_KEY } from "./oauth-refresh-families.ts";
import { deriveRefreshReplacementPair } from "./oauth-token-derivation.ts";

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
  issuance: { derivationSeed?: string; issuedAt?: number } = {},
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
  const common = {
    client_id: source.client_id,
    account_id: source.account_id,
    account_version: source.account_version,
    role: source.role,
    scope: source.scope,
    resource: source.resource,
    version: tokenVersion,
    family_id: familyId,
    ...(dpopJkt ? { dpop_jkt: dpopJkt } : {}),
  };
  oauthStore.tokens[`sha256:${await sha256Hex(accessToken)}`] = {
    ...common,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  refreshStore.tokens[`sha256:${await sha256Hex(refreshToken)}`] = {
    ...common,
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
  });
}

export async function saveOAuthStores(
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.put({ oauth: oauthStore, [OAUTH_REFRESH_STORE_KEY]: refreshStore });
}
