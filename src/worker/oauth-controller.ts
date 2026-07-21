import { DEFAULT_ACCOUNT_ROLE, normalizeAccountRole, type AccountRole } from "./access.ts";
import { accountAdminAuthorized, consumeAccountAdminNonce, handleAccountAdminOperation } from "./account-admin.ts";
import { exchangeOAuthToken } from "./oauth-tokens.ts";
import {
  AUTH_BLOCK_SECONDS, accountByName, authorizationIdentity, emptyOAuthStore,
  isCurrentOAuthStore, pruneAuthFailures, pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken,
  recordAuthorizationFailure, safeEqual, sha256Hex, validateAuthorizationRequest, verifyAccountPassword,
  type OAuthClient, type OAuthStore,
} from "./oauth-state.ts";
import {
  HttpError, authorizationRedirectLocation, json, normalizeDisplayText,
  normalizeRedirectUri, oauthRedirect, parseRequestBody, searchParamsObject,
} from "./http.ts";
import { authorizationPage } from "./oauth-authorization-page.ts";

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;
const MAX_OAUTH_CLIENTS = 50;
const MAX_OAUTH_CLIENTS_PER_IDENTITY = 5;
const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_CODES_PER_CLIENT = 10;
const MAX_OAUTH_CODES = 200;
const MAX_AUTH_FAILURE_IDENTITIES = 200;

export interface OAuthControllerEnv {
  ACCOUNT_ADMIN_SECRET: string;
  DAEMON_DEVICE_PUBLIC_KEY: string;
  OAUTH_TOKEN_VERSION: string;
}

export interface AuthorizedToken {
  tokenKey: string;
  accountId: string;
  accountVersion: number;
  clientId: string;
  role: AccountRole;
}

export class OAuthController {
  private readonly ctx: DurableObjectState;
  private readonly env: OAuthControllerEnv;
  private readonly serverName: string;
  private oauthQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: OAuthControllerEnv, serverName: string) {
    this.ctx = ctx;
    this.env = env;
    this.serverName = serverName;
  }

  private async oauthStore(): Promise<OAuthStore> {
    const raw = await this.ctx.storage.get<unknown>("oauth");
    if (raw !== undefined && !isCurrentOAuthStore(raw)) {
      throw new HttpError(503, "oauth_state_schema_mismatch", "OAuth state does not match the current schema");
    }
    const store = isCurrentOAuthStore(raw) ? raw : emptyOAuthStore();
    let changed = false;
    const now = Math.floor(Date.now() / 1000);

    for (const account of Object.values(store.accounts)) {
      if (normalizeAccountRole(account.role)) continue;
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
    if (changed) await this.ctx.storage.put("oauth", store);
    return store;
  }

  async handleAccountAdmin(request: Request, operation: "accounts" | "rotate-password"): Promise<Response> {
    return this.withOAuthLock(async () => {
      const now = Math.floor(Date.now() / 1000);
      const authorization = await accountAdminAuthorized(request, this.env.ACCOUNT_ADMIN_SECRET ?? "", now);
      if (!authorization || !(await consumeAccountAdminNonce(this.ctx.storage, authorization, now))) {
        return json({ error: "unauthorized" }, 401);
      }
      const store = await this.oauthStore();
      return handleAccountAdminOperation({
        request, operation, store, now,
        save: () => this.ctx.storage.put("oauth", store),
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

    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const registrationIdentity = await authorizationIdentity(request, this.identityKey());
      const pendingIdentityClientCount = Object.values(store.clients).filter((client) => (
        client.registration_identity === registrationIdentity && client.has_been_authorized === false
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
        client_name: normalizeDisplayText(stringOrUndefined(body.client_name) ?? "MCP Client", 128),
        redirect_uris: normalized,
        created_at: now,
        last_used_at: now,
        has_been_authorized: false,
        registration_identity: registrationIdentity,
      };
      store.clients[client.client_id] = client;
      await this.ctx.storage.put("oauth", store);
      return json({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: client.created_at,
      });
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
      delete store.auth_failures[identity];
      client.last_used_at = now;
      client.has_been_authorized = true;

      const code = randomToken("mcp_code");
      const redirectLocation = authorizationRedirectLocation(redirectUri, code, state);
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
      const account = store.accounts[record.account_id];
      if (!account || !account.active || account.version !== record.account_version || account.role !== record.role) {
        delete store.tokens[key];
        await this.ctx.storage.put("oauth", store);
        return null;
      }
      return {
        tokenKey: key, accountId: account.account_id,
        accountVersion: account.version, clientId: record.client_id, role: account.role,
      };
    });
  }

  private async withOAuthLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.oauthQueue;
    let release = () => {};
    this.oauthQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  identityKey(): string {
    const key = this.env.OAUTH_TOKEN_VERSION || this.env.ACCOUNT_ADMIN_SECRET;
    if (!key) throw new HttpError(503, "server_not_configured", "OAuth identity key is not configured");
    return key;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
