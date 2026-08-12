export const OAUTH_CLIENT_REGISTRATION_REVISION = 2;
// Persisted clients without a revision predate the refresh-capable DCR contract and remain readable, but must be recreated before a new authorization.
export const MAX_OAUTH_CLIENTS = 50;
export const MAX_OAUTH_CLIENTS_PER_IDENTITY = 5;
export const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;
export const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;

interface RegistrationClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  has_been_authorized?: boolean;
  registration_identity?: string;
  registration_revision?: number;
}

export function reusablePendingOAuthClient(
  clients: RegistrationClient[], identity: string, clientName: string, redirectUris: string[],
): RegistrationClient | null {
  return clients.find((client) => client.has_been_authorized === false
    && client.registration_identity === identity
    && client.registration_revision === OAUTH_CLIENT_REGISTRATION_REVISION
    && client.client_name === clientName
    && sameStrings(client.redirect_uris, redirectUris)) ?? null;
}

export function oauthClientRegistrationDocument(client: RegistrationClient): Record<string, unknown> {
  return {
    client_id: client.client_id, client_name: client.client_name, redirect_uris: [...client.redirect_uris],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: "none", client_id_issued_at: client.created_at,
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
