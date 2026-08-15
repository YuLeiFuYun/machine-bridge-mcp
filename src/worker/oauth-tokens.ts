import { consumeDpopProof, verifyDpopProof, type VerifiedDpopProof } from "./dpop.ts";
import { HttpError, json, parseRequestBody } from "./http.ts";
import { loadOAuthRefreshStore } from "./oauth-refresh-families.ts";
import { exchangeRefreshToken } from "./oauth-refresh-exchange.ts";
import {
  issueTokenPair,
  saveOAuthStores,
  tokenResponse,
  type OAuthTokenExchangeOptions,
} from "./oauth-token-issuance.ts";
import { normalizeOAuthScope, pkceS256, safeEqual } from "./oauth-state.ts";

export type { OAuthRefreshEvent } from "./oauth-token-issuance.ts";
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
  const grantType = String(body.grant_type ?? "");
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
  const code = String(body.code ?? "");
  const verifier = String(body.code_verifier ?? "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
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
      if (String(body.client_id ?? "") !== record.client_id || String(body.redirect_uri ?? "") !== record.redirect_uri) {
        return json({ error: "invalid_grant", error_description: "client or redirect mismatch" }, 400);
      }
      if (String(body.resource ?? record.resource) !== record.resource || record.resource !== `${base}/mcp`) {
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
      client.last_used_at = Math.floor(Date.now() / 1000);
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
