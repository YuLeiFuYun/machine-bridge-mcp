import { DEFAULT_ACCOUNT_ROLE, normalizeAccountRole, type AuthorizedToken } from "./access.ts";
import { accountAdminAuthorized, consumeAccountAdminNonce, handleAccountAdminOperation } from "./account-admin.ts";
import { exchangeOAuthToken, type OAuthRefreshEvent } from "./oauth-tokens.ts";
import {
  AUTH_BLOCK_SECONDS, accountByName, authorizationIdentity, emptyOAuthStore,
  normalizeOAuthScope, pruneAuthFailures, pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken,
  recordAuthorizationFailure, safeEqual, sha256Hex, validateAuthorizationRequest, verifyAccountPassword,
  type OAuthClient, type OAuthStore,
} from "./oauth-state.ts";
import {
  HttpError, authorizationRedirectLocation, json, normalizeDisplayText,
  normalizeRedirectUri, oauthRedirect, parseRequestBody, searchParamsObject,
} from "./http.ts";
import { authorizationPage } from "./oauth-authorization-page.ts";
import { handleOAuthClientAdminOperation } from "./oauth-client-admin.ts";
import {
  MAX_OAUTH_CLIENTS, MAX_OAUTH_CLIENTS_PER_IDENTITY, OAUTH_CLIENT_REGISTRATION_REVISION,
  OAUTH_CLIENT_IDLE_TTL_SECONDS, OAUTH_UNUSED_CLIENT_TTL_SECONDS, oauthClientRegistrationDocument, reusablePendingOAuthClient,
} from "./oauth-client-contract.ts";
import { loadOAuthRefreshStore } from "./oauth-refresh-families.ts"; import { oauthRefreshPersistenceEntries } from "./oauth-refresh-persistence.ts";
import { isCurrentOAuthStore } from "./oauth-store-validation.ts";
import { putWithAuthorityRevocation, putWithAuthorityRevocations } from "./authority-revocations.ts";

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_CODES_PER_CLIENT = 10;
const MAX_OAUTH_CODES = 200;
const MAX_AUTH_FAILURE_IDENTITIES = 200;

export interface OAuthControllerEnv {
  DAEMON_DEVICE_PUBLIC_KEY: string;
  OAUTH_TOKEN_VERSION: string;
}

export class OAuthController {
  private readonly ctx: DurableObjectState;
  private readonly env: OAuthControllerEnv;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly onRefreshEvent?: (event: OAuthRefreshEvent) => void;

  constructor(
    ctx: DurableObjectState,
    env: OAuthControllerEnv,
    serverName: string,
    serverVersion: string,
    onRefreshEvent?: (event: OAuthRefreshEvent) => void,
  ) {
    this.ctx = ctx;
    this.env = env;
    this.serverName = serverName;
    this.serverVersion = serverVersion;
    this.onRefreshEvent = onRefreshEvent;
  }

  private async oauthStore(): Promise<OAuthStore> {
    const raw = await this.ctx.storage.get<unknown>("oauth");
    if (raw !== undefined && !isCurrentOAuthStore(raw)) {
      throw new HttpError(503, "oauth_state_schema_mismatch", "OAuth state does not match the current schema");
    }
    const store = isCurrentOAuthStore(raw) ? raw : emptyOAuthStore();
    let changed = false; const revocations = [];
    const now = Math.floor(Date.now() / 1000);

    for (const account of Object.values(store.accounts)) {
      if (normalizeAccountRole(account.role)) continue;
      revocations.push({ accountId: account.account_id, accountVersion: account.version });
      account.role = DEFAULT_ACCOUNT_ROLE;
      account.active = false;
      account.version = Number.isInteger(account.version) && account.version > 0 ? account.version + 1 : 1;
      account.updated_at = now;
      changed = true;
    }

    for (const [code, value] of Object.entries(store.codes)) {
      const account = store.accounts[value.account_id];
      if (value.expires_at <= now || !account || !account.active || account.version !== value.account_version || account.role !== value.role) {
        delete store.codes[code];
        changed = true;
      }
    }
    for (const [token, value] of Object.entries(store.tokens)) {
      const account = store.accounts[value.account_id];
      if (value.expires_at <= now || !account || !account.active || account.version !== value.account_version || account.role !== value.role) {
        delete store.tokens[token];
        changed = true;
      }
    }
    for (const [identity, value] of Object.entries(store.auth_failures)) {
      if (!identity.startsWith("hmac-sha256:") || value.last_attempt + AUTH_BLOCK_SECONDS <= now) {
        delete store.auth_failures[identity];
        changed = true;
      }
    }
    const activeClientIds = new Set([
      ...Object.values(store.codes).map((value) => value.client_id),
      ...Object.values(store.tokens).map((value) => value.client_id),
    ]);
    for (const [clientId, client] of Object.entries(store.clients)) {
      if (client.registration_identity && !client.registration_identity.startsWith("hmac-sha256:")) {
        delete client.registration_identity;
        changed = true;
      }
      const ttl = client.has_been_authorized === false ? OAUTH_UNUSED_CLIENT_TTL_SECONDS : OAUTH_CLIENT_IDLE_TTL_SECONDS;
      if (!activeClientIds.has(clientId) && client.last_used_at + ttl <= now) {
        delete store.clients[clientId];
        changed = true;
      }
    }
    if (changed) await putWithAuthorityRevocations(this.ctx.storage, { oauth: store }, revocations);
    return store;
  }

  async handleAccountAdmin(request: Request, operation: "accounts" | "rotate-password"): Promise<Response> {
    return this.withOAuthLock(async () => {
      const now = Math.floor(Date.now() / 1000);
      const authorization = await accountAdminAuthorized(
        request,
        this.env.DAEMON_DEVICE_PUBLIC_KEY ?? "",
        new URL(request.url).origin,
        this.serverName,
        this.serverVersion,
        now,
      );
      if (!authorization || !(await consumeAccountAdminNonce(this.ctx.storage, authorization, now))) {
        return json({ error: "unauthorized" }, 401);
      }
      const store = await this.oauthStore();
      return handleAccountAdminOperation({
        request: authorization.request, operation, store, now,
        save: (revocation) => putWithAuthorityRevocation(this.ctx.storage, { oauth: store }, revocation),
      });
    });
  }

  async handleClientAdmin(request: Request): Promise<Response> {
    return this.withOAuthLock(async () => {
      const now = Math.floor(Date.now() / 1000);
      const authorization = await accountAdminAuthorized(
        request,
        this.env.DAEMON_DEVICE_PUBLIC_KEY ?? "",
        new URL(request.url).origin,
        this.serverName,
        this.serverVersion,
        now,
      );
      if (!authorization || !(await consumeAccountAdminNonce(this.ctx.storage, authorization, now))) {
        return json({ error: "unauthorized" }, 401);
      }
      const store = await this.oauthStore();
      const refreshStore = await loadOAuthRefreshStore(store, this.ctx.storage);
      return handleOAuthClientAdminOperation({
        request: authorization.request, store, refreshStore, now,
        save: (revocation) => putWithAuthorityRevocation(this.ctx.storage, {
          oauth: store, ...oauthRefreshPersistenceEntries(refreshStore),
        }, revocation),
      });
    });
  }

  async registerClient(request: Request): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array" }, 400);
    }
    if (redirectUris.length > 5) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must contain at most 5 entries" }, 400);
    }
    const suppliedRedirectUris = redirectUris.map((item) => String(item));
    if (suppliedRedirectUris.some((item) => item.length > 1024)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uri is too long" }, 400);
    }
    const canonicalRedirectUris = suppliedRedirectUris.map(normalizeRedirectUri);
    if (canonicalRedirectUris.some((item) => item === null)) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be canonicalizable https or local http URLs without credentials or fragments" }, 400);
    }
    const normalized = [...new Set(canonicalRedirectUris as string[])];
    const clientName = normalizeDisplayText(stringOrUndefined(body.client_name) ?? "MCP Client", 128);

    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const registrationIdentity = await authorizationIdentity(request, this.identityKey());
      const clients = Object.values(store.clients);
      const reusable = reusablePendingOAuthClient(clients, registrationIdentity, clientName, normalized);
      if (reusable) return json(oauthClientRegistrationDocument(reusable), 201);
      const pendingIdentityClientCount = clients.filter((client) => (
        client.registration_identity === registrationIdentity && client.has_been_authorized === false
        && client.registration_revision === OAUTH_CLIENT_REGISTRATION_REVISION
      )).length;
      if (pendingIdentityClientCount >= MAX_OAUTH_CLIENTS_PER_IDENTITY) {
        return json({ error: "too_many_requests", error_description: "pending client registration limit reached for this source" }, 429);
      }
      if (Object.keys(store.clients).length >= MAX_OAUTH_CLIENTS) {
        return json({ error: "temporarily_unavailable", error_description: "client registry is full; remove stale state or retry after inactive clients expire" }, 503);
      }
      const now = Math.floor(Date.now() / 1000);
      const client: OAuthClient = {
        client_id: randomToken("mcp_client"),
        client_name: clientName,
        redirect_uris: normalized,
        created_at: now,
        last_used_at: now,
        has_been_authorized: false,
        registration_identity: registrationIdentity,
        registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
      };
      store.clients[client.client_id] = client;
      await this.ctx.storage.put("oauth", store);
      return json(oauthClientRegistrationDocument(client), 201);
    });
  }

  async authorizeGet(request: Request, base: string): Promise<Response> {
    const body = searchParamsObject(new URL(request.url).searchParams);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const validation = validateAuthorizationRequest(body, base, this.serverName, store);
      if ("error" in validation) {
        return authorizationPage({ request, base, serverName: this.serverName, error: validation.error, submitted: body, status: validation.status, allowSubmit: false });
      }
      return authorizationPage({ request, base, serverName: this.serverName, submitted: body, authorization: validation.value });
    });
  }

  async authorizeSubmit(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const validation = validateAuthorizationRequest(body, base, this.serverName, store);
      if ("error" in validation) {
        return authorizationPage({ request, base, serverName: this.serverName, error: validation.error, submitted: body, status: validation.status, allowSubmit: false });
      }
      const { client, clientId, redirectUri, codeChallenge, requestedResource, scope, state } = validation.value;
      const now = Math.floor(Date.now() / 1000);
      const identity = await authorizationIdentity(request, this.identityKey());
      const failure = store.auth_failures[identity];
      if (failure?.blocked_until > now) {
        return authorizationPage({ request, base, serverName: this.serverName, error: "Too many failed attempts. Try again later.", submitted: body, status: 429, authorization: validation.value });
      }

      const account = accountByName(store, body.account_name);
      const credentialsValid = Boolean(account?.active && await verifyAccountPassword(account, body.account_password));
      if (!account || !credentialsValid) {
        recordAuthorizationFailure(store, identity, now);
        pruneAuthFailures(store, MAX_AUTH_FAILURE_IDENTITIES);
        await this.ctx.storage.put("oauth", store);
        const status = store.auth_failures[identity]?.blocked_until > now ? 429 : 401;
        return authorizationPage({ request, base, serverName: this.serverName, error: "Invalid account credentials.", submitted: body, status, authorization: validation.value });
      }
      if (client.trusted_account_id && client.trusted_account_id !== account.account_id) {
        return authorizationPage({ request, base, serverName: this.serverName, error: "This client is already bound to another account. Revoke it locally before changing accounts.", submitted: body, status: 409, authorization: validation.value });
      }
      delete store.auth_failures[identity];
      client.last_used_at = now;
      client.has_been_authorized = true;
      client.trusted_account_id = account.account_id;
      client.trusted_account_version = account.version;
      client.trusted_role = account.role;
      client.trusted_at ||= now;

      const code = randomToken("mcp_code");
      const redirectLocation = authorizationRedirectLocation(redirectUri, code, state, base);
      store.codes[code] = {
        client_id: clientId,
        account_id: account.account_id,
        account_version: account.version,
        role: account.role,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        scope,
        resource: requestedResource,
        expires_at: now + 300,
      };
      pruneClientRecordByExpiry(store.codes, clientId, MAX_CODES_PER_CLIENT);
      pruneRecordByExpiry(store.codes, MAX_OAUTH_CODES);
      await this.ctx.storage.put("oauth", store);

      return oauthRedirect(redirectLocation);
    });
  }

  exchangeToken(request: Request, base: string): Promise<Response> {
    return exchangeOAuthToken(request, base, {
      storage: this.ctx.storage,
      tokenVersion: this.env.OAUTH_TOKEN_VERSION ?? "",
      serverName: this.serverName,
      loadOAuthStore: () => this.oauthStore(),
      withLock: (callback) => this.withOAuthLock(callback),
      onRefreshEvent: this.onRefreshEvent,
      saveStores: (oauthStore, refreshStore, revocation) => putWithAuthorityRevocation(this.ctx.storage, {
        oauth: oauthStore, ...oauthRefreshPersistenceEntries(refreshStore),
      }, revocation),
    });
  }

  async verifyAccessToken(token: string, base: string): Promise<AuthorizedToken | null> {
    return this.withOAuthLock(async () => {
      if (!token) return null;
      const store = await this.oauthStore();
      const key = `sha256:${await sha256Hex(token)}`;
      const record = store.tokens[key];
      if (!record) return null;
      if (record.expires_at <= Math.floor(Date.now() / 1000)) {
        delete store.tokens[key];
        await this.ctx.storage.put("oauth", store);
        return null;
      }
      const currentVersion = this.env.OAUTH_TOKEN_VERSION ?? "";
      if (!record.version || !currentVersion || !(await safeEqual(record.version, currentVersion))) return null;
      if (record.resource !== `${base}/mcp`) return null;
      if (normalizeOAuthScope(record.scope, this.serverName) !== record.scope) { delete store.tokens[key]; await this.ctx.storage.put("oauth", store); return null; }
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
        await this.ctx.storage.put("oauth", store);
        return null;
      }
      return {
        tokenKey: key, accountId: account.account_id,
        accountVersion: account.version, clientId: record.client_id, familyId: String(record.family_id || ""), dpopJkt: String(record.dpop_jkt || ""), role: account.role,
      };
    });
  }

  private async withOAuthLock<T>(callback: () => Promise<T>): Promise<T> {
    let value: T | undefined;
    let failed = false, failure: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        value = await callback();
      } catch (error) {
        failed = true;
        failure = error;
      }
    });
    if (failed) throw failure;
    return value as T;
  }

  identityKey(): string {
    const key = this.env.OAUTH_TOKEN_VERSION;
    if (!key) throw new HttpError(503, "server_not_configured", "OAuth identity key is not configured");
    return key;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
