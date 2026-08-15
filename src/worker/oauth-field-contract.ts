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
