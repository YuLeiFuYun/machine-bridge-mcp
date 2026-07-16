import { type AccountRole } from "./access.ts";
import { accountAdminAuthorized, handleAccountAdminOperation } from "./account-admin.ts";
import { exchangeOAuthToken } from "./oauth-tokens.ts";
import {
  AUTH_BLOCK_SECONDS, accountByName, authorizationIdentity, emptyOAuthStore,
  isCurrentOAuthStore, pruneAuthFailures, pruneClientRecordByExpiry, pruneRecordByExpiry, randomToken,
  recordAuthorizationFailure, safeEqual, sha256Hex, validateAuthorizationRequest, verifyAccountPassword,
  type OAuthClient, type OAuthStore, type ValidatedAuthorization,
} from "./oauth-state.ts";
import {
  HttpError, authorizationRedirectLocation, escapeHtml, html, json, normalizeDisplayText,
  normalizeRedirectUri, oauthRedirect, parseRequestBody, searchParamsEntries, searchParamsObject,
} from "./http.ts";

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;
const MAX_OAUTH_CLIENTS = 50;
const MAX_OAUTH_CLIENTS_PER_IDENTITY = 5;
const OAUTH_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_CODES_PER_CLIENT = 10;
const MAX_OAUTH_CODES = 200;
const MAX_AUTH_FAILURE_IDENTITIES = 200;
const AUTHORIZATION_FIELDS = new Set(["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource", "state"]);

export interface OAuthControllerEnv {
  ACCOUNT_ADMIN_SECRET: string;
  DAEMON_SHARED_SECRET: string;
  OAUTH_TOKEN_VERSION: string;
}

export interface AuthorizedToken {
  tokenKey: string;
  accountId: string;
  accountVersion: number;
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
      throw new HttpError(503, "oauth_state_schema_mismatch", "OAuth state requires the one-time multi-account upgrade");
    }
    const store = isCurrentOAuthStore(raw) ? raw : emptyOAuthStore();
    let changed = false;
    const now = Math.floor(Date.now() / 1000);

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
    if (!(await accountAdminAuthorized(request, this.env.ACCOUNT_ADMIN_SECRET ?? ""))) return json({ error: "unauthorized" }, 401);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      return handleAccountAdminOperation({
        request, operation, store, now: Math.floor(Date.now() / 1000),
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
        return this.authorizePage(request, base, validation.error, body, validation.status, undefined, false);
      }
      return this.authorizePage(request, base, "", body, 200, validation.value, true);
    });
  }

  private authorizePage(
    request: Request,
    base: string,
    error = "",
    submitted?: Record<string, unknown>,
    status = 200,
    authorization?: ValidatedAuthorization,
    allowSubmit = true,
  ): Response {
    const url = new URL(request.url);
    const sourceEntries = submitted ? Object.entries(submitted) : searchParamsEntries(url.searchParams);
    const hidden = sourceEntries
      .filter(([key]) => AUTHORIZATION_FIELDS.has(key))
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
      .join("\n");
    const resource = normalizeDisplayText(
      authorization?.requestedResource ?? String(submitted?.resource ?? url.searchParams.get("resource") ?? `${base}/mcp`),
      1024,
      `${base}/mcp`,
    );
    const clientBlock = authorization
      ? `<p><strong>Client:</strong> ${escapeHtml(authorization.client.client_name)}</p>
    <p><strong>Redirect URI:</strong> <code>${escapeHtml(authorization.redirectUri)}</code></p>`
      : "";
    const errorBlock = error ? `<p role="alert" aria-live="assertive" style="color:#b91c1c; font-weight:600">${escapeHtml(error)}</p>` : "";
    const accountName = normalizeDisplayText(String(submitted?.account_name ?? ""), 64, "");
    const form = allowSubmit
      ? `<form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Account name<br><input name="account_name" value="${escapeHtml(accountName)}" autocomplete="username" autofocus required style="width: 100%; box-sizing: border-box; padding: 8px;"></label>
      <p><label>Account password<br><input name="account_password" type="password" autocomplete="current-password" required style="width: 100%; box-sizing: border-box; padding: 8px;"></label></p>
      <p><button type="submit">Authorize</button></p>
    </form>`
      : "<p>Authorization cannot continue. Return to the MCP client and start the connection again.</p>";
    const redirectOrigin = authorization ? new URL(authorization.redirectUri).origin : "";
    return html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${this.serverName}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorize ${this.serverName}</h1>
    <p>Only continue if you initiated this MCP connection and recognize the client and redirect URI below.</p>
    ${clientBlock}
    <p><strong>Resource:</strong> <code>${escapeHtml(resource)}</code></p>
    ${errorBlock}
    ${form}
  </body>
</html>`, status, redirectOrigin);
  }

  async authorizeSubmit(request: Request, base: string): Promise<Response> {
    const body = await parseRequestBody(request, OAUTH_BODY_LIMIT_BYTES);
    return this.withOAuthLock(async () => {
      const store = await this.oauthStore();
      const validation = validateAuthorizationRequest(body, base, this.serverName, store);
      if ("error" in validation) {
        return this.authorizePage(request, base, validation.error, body, validation.status, undefined, false);
      }
      const { client, clientId, redirectUri, codeChallenge, requestedResource, scope, state } = validation.value;
      const now = Math.floor(Date.now() / 1000);
      const identity = await authorizationIdentity(request, this.identityKey());
      const failure = store.auth_failures[identity];
      if (failure?.blocked_until > now) {
        return this.authorizePage(request, base, "Too many failed attempts. Try again later.", body, 429, validation.value);
      }

      const account = accountByName(store, body.account_name);
      const credentialsValid = Boolean(account?.active && await verifyAccountPassword(account, body.account_password));
      if (!account || !credentialsValid) {
        recordAuthorizationFailure(store, identity, now);
        pruneAuthFailures(store, MAX_AUTH_FAILURE_IDENTITIES);
        await this.ctx.storage.put("oauth", store);
        const status = store.auth_failures[identity]?.blocked_until > now ? 429 : 401;
        return this.authorizePage(request, base, "Invalid account credentials.", body, status, validation.value);
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
        accountVersion: account.version, role: account.role,
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
    const key = this.env.OAUTH_TOKEN_VERSION || this.env.DAEMON_SHARED_SECRET || this.env.ACCOUNT_ADMIN_SECRET;
    if (!key) throw new HttpError(503, "server_not_configured", "OAuth identity key is not configured");
    return key;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
