import {
  emptyOAuthRefreshStore, isCurrentOAuthRefreshStore, normalizeOAuthScope, pkceS256,
  pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken, safeEqual, sha256Hex,
  type OAuthCode, type OAuthRefreshStore, type OAuthRefreshToken, type OAuthStore,
} from "./oauth-state";
import { HttpError, json, parseRequestBody } from "./http";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_ACCESS_TOKENS = 500;
const MAX_ACCESS_TOKENS_PER_CLIENT = 20;
const MAX_REFRESH_TOKENS = 500;
const MAX_REFRESH_TOKENS_PER_CLIENT = 20;
const OAUTH_REFRESH_STORE_KEY = "oauth-refresh";

type OAuthLock = <T>(callback: () => Promise<T>) => Promise<T>;

interface OAuthTokenExchangeOptions {
  storage: DurableObjectStorage;
  tokenVersion: string;
  serverName: string;
  loadOAuthStore: () => Promise<OAuthStore>;
  withLock: OAuthLock;
}

interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function exchangeOAuthToken(
  request: Request,
  base: string,
  options: OAuthTokenExchangeOptions,
): Promise<Response> {
  const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
  const grantType = String(body.grant_type ?? "");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(body, base, options);
  if (grantType === "refresh_token") return exchangeRefreshToken(body, base, options);
  return json({ error: "unsupported_grant_type" }, 400);
}

async function exchangeAuthorizationCode(
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
): Promise<Response> {
  const code = String(body.code ?? "");
  const verifier = String(body.code_verifier ?? "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
  }
  return options.withLock(async () => {
    const oauthStore = await options.loadOAuthStore();
    const refreshStore = await loadRefreshStore(oauthStore, options);
    const record = oauthStore.codes[code];
    if (!record) return json({ error: "invalid_grant" }, 400);
    if (String(body.client_id ?? "") !== record.client_id || String(body.redirect_uri ?? "") !== record.redirect_uri) {
      return json({ error: "invalid_grant", error_description: "client or redirect mismatch" }, 400);
    }
    if (String(body.resource ?? record.resource) !== record.resource || record.resource !== `${base}/mcp`) {
      return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
    }
    if (!(await safeEqual(await pkceS256(verifier), record.code_challenge))) {
      return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
    }
    const client = oauthStore.clients[record.client_id];
    if (!client) return json({ error: "invalid_grant", error_description: "unknown client" }, 400);

    const issued = await issueTokenPair(oauthStore, refreshStore, record, options.tokenVersion);
    delete oauthStore.codes[code];
    client.last_used_at = Math.floor(Date.now() / 1000);
    await saveOAuthStores(oauthStore, refreshStore, options.storage);
    return tokenResponse(issued, record.scope);
  });
}

async function exchangeRefreshToken(
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
): Promise<Response> {
  const refreshToken = String(body.refresh_token ?? "");
  if (!/^mcp_rt_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return json({ error: "invalid_grant" }, 400);
  return options.withLock(async () => {
    const oauthStore = await options.loadOAuthStore();
    const refreshStore = await loadRefreshStore(oauthStore, options);
    const refreshKey = `sha256:${await sha256Hex(refreshToken)}`;
    const record = refreshStore.tokens[refreshKey];
    if (!record) return json({ error: "invalid_grant" }, 400);
    if (String(body.client_id ?? "") !== record.client_id) {
      return json({ error: "invalid_grant", error_description: "client mismatch" }, 400);
    }
    if (String(body.resource ?? record.resource) !== record.resource || record.resource !== `${base}/mcp`) {
      return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
    }
    if (body.scope !== undefined && normalizeOAuthScope(body.scope, options.serverName) !== record.scope) {
      return json({ error: "invalid_scope" }, 400);
    }
    if (!options.tokenVersion) {
      throw new HttpError(503, "server_error", "OAuth token version is not configured");
    }
    const account = oauthStore.accounts[record.account_id];
    const client = oauthStore.clients[record.client_id];
    if (
      !record.version
      || !(await safeEqual(record.version, options.tokenVersion))
      || !account
      || !account.active
      || account.version !== record.account_version
      || account.role !== record.role
      || !client
    ) {
      delete refreshStore.tokens[refreshKey];
      await options.storage.put(OAUTH_REFRESH_STORE_KEY, refreshStore);
      return json({ error: "invalid_grant" }, 400);
    }

    const issued = await issueTokenPair(oauthStore, refreshStore, record, options.tokenVersion);
    delete refreshStore.tokens[refreshKey];
    client.last_used_at = Math.floor(Date.now() / 1000);
    await saveOAuthStores(oauthStore, refreshStore, options.storage);
    return tokenResponse(issued, record.scope);
  });
}

async function loadRefreshStore(
  oauthStore: OAuthStore,
  options: OAuthTokenExchangeOptions,
): Promise<OAuthRefreshStore> {
  const raw = await options.storage.get<unknown>(OAUTH_REFRESH_STORE_KEY);
  if (raw !== undefined && !isCurrentOAuthRefreshStore(raw)) {
    throw new HttpError(503, "oauth_refresh_state_schema_mismatch", "OAuth refresh-token state requires operator repair");
  }
  const store = isCurrentOAuthRefreshStore(raw) ? raw : emptyOAuthRefreshStore();
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  for (const [token, value] of Object.entries(store.tokens)) {
    const account = oauthStore.accounts[value.account_id];
    const client = oauthStore.clients[value.client_id];
    if (
      value.expires_at <= now
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
  if (changed) await options.storage.put(OAUTH_REFRESH_STORE_KEY, store);
  return store;
}

async function issueTokenPair(
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  source: OAuthCode | OAuthRefreshToken,
  tokenVersion: string,
): Promise<IssuedTokenPair> {
  if (!tokenVersion) throw new HttpError(503, "server_error", "OAuth token version is not configured");
  const now = Math.floor(Date.now() / 1000);
  const accessToken = randomToken("mcp_at");
  const refreshToken = randomToken("mcp_rt");
  const common = {
    client_id: source.client_id,
    account_id: source.account_id,
    account_version: source.account_version,
    role: source.role,
    scope: source.scope,
    resource: source.resource,
    version: tokenVersion,
  };
  oauthStore.tokens[`sha256:${await sha256Hex(accessToken)}`] = {
    ...common,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  refreshStore.tokens[`sha256:${await sha256Hex(refreshToken)}`] = {
    ...common,
    expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
  };
  pruneClientRecordByExpiry(oauthStore.tokens, source.client_id, MAX_ACCESS_TOKENS_PER_CLIENT);
  pruneRecordByExpiry(oauthStore.tokens, MAX_ACCESS_TOKENS);
  pruneClientRecordByExpiry(refreshStore.tokens, source.client_id, MAX_REFRESH_TOKENS_PER_CLIENT);
  pruneRecordByExpiry(refreshStore.tokens, MAX_REFRESH_TOKENS);
  return { accessToken, refreshToken };
}

function tokenResponse(issued: IssuedTokenPair, scope: string): Response {
  return json({
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  });
}

async function saveOAuthStores(
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.put({ oauth: oauthStore, [OAUTH_REFRESH_STORE_KEY]: refreshStore });
}
