import { isMcpOAuthResource, isMcpResourcePath, matchesMcpOAuthResource, NATIVE_MCP_PATH, type McpResourcePath, HttpError, json, parseRequestBody } from "../room/http.ts";
import type { AuthorizedToken } from "./authority.ts";
import { consumeDpopProof, verifyDpopProof, type VerifiedDpopProof } from "./dpop.ts";
import { loadOAuthRefreshStore, consumedRefreshRetrySource, MAX_REFRESH_RETRY_ISSUES, recordConsumedRefreshRetry, recordConsumedRefreshToken, revokeOAuthRefreshFamily } from "./refresh-families.ts";
import { issueTokenPair, saveOAuthStores, tokenResponse, type OAuthTokenExchangeOptions, type IssuedTokenPair, refreshFamilyAuthority, saveOAuthRefreshStore, deriveRefreshReplacementPair } from "./token-issuance.ts";
import { normalizeOAuthScope, pkceS256, safeEqual, type OAuthStore, sha256Hex, type OAuthRefreshToken, type OAuthRefreshStore } from "./state.ts";

export type { OAuthRefreshEvent } from "./token-issuance.ts";

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;

type AuthorizationCodeStage = "lock" | "load_oauth" | "load_refresh" | "pkce" | "issue" | "persist" | "response";

export async function exchangeOAuthToken(
  request: Request,
  base: string,
  options: OAuthTokenExchangeOptions,
): Promise<Response> {
  const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
  const hasDpop = Boolean(request.headers.get("DPoP"));
  const dpop = hasDpop ? await verifyDpopProof({ request, expectedMethod: "POST", expectedUrl: request.url }) : null;
  if (hasDpop && !dpop) return json({ error: "invalid_dpop_proof" }, 400);
  const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
  if (grantType === "authorization_code") return exchangeAuthorizationCode(body, base, options, dpop || undefined);
  if (grantType === "refresh_token") return exchangeRefreshToken(body, base, options, dpop || undefined);
  return json({ error: "unsupported_grant_type" }, 400);
}

async function exchangeAuthorizationCode(
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
  dpop?: VerifiedDpopProof,
): Promise<Response> {
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
  }
  let stage: AuthorizationCodeStage = "lock";
  try {
    return await options.withLock(async () => {
      stage = "load_oauth";
      const oauthStore = await options.loadOAuthStore();
      stage = "load_refresh";
      const refreshStore = await loadOAuthRefreshStore(oauthStore, options.storage);
      const record = oauthStore.codes[code];
      if (!record) return json({ error: "invalid_grant" }, 400);
      if (typeof body.client_id !== "string" || body.client_id !== record.client_id
          || typeof body.redirect_uri !== "string" || body.redirect_uri !== record.redirect_uri) {
        return json({ error: "invalid_grant", error_description: "client or redirect mismatch" }, 400);
      }
      if (!matchesMcpOAuthResource(base, record.resource, body.resource)) {
        return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
      }
      if (normalizeOAuthScope(record.scope, options.serverName) !== record.scope) {
        return json({ error: "invalid_grant", error_description: "stored scope is invalid" }, 400);
      }
      stage = "pkce";
      if (!(await safeEqual(await pkceS256(verifier), record.code_challenge))) {
        return json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
      }
      const client = oauthStore.clients[record.client_id];
      if (!client) return json({ error: "invalid_grant", error_description: "unknown client" }, 400);
      if (dpop && !(await consumeDpopProof(options.storage, dpop))) return json({ error: "invalid_dpop_proof" }, 400);
      stage = "issue";
      const issued = await issueTokenPair(oauthStore, refreshStore, record, options.tokenVersion, dpop?.jkt);
      delete oauthStore.codes[code];
      client.last_used_at = Math.max(client.created_at, Math.floor(Date.now() / 1000));
      stage = "persist";
      await saveOAuthStores(oauthStore, refreshStore, options.storage);
      stage = "response";
      return tokenResponse(issued, record.scope, dpop?.jkt);
    });
  } catch (error) {
    if (error instanceof HttpError || (error instanceof Error && error.name.startsWith("oauth_store_persist_"))) throw error;
    const staged = new Error("OAuth authorization-code exchange failed", { cause: error });
    staged.name = `oauth_token_stage_${stage}`;
    throw staged;
  }
}

/** Validate current authority; callers persist any pruned token while holding the OAuth lock. */
export async function currentOAuthTokenAuthority(
  store: OAuthStore, key: string, tokenVersion: string, serverName: string, base?: string,
  revokedFamilies: Record<string, unknown> = {}, path: McpResourcePath = NATIVE_MCP_PATH,
): Promise<AuthorizedToken | null> {
    const record = store.tokens[key];
    if (!record) return null;
    if (record.expires_at <= Math.floor(Date.now() / 1000)) {
      delete store.tokens[key];
      return null;
    }
    const currentVersion = tokenVersion;
    if (!record.version || !currentVersion || !(await safeEqual(record.version, currentVersion))) return null;
    if (base !== undefined && (!isMcpResourcePath(path) || !isMcpOAuthResource(base, record.resource))) return null;
    if (record.family_id && Object.hasOwn(revokedFamilies, record.family_id)) {
      delete store.tokens[key];
      return null;
    }
    if (normalizeOAuthScope(record.scope, serverName) !== record.scope) { delete store.tokens[key]; return null; }
    const account = store.accounts[record.account_id];
    const client = store.clients[record.client_id];
    if (
      !account
      || !account.active
      || account.version !== record.account_version
      || account.role !== record.role
      || !client
      || client.trusted_account_id !== account.account_id
      || client.trusted_account_version !== account.version
      || client.trusted_role !== account.role
    ) {
      delete store.tokens[key];
      return null;
    }
    return {
      tokenKey: key, accountId: account.account_id,
      accountVersion: account.version, clientId: record.client_id, familyId: record.family_id ?? "", dpopJkt: record.dpop_jkt ?? "", role: account.role,
    };
}
export async function exchangeRefreshToken(
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
  dpop?: VerifiedDpopProof,
): Promise<Response> {
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!/^mcp_rt_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return reject(options);
  return options.withLock(async () => {
    const now = Math.floor(Date.now() / 1000);
    const oauthStore = await options.loadOAuthStore();
    const refreshStore = await loadOAuthRefreshStore(oauthStore, options.storage);
    const refreshKey = `sha256:${await sha256Hex(refreshToken)}`;
    const record = refreshStore.tokens[refreshKey];
    if (!record) {
      const consumed = refreshStore.consumed[refreshKey];
      if (!consumed || consumed.expires_at <= now) return reject(options);
      if (Object.hasOwn(refreshStore.revoked_families, consumed.family_id)) return reject(options);
      let retrySource = consumedRefreshRetrySource(consumed, now);
      let replacementPairUnavailable = false;
      if (retrySource) {
        const validation = await validateRefreshGrant(retrySource, body, base, options, dpop, oauthStore, false);
        if (validation.response) return rejected(options, validation.response);
        const retryAccessScope = consumed.access_scope ?? retrySource.scope;
        if (validation.accessScope !== retryAccessScope) {
          return rejected(options, json({ error: "invalid_scope" }, 400));
        }
        const replacement = await activeConsumedRefreshRetryPair(
          options.tokenVersion, refreshToken, retrySource, consumed.family_id, retryAccessScope, oauthStore, refreshStore, now,
        );
        if (!replacement) {
          retrySource = null;
          replacementPairUnavailable = true;
        } else {
          if (dpop && !(await consumeDpopProof(options.storage, dpop))) return rejectDpop(options);
          recordConsumedRefreshRetry(consumed);
          validation.client.last_used_at = Math.max(validation.client.created_at, now);
          await saveOAuthStores(oauthStore, refreshStore, options.storage);
          options.onRefreshEvent?.("retry_issued");
          return tokenResponse(replacement, retryAccessScope, retrySource.dpop_jkt);
        }
      }
      if (!replacementPairUnavailable && Number.isSafeInteger(consumed.retry_until) && consumed.retry_until! >= now
        && Number(consumed.retry_issues) >= MAX_REFRESH_RETRY_ISSUES) {
        options.onRefreshEvent?.("retry_exhausted");
        return json({
          error: "temporarily_unavailable",
          error_description: "concurrent refresh retry limit reached; retry with the newest token response",
        }, 429, { "retry-after": "1" });
      }
      const revocation = refreshFamilyAuthority(consumed.source, oauthStore, refreshStore.tokens, consumed.family_id);
      revokeOAuthRefreshFamily(oauthStore, refreshStore, consumed.family_id, consumed.expires_at);
      await options.saveStores(oauthStore, refreshStore, revocation);
      options.onRefreshEvent?.("family_revoked");
      return json({ error: "invalid_grant" }, 400);
    }

    const validation = await validateRefreshGrant(record, body, base, options, dpop, oauthStore, true);
    if (validation.response) return rejected(options, validation.response);
    if (dpop && !(await consumeDpopProof(options.storage, dpop))) return rejectDpop(options);
    let issued: IssuedTokenPair;
    try {
      issued = await issueTokenPair(
        oauthStore,
        refreshStore,
        record,
        options.tokenVersion,
        record.dpop_jkt,
        { derivationSeed: refreshToken, issuedAt: now, accessScope: validation.accessScope },
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "invalid_grant") throw error;
      delete refreshStore.tokens[refreshKey];
      await saveOAuthRefreshStore(options.storage, refreshStore);
      return reject(options);
    }
    delete refreshStore.tokens[refreshKey];
    const revocations = recordConsumedRefreshToken(oauthStore, refreshStore, refreshKey, record, record.family_expires_at, now, validation.accessScope);
    validation.client.last_used_at = Math.max(validation.client.created_at, now);
    await saveOAuthStores(oauthStore, refreshStore, options.storage, revocations);
    if (Object.hasOwn(refreshStore.revoked_families, record.family_id)) {
      options.onRefreshEvent?.("family_revoked");
      return json({ error: "invalid_grant" }, 400);
    }
    options.onRefreshEvent?.("rotated");
    return tokenResponse(issued, validation.accessScope, record.dpop_jkt);
  });
}

async function validateRefreshGrant(
  record: OAuthRefreshToken,
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
  dpop: VerifiedDpopProof | undefined,
  oauthStore: OAuthStore,
  allowDpopBinding: boolean,
): Promise<{ client: OAuthStore["clients"][string]; accessScope: string; response?: never } | { client?: never; accessScope?: never; response: Response }> {
  if (record.dpop_jkt && record.dpop_jkt !== dpop?.jkt) return { response: json({ error: "invalid_dpop_proof" }, 400) };
  if (!record.dpop_jkt && dpop?.jkt) {
    if (!allowDpopBinding) return { response: json({ error: "invalid_dpop_proof" }, 400) };
    record.dpop_jkt = dpop.jkt;
  }
  if (typeof body.client_id !== "string" || body.client_id !== record.client_id) {
    return { response: json({ error: "invalid_grant", error_description: "client mismatch" }, 400) };
  }
  if (!matchesMcpOAuthResource(base, record.resource, body.resource)) {
    return { response: json({ error: "invalid_target", error_description: "resource mismatch" }, 400) };
  }
  if (normalizeOAuthScope(record.scope, options.serverName) !== record.scope) {
    return { response: json({ error: "invalid_grant" }, 400) };
  }
  const accessScope = body.scope === undefined ? record.scope
    : typeof body.scope === "string" ? normalizeOAuthScope(body.scope, options.serverName) : null;
  if (!accessScope || !scopeSubset(accessScope, record.scope)) {
    return { response: json({ error: "invalid_scope" }, 400) };
  }
  if (!options.tokenVersion) throw new HttpError(503, "server_error", "OAuth token version is not configured");
  const account = oauthStore.accounts[record.account_id];
  const client = oauthStore.clients[record.client_id];
  if (!record.version || !(await safeEqual(record.version, options.tokenVersion)) || !account || !account.active
    || account.version !== record.account_version || account.role !== record.role || !client
    || client.trusted_account_id !== account.account_id || client.trusted_account_version !== account.version
    || client.trusted_role !== account.role) {
    return { response: json({ error: "invalid_grant" }, 400) };
  }
  return { client, accessScope };
}

function scopeSubset(requested: string, granted: string): boolean {
  const grantedScopes = new Set(granted.split(/\s+/).filter(Boolean));
  return requested.split(/\s+/).filter(Boolean).every((scope) => grantedScopes.has(scope));
}

function reject(options: OAuthTokenExchangeOptions): Response {
  options.onRefreshEvent?.("rejected");
  return json({ error: "invalid_grant" }, 400);
}

function rejectDpop(options: OAuthTokenExchangeOptions): Response {
  options.onRefreshEvent?.("rejected");
  return json({ error: "invalid_dpop_proof" }, 400);
}

function rejected(options: OAuthTokenExchangeOptions, response: Response): Response {
  options.onRefreshEvent?.("rejected");
  return response;
}
export async function activeConsumedRefreshRetryPair(
  tokenVersion: string,
  consumedRefreshToken: string,
  source: OAuthRefreshToken,
  familyId: string,
  accessScope: string,
  oauthStore: OAuthStore,
  refreshStore: OAuthRefreshStore,
  now: number,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const replacement = await deriveRefreshReplacementPair(tokenVersion, consumedRefreshToken);
  const refreshKey = `sha256:${await sha256Hex(replacement.refreshToken)}`;
  const accessKey = `sha256:${await sha256Hex(replacement.accessToken)}`;
  const refresh = refreshStore.tokens[refreshKey];
  const access = oauthStore.tokens[accessKey];
  const active = Boolean(refresh && access
    && !Object.hasOwn(refreshStore.consumed, refreshKey)
    && refresh.family_id === familyId
    && access.family_id === familyId
    && refresh.client_id === source.client_id
    && access.client_id === source.client_id
    && refresh.account_id === source.account_id
    && access.account_id === source.account_id
    && refresh.account_version === source.account_version
    && access.account_version === source.account_version
    && refresh.expires_at > now
    && refresh.family_expires_at > now
    && access.expires_at > now
    && access.scope === accessScope);
  return active ? replacement : null;
}
