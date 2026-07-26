import { consumeDpopProof, type VerifiedDpopProof } from "./dpop.ts";
import { HttpError, json } from "./http.ts";
import {
  consumedRefreshRetrySource,
  loadOAuthRefreshStore,
  MAX_REFRESH_RETRY_ISSUES,
  OAUTH_REFRESH_STORE_KEY,
  recordConsumedRefreshRetry,
  recordConsumedRefreshToken,
  revokeOAuthRefreshFamily,
} from "./oauth-refresh-families.ts";
import {
  issueTokenPair,
  saveOAuthStores,
  tokenResponse,
  type IssuedTokenPair,
  type OAuthTokenExchangeOptions,
} from "./oauth-token-issuance.ts";
import { normalizeOAuthScope, safeEqual, sha256Hex, type OAuthRefreshToken, type OAuthStore } from "./oauth-state.ts";

export async function exchangeRefreshToken(
  body: Record<string, unknown>,
  base: string,
  options: OAuthTokenExchangeOptions,
  dpop?: VerifiedDpopProof,
): Promise<Response> {
  const refreshToken = String(body.refresh_token ?? "");
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
      const retrySource = consumedRefreshRetrySource(consumed, now);
      if (retrySource) {
        const validation = await validateRefreshGrant(retrySource, body, base, options, dpop, oauthStore, false);
        if (validation.response) return rejected(options, validation.response);
        if (dpop && !(await consumeDpopProof(options.storage, dpop))) return rejectDpop(options);
        const issued = await issueTokenPair(
          oauthStore,
          refreshStore,
          retrySource,
          options.tokenVersion,
          retrySource.dpop_jkt,
          { derivationSeed: refreshToken, issuedAt: consumed.consumed_at },
        );
        recordConsumedRefreshRetry(consumed);
        validation.client.last_used_at = now;
        await saveOAuthStores(oauthStore, refreshStore, options.storage);
        options.onRefreshEvent?.("retry_issued");
        return tokenResponse(issued, retrySource.scope, retrySource.dpop_jkt);
      }
      if (Number.isSafeInteger(consumed.retry_until) && consumed.retry_until! >= now
        && Number(consumed.retry_issues) >= MAX_REFRESH_RETRY_ISSUES) {
        options.onRefreshEvent?.("retry_exhausted");
        return json({
          error: "temporarily_unavailable",
          error_description: "concurrent refresh retry limit reached; retry with the newest token response",
        }, 429, { "retry-after": "1" });
      }
      revokeOAuthRefreshFamily(oauthStore, refreshStore, consumed.family_id, consumed.expires_at);
      await saveOAuthStores(oauthStore, refreshStore, options.storage);
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
        { derivationSeed: refreshToken, issuedAt: now },
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "invalid_grant") throw error;
      delete refreshStore.tokens[refreshKey];
      await options.storage.put(OAUTH_REFRESH_STORE_KEY, refreshStore);
      return reject(options);
    }
    delete refreshStore.tokens[refreshKey];
    recordConsumedRefreshToken(oauthStore, refreshStore, refreshKey, record, record.family_expires_at, now);
    validation.client.last_used_at = now;
    await saveOAuthStores(oauthStore, refreshStore, options.storage);
    options.onRefreshEvent?.("rotated");
    return tokenResponse(issued, record.scope, record.dpop_jkt);
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
): Promise<{ client: OAuthStore["clients"][string]; response?: never } | { client?: never; response: Response }> {
  if (record.dpop_jkt && record.dpop_jkt !== dpop?.jkt) return { response: json({ error: "invalid_dpop_proof" }, 400) };
  if (!record.dpop_jkt && dpop?.jkt) {
    if (!allowDpopBinding) return { response: json({ error: "invalid_dpop_proof" }, 400) };
    record.dpop_jkt = dpop.jkt;
  }
  if (String(body.client_id ?? "") !== record.client_id) {
    return { response: json({ error: "invalid_grant", error_description: "client mismatch" }, 400) };
  }
  if (String(body.resource ?? record.resource) !== record.resource || record.resource !== `${base}/mcp`) {
    return { response: json({ error: "invalid_target", error_description: "resource mismatch" }, 400) };
  }
  if (body.scope !== undefined && normalizeOAuthScope(body.scope, options.serverName) !== record.scope) {
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
  return { client };
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
