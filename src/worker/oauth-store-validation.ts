import { normalizeAccountRole } from "./access.ts";
import type { AccountRecord, OAuthClient, OAuthCode, OAuthFailure, OAuthStore, OAuthToken } from "./oauth-state.ts";
import {
  ACCOUNT_ID_PATTERN, AUTHORIZATION_CODE_PATTERN, AUTHORIZATION_IDENTITY_PATTERN, CLIENT_ID_PATTERN,
  JWK_THUMBPRINT_PATTERN, REFRESH_FAMILY_ID_PATTERN, TOKEN_HASH_PATTERN,
} from "./oauth-record-contract.ts";
import {
  hasOnlyRecordFields, OAUTH_ACCOUNT_FIELDS, OAUTH_CLIENT_FIELDS, OAUTH_CODE_FIELDS,
  OAUTH_FAILURE_FIELDS, OAUTH_STORE_FIELDS, OAUTH_TOKEN_FIELDS,
} from "./oauth-field-contract.ts";
import { OAUTH_CLIENT_REGISTRATION_REVISION } from "./oauth-client-contract.ts";

const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const BOUNDED_SECRET_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function isCurrentOAuthStore(value: unknown): value is OAuthStore {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_STORE_FIELDS) || value.schema_version !== 1) return false;
  if (!plainRecord(value.accounts) || !plainRecord(value.clients) || !plainRecord(value.codes)
      || !plainRecord(value.tokens) || !plainRecord(value.auth_failures)) return false;
  return entriesMatch(value.accounts, (key, record) => ACCOUNT_ID_PATTERN.test(key) && validAccount(record, key))
    && entriesMatch(value.clients, (key, record) => CLIENT_ID_PATTERN.test(key) && validClient(record, key))
    && entriesMatch(value.codes, (key, record) => AUTHORIZATION_CODE_PATTERN.test(key) && validCode(record))
    && entriesMatch(value.tokens, (key, record) => TOKEN_HASH_PATTERN.test(key) && validToken(record))
    && entriesMatch(value.auth_failures, (key, record) => AUTHORIZATION_IDENTITY_PATTERN.test(key) && validFailure(record));
}

function validAccount(value: unknown, key: string): value is AccountRecord {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_ACCOUNT_FIELDS)) return false;
  return value.account_id === key
    && ACCOUNT_NAME_PATTERN.test(stringValue(value.name))
    && boundedString(value.display_name, 128)
    && currentAccountRole(value.role)
    && typeof value.active === "boolean"
    && positiveInteger(value.version)
    && BOUNDED_SECRET_PATTERN.test(stringValue(value.password_salt))
    && BOUNDED_SECRET_PATTERN.test(stringValue(value.password_hash))
    && positiveInteger(value.created_at)
    && positiveInteger(value.updated_at)
    && Number(value.updated_at) >= Number(value.created_at);
}

function validClient(value: unknown, key: string): value is OAuthClient {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_CLIENT_FIELDS)
      || value.client_id !== key || !boundedString(value.client_name, 128)
      || !Array.isArray(value.redirect_uris) || value.redirect_uris.length < 1 || value.redirect_uris.length > 5
      || !value.redirect_uris.every((uri) => validRedirectUri(uri))
      || !positiveInteger(value.created_at) || !positiveInteger(value.last_used_at)
      || Number(value.last_used_at) < Number(value.created_at)
      || typeof value.has_been_authorized !== "boolean"
      || !AUTHORIZATION_IDENTITY_PATTERN.test(stringValue(value.registration_identity))
      || value.registration_revision !== OAUTH_CLIENT_REGISTRATION_REVISION) return false;
  const trusted = [value.trusted_account_id, value.trusted_account_version, value.trusted_role];
  if (trusted.every((item) => item === undefined)) return value.trusted_at === undefined;
  return trusted.every((item) => item !== undefined)
    && ACCOUNT_ID_PATTERN.test(stringValue(value.trusted_account_id))
    && positiveInteger(value.trusted_account_version)
    && currentAccountRole(value.trusted_role)
    && (value.trusted_at === undefined || positiveInteger(value.trusted_at));
}

function validCode(value: unknown): value is OAuthCode {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_CODE_FIELDS)) return false;
  return CLIENT_ID_PATTERN.test(stringValue(value.client_id))
    && ACCOUNT_ID_PATTERN.test(stringValue(value.account_id))
    && positiveInteger(value.account_version)
    && currentAccountRole(value.role)
    && validRedirectUri(value.redirect_uri)
    && /^[A-Za-z0-9_-]{43}$/.test(stringValue(value.code_challenge))
    && boundedString(value.scope, 256)
    && validResource(value.resource)
    && positiveInteger(value.expires_at);
}

function validToken(value: unknown): value is OAuthToken {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_TOKEN_FIELDS)) return false;
  return CLIENT_ID_PATTERN.test(stringValue(value.client_id))
    && ACCOUNT_ID_PATTERN.test(stringValue(value.account_id))
    && positiveInteger(value.account_version)
    && currentAccountRole(value.role)
    && boundedString(value.scope, 256)
    && validResource(value.resource)
    && boundedString(value.version, 256)
    && positiveInteger(value.expires_at)
    && (value.family_id === undefined || REFRESH_FAMILY_ID_PATTERN.test(stringValue(value.family_id)))
    && (value.dpop_jkt === undefined || JWK_THUMBPRINT_PATTERN.test(stringValue(value.dpop_jkt)));
}

function validFailure(value: unknown): value is OAuthFailure {
  if (!plainRecord(value) || !hasOnlyRecordFields(value, OAUTH_FAILURE_FIELDS)) return false;
  return positiveInteger(value.count)
    && positiveInteger(value.window_started)
    && nonnegativeInteger(value.blocked_until)
    && positiveInteger(value.last_attempt)
    && Number(value.last_attempt) >= Number(value.window_started);
}

function validRedirectUri(value: unknown): boolean {
  if (!boundedString(value, 1024)) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (secure || loopback) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function validResource(value: unknown): boolean {
  if (!boundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (secure || loopback) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function entriesMatch(value: Record<string, unknown>, predicate: (key: string, record: unknown) => boolean): boolean {
  return Object.entries(value).every(([key, record]) => predicate(key, record));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function currentAccountRole(value: unknown): boolean {
  return typeof value === "string" && normalizeAccountRole(value) === value;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonnegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
