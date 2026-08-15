import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { OAuthRefreshToken, OAuthStore, OAuthToken } from "./oauth-state.ts";

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
