import { sha256Hex, type OAuthRefreshToken, type OAuthRefreshStore, type OAuthStore } from "./oauth-state.ts";
import { deriveRefreshReplacementPair } from "./oauth-token-derivation.ts";

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
