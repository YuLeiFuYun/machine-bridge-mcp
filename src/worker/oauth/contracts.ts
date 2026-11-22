export const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_-]{43}$/;

export const CLIENT_ID_PATTERN = /^mcp_client_[A-Za-z0-9_-]{43}$/;

export const AUTHORIZATION_CODE_PATTERN = /^mcp_code_[A-Za-z0-9_-]{43}$/;

export const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const REFRESH_FAMILY_ID_PATTERN = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export const JWK_THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const AUTHORIZATION_IDENTITY_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
export const OAUTH_STORE_FIELDS: ReadonlySet<string> = new Set([
  "schema_version", "accounts", "clients", "codes", "tokens", "auth_failures",
]);

export const OAUTH_ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  "account_id", "name", "display_name", "role", "active", "version", "password_salt", "password_hash", "created_at", "updated_at",
]);

export const OAUTH_CLIENT_FIELDS: ReadonlySet<string> = new Set([
  "client_id", "client_name", "redirect_uris", "created_at", "last_used_at", "has_been_authorized",
  "registration_identity", "registration_revision", "trusted_account_id", "trusted_account_version", "trusted_role", "trusted_at",
]);

export const OAUTH_CODE_FIELDS: ReadonlySet<string> = new Set([
  "client_id", "account_id", "account_version", "role", "redirect_uri", "code_challenge", "scope", "resource", "expires_at",
]);

export const OAUTH_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "client_id", "account_id", "account_version", "role", "scope", "resource", "version", "expires_at", "family_id", "dpop_jkt",
]);

export const OAUTH_FAILURE_FIELDS: ReadonlySet<string> = new Set(["count", "window_started", "blocked_until", "last_attempt"]);

export const OAUTH_REFRESH_STORE_FIELDS: ReadonlySet<string> = new Set(["schema_version", "tokens", "consumed", "revoked_families"]);

export const OAUTH_REFRESH_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "client_id", "account_id", "account_version", "role", "scope", "resource", "version", "expires_at", "family_id", "dpop_jkt",
  "family_expires_at", "issued_at",
]);

export const OAUTH_CONSUMED_REFRESH_FIELDS: ReadonlySet<string> = new Set([
  "family_id", "consumed_at", "expires_at", "retry_until", "retry_issues", "source", "access_scope",
]);

export const OAUTH_REVOKED_REFRESH_FAMILY_FIELDS: ReadonlySet<string> = new Set(["expires_at", "reason"]);

export const OAUTH_REFRESH_SHARD_FIELDS: ReadonlySet<string> = new Set(["schema_version", "records"]);

export function hasOnlyRecordFields(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}
export const OAUTH_CLIENT_REGISTRATION_REVISION = 2;

export const MAX_OAUTH_CLIENTS = 50;

export const MAX_OAUTH_CLIENTS_PER_IDENTITY = 5;

export const MAX_OAUTH_REDIRECT_URIS = 6;

export const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;

export const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;

interface RegistrationClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  has_been_authorized: boolean;
  registration_identity: string;
  registration_revision: number;
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
