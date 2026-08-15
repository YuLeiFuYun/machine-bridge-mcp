import { json, parseRequestBody } from "./http.ts";
import type { OAuthRefreshStore, OAuthStore } from "./oauth-state.ts";
import { CLIENT_ID_PATTERN } from "./oauth-record-contract.ts";
import { MAX_OAUTH_CLIENTS, OAUTH_CLIENT_REGISTRATION_REVISION } from "./oauth-client-contract.ts";
import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";

const BODY_LIMIT_BYTES = 64 * 1024;

export async function handleOAuthClientAdminOperation(options: {
  request: Request;
  store: OAuthStore;
  refreshStore: OAuthRefreshStore;
  save: (revocation?: AuthorityRevocation) => Promise<void>;
  now: number;
}): Promise<Response> {
  const { request, store, refreshStore, save, now } = options;
  if (request.method === "GET") {
    const clients = Object.values(store.clients)
      .sort((left, right) => right.last_used_at - left.last_used_at || left.client_name.localeCompare(right.client_name))
      .map((client) => ({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: [...client.redirect_uris],
        created_at: client.created_at,
        last_used_at: client.last_used_at,
        trusted_account_id: client.trusted_account_id ?? null,
        trusted_account_version: client.trusted_account_version ?? null,
        trusted_role: client.trusted_role ?? null,
        trusted_at: client.trusted_at ?? null,
        registration_revision: client.registration_revision ?? null,
        registration_current: client.registration_revision === OAUTH_CLIENT_REGISTRATION_REVISION,
        active_access_tokens: Object.values(store.tokens).filter((token) => token.client_id === client.client_id && token.expires_at > now).length,
        active_refresh_tokens: Object.values(refreshStore.tokens).filter((token) => token.client_id === client.client_id && token.expires_at > now).length,
      }));
    return json({ clients, maximum: MAX_OAUTH_CLIENTS });
  }
  if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, DELETE" });
  const body = await parseRequestBody(request, BODY_LIMIT_BYTES);
  const clientId = String(body.client_id ?? "");
  if (!CLIENT_ID_PATTERN.test(clientId)) return json({ error: "invalid_client_id" }, 400);
  const client = store.clients[clientId];
  if (!client) return json({ error: "client_not_found" }, 404);
  const revocation = client.trusted_account_id && Number.isSafeInteger(client.trusted_account_version)
    ? { accountId: client.trusted_account_id, accountVersion: client.trusted_account_version!, clientId }
    : undefined;
  delete store.clients[clientId];
  for (const [key, value] of Object.entries(store.codes)) if (value.client_id === clientId) delete store.codes[key];
  for (const [key, value] of Object.entries(store.tokens)) if (value.client_id === clientId) delete store.tokens[key];
  for (const [key, value] of Object.entries(refreshStore.tokens)) if (value.client_id === clientId) delete refreshStore.tokens[key];
  await save(revocation);
  return json({ removed: true, client_id: clientId });
}
