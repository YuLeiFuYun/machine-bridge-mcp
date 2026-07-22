import { accountAdminAuthorized, handleAccountAdminOperation } from "../src/worker/account-admin.ts";
import { discardRequestBody, readBoundedText } from "../src/worker/http.ts";
import { handleOAuthClientAdminOperation } from "../src/worker/oauth-client-admin.ts";
import { exchangeOAuthToken } from "../src/worker/oauth-tokens.ts";
import {
  loadOAuthRefreshStore,
  recordConsumedRefreshToken,
  revokeOAuthRefreshFamily,
} from "../src/worker/oauth-refresh-families.ts";
import {
  createAccount,
  emptyOAuthRefreshStore,
  emptyOAuthStore,
  pkceS256,
  sha256Hex,
} from "../src/worker/oauth-state.ts";
import { accountAdminRequestHeaders, generateAccountPassword } from "../src/local/account-admin.mjs";
import { createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { createDpopFixture, createDpopProof } from "./test-dpop-proof.mjs";

const BASE = "https://bridge.example.test";
const SERVER = "machine-bridge-mcp";
const NOW = 1_800_000_000;
const CLIENT_ID = `mcp_client_${"c".repeat(43)}`;
const REDIRECT = "https://client.example.test/callback";
const VERSION = "3.0.0-beta.1";
const ADMIN_ROOT = createDeviceIdentity();
const ADMIN_SESSION = createDeviceSessionIdentity(ADMIN_ROOT, BASE, SERVER, VERSION, NOW * 1000);

async function testAdminAuthentication() {
  const body = JSON.stringify({ account_id: `acct_${"a".repeat(32)}` });
  const headers = accountAdminRequestHeaders({
    sessionIdentity: ADMIN_SESSION,
    origin: BASE,
    method: "DELETE",
    pathname: "/admin/accounts",
    body,
    now: NOW * 1000,
    nonce: "n".repeat(32),
  });
  const request = new Request(`${BASE}/admin/accounts`, { method: "DELETE", headers, body });
  const authorized = await accountAdminAuthorized(request, publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, VERSION, NOW);
  assert(authorized?.nonce === "n".repeat(32), "valid device-signed admin request was rejected");
  const otherRoot = createDeviceIdentity();
  assert(await accountAdminAuthorized(request, publicDeviceJwkJson(otherRoot), BASE, SERVER, VERSION, NOW) === null, "admin request was accepted under another device root");
  const staleHeaders = accountAdminRequestHeaders({
    sessionIdentity: ADMIN_SESSION, origin: BASE, method: "GET", pathname: "/admin/accounts", now: (NOW - 301) * 1000, nonce: "s".repeat(32),
  });
  assert(await accountAdminAuthorized(new Request(`${BASE}/admin/accounts`, { headers: staleHeaders }), publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, VERSION, NOW) === null, "stale admin signature was accepted");
  const changedBody = new Request(`${BASE}/admin/accounts`, { method: "DELETE", headers, body: JSON.stringify({ changed: true }) });
  assert(await accountAdminAuthorized(changedBody, publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, VERSION, NOW) === null, "admin signature was accepted for a changed body");
  const wrongVersion = await accountAdminAuthorized(request, publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, "3.0.1", NOW);
  assert(wrongVersion === null, "admin session certificate was reusable for another Worker version");
}

async function testAccountOperations() {
  const store = emptyOAuthStore();
  let saves = 0;
  const save = async () => { saves += 1; };
  const emptyList = await handleAccountAdminOperation({ request: request("GET", "/admin/accounts"), operation: "accounts", store, save, now: NOW });
  assert(emptyList.status === 200 && (await emptyList.json()).accounts.length === 0, "empty account list failed");

  const firstNonOwner = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts", { name: "reviewer.one", role: "reviewer", password: generateAccountPassword() }),
    operation: "accounts", store, save, now: NOW,
  });
  assert(firstNonOwner.status === 409, "first account was allowed to be non-owner");

  const ownerPassword = generateAccountPassword();
  const ownerResponse = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts", { name: "owner.one", role: "owner", password: ownerPassword }),
    operation: "accounts", store, save, now: NOW,
  });
  assert(ownerResponse.status === 201, "owner account creation failed");
  const owner = (await ownerResponse.json()).account;
  const duplicate = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts", { name: "owner.one", role: "owner", password: generateAccountPassword() }),
    operation: "accounts", store, save, now: NOW,
  });
  assert(duplicate.status === 409, "duplicate account name was accepted");

  const editorResponse = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts", { name: "editor.one", role: "editor", password: generateAccountPassword() }),
    operation: "accounts", store, save, now: NOW,
  });
  const editor = (await editorResponse.json()).account;
  const removeLastOwner = await handleAccountAdminOperation({
    request: request("PATCH", "/admin/accounts", { account_id: owner.account_id, active: false }),
    operation: "accounts", store, save, now: NOW + 1,
  });
  assert(removeLastOwner.status === 409, "last active owner could be disabled");

  const update = await handleAccountAdminOperation({
    request: request("PATCH", "/admin/accounts", { account_id: editor.account_id, role: "operator", display_name: "Build Operator" }),
    operation: "accounts", store, save, now: NOW + 2,
  });
  assert(update.status === 200 && (await update.json()).account.role === "operator", "account role update failed");

  const badRotation = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts/rotate-password", { account_id: editor.account_id, password: "human-password" }),
    operation: "rotate-password", store, save, now: NOW + 3,
  });
  assert(badRotation.status === 400, "invalid generated-token password was accepted");
  const rotation = await handleAccountAdminOperation({
    request: request("POST", "/admin/accounts/rotate-password", { account_id: editor.account_id, password: generateAccountPassword() }),
    operation: "rotate-password", store, save, now: NOW + 4,
  });
  assert(rotation.status === 200, "valid account password rotation failed");

  const removed = await handleAccountAdminOperation({
    request: request("DELETE", "/admin/accounts", { account_id: editor.account_id }),
    operation: "accounts", store, save, now: NOW + 5,
  });
  assert(removed.status === 204 && !store.accounts[editor.account_id], "account removal failed");
  const unknown = await handleAccountAdminOperation({
    request: request("DELETE", "/admin/accounts", { account_id: editor.account_id }),
    operation: "accounts", store, save, now: NOW + 6,
  });
  assert(unknown.status === 404, "unknown account removal did not return not_found");
  assert(saves >= 4, "account mutations were not persisted");
}

async function testClientOperations() {
  const store = emptyOAuthStore();
  const refreshStore = emptyOAuthRefreshStore();
  const account = await createAccount({ name: "owner.client", role: "owner", password: generateAccountPassword(), now: NOW });
  store.accounts[account.account_id] = account;
  store.clients[CLIENT_ID] = {
    client_id: CLIENT_ID, client_name: "Trusted Client", redirect_uris: [REDIRECT], created_at: NOW, last_used_at: NOW,
    has_been_authorized: true, trusted_account_id: account.account_id, trusted_account_version: account.version, trusted_role: account.role, trusted_at: NOW,
  };
  store.tokens[`sha256:${"a".repeat(64)}`] = tokenRecord(account, NOW + 300);
  refreshStore.tokens[`sha256:${"b".repeat(64)}`] = { ...tokenRecord(account, NOW + 600), issued_at: NOW, family_expires_at: NOW + 1200 };
  const storage = new MemoryStorage();
  const listed = await handleOAuthClientAdminOperation({ request: request("GET", "/admin/clients"), store, refreshStore, storage, now: NOW });
  const clients = (await listed.json()).clients;
  assert(clients.length === 1 && clients[0].active_access_tokens === 1 && clients[0].active_refresh_tokens === 1, "trusted client inventory lost token counts");
  const invalid = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: "invalid" }), store, refreshStore, storage, now: NOW });
  assert(invalid.status === 400, "invalid OAuth client id was accepted for revocation");
  const method = await handleOAuthClientAdminOperation({ request: request("POST", "/admin/clients", {}), store, refreshStore, storage, now: NOW });
  assert(method.status === 405 && method.headers.get("allow") === "GET, DELETE", "client admin accepted an unsupported method");
  const unknown = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: `mcp_client_${"z".repeat(43)}` }), store, refreshStore, storage, now: NOW });
  assert(unknown.status === 404, "unknown OAuth client revocation did not return not_found");
  const removed = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: CLIENT_ID }), store, refreshStore, storage, now: NOW });
  assert(removed.status === 200 && !store.clients[CLIENT_ID], "trusted OAuth client was not removed");
  assert(Object.keys(store.tokens).length === 0 && Object.keys(refreshStore.tokens).length === 0, "client revocation retained access or refresh tokens");
}

async function testTokenRotationAndReplay() {
  const store = emptyOAuthStore();
  const storage = new MemoryStorage();
  const account = await createAccount({ name: "owner.token", role: "owner", password: generateAccountPassword(), now: NOW });
  store.accounts[account.account_id] = account;
  store.clients[CLIENT_ID] = {
    client_id: CLIENT_ID, client_name: "Token Client", redirect_uris: [REDIRECT], created_at: NOW, last_used_at: NOW,
    has_been_authorized: true, trusted_account_id: account.account_id, trusted_account_version: account.version, trusted_role: account.role, trusted_at: NOW,
  };
  const verifier = "v".repeat(43);
  const code = `mcp_code_${"k".repeat(43)}`;
  store.codes[code] = {
    client_id: CLIENT_ID, account_id: account.account_id, account_version: account.version, role: account.role,
    redirect_uri: REDIRECT, code_challenge: await pkceS256(verifier), scope: `${SERVER} offline_access`, resource: `${BASE}/mcp`, expires_at: NOW + 300,
  };
  const options = {
    storage, tokenVersion: "token-version", serverName: SERVER,
    loadOAuthStore: async () => store,
    withLock: async (callback) => callback(),
  };
  const dpopKeys = await createDpopFixture();
  const dpopIssuedAt = Math.floor(Date.now() / 1000);
  const invalidDpopProof = await createDpopProof({
    ...dpopKeys, method: "POST", url: `${BASE}/oauth/token`, issuedAt: dpopIssuedAt,
    jti: "invalid-grant-proof-123456",
  });
  const invalidDpopGrant = await exchangeOAuthToken(formTokenRequest({
    grant_type: "authorization_code", code: `mcp_code_${"x".repeat(43)}`, client_id: CLIENT_ID,
    redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
  }, { DPoP: invalidDpopProof }), BASE, options);
  assert(invalidDpopGrant.status === 400, "invalid DPoP grant was not rejected");
  assert(await storage.get("dpop-proof-jtis") === undefined, "invalid OAuth credentials consumed global DPoP replay capacity");

  const dpopCode = `mcp_code_${"d".repeat(43)}`;
  store.codes[dpopCode] = { ...store.codes[code] };
  const validDpopProof = await createDpopProof({
    ...dpopKeys, method: "POST", url: `${BASE}/oauth/token`, issuedAt: dpopIssuedAt,
    jti: "valid-grant-proof-12345678",
  });
  const dpopExchange = await exchangeOAuthToken(formTokenRequest({
    grant_type: "authorization_code", code: dpopCode, client_id: CLIENT_ID,
    redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
  }, { DPoP: validDpopProof }), BASE, options);
  const dpopPair = await dpopExchange.json();
  assert(dpopExchange.status === 200 && dpopPair.token_type === "DPoP", "valid DPoP authorization-code exchange failed");
  assert(await storage.get("dpop-proof-jtis"), "successful DPoP grant did not consume a replay marker");
  const exchange = await exchangeOAuthToken(formTokenRequest({
    grant_type: "authorization_code", code, client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(exchange.status === 200, "authorization code exchange failed");
  const first = await exchange.json();
  assert(first.expires_in === 900 && first.token_type === "Bearer" && first.refresh_token, "token pair response is incomplete");
  assert(!store.codes[code], "authorization code remained reusable");

  const refresh = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`, scope: `${SERVER} offline_access`,
  }), BASE, options);
  assert(refresh.status === 200, "refresh token rotation failed");
  const second = await refresh.json();
  assert(second.refresh_token !== first.refresh_token && second.access_token !== first.access_token, "refresh rotation reused token material");

  const replay = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(replay.status === 400 && (await replay.json()).error === "invalid_grant", "consumed refresh-token replay was not rejected");
  const firstAccessKey = `sha256:${await sha256Hex(first.access_token)}`;
  const secondAccessKey = `sha256:${await sha256Hex(second.access_token)}`;
  assert(!store.tokens[firstAccessKey] && !store.tokens[secondAccessKey], "refresh replay did not revoke the complete token family");

  const unsupported = await exchangeOAuthToken(formTokenRequest({ grant_type: "password" }), BASE, options);
  assert(unsupported.status === 400 && (await unsupported.json()).error === "unsupported_grant_type", "unsupported OAuth grant was accepted");
}

async function testRefreshStateLifecycle() {
  const account = await createAccount({ name: "owner.refresh", role: "owner", password: generateAccountPassword(), now: NOW });
  const oauthStore = emptyOAuthStore();
  oauthStore.accounts[account.account_id] = account;
  oauthStore.clients[CLIENT_ID] = {
    client_id: CLIENT_ID, client_name: "Refresh Client", redirect_uris: [REDIRECT], created_at: NOW, last_used_at: NOW,
    has_been_authorized: true, trusted_account_id: account.account_id, trusted_account_version: account.version, trusted_role: account.role, trusted_at: NOW,
  };
  const refreshStore = emptyOAuthRefreshStore();
  const family = `mcp_family_${"f".repeat(43)}`;
  const activeHash = `sha256:${"d".repeat(64)}`;
  refreshStore.tokens[activeHash] = { ...tokenRecord(account, NOW + 600), family_id: family, issued_at: NOW, family_expires_at: NOW + 1200 };
  const expiredHash = `sha256:${"e".repeat(64)}`;
  refreshStore.tokens[expiredHash] = { ...tokenRecord(account, 2), family_id: `mcp_family_${"g".repeat(43)}`, issued_at: 1, family_expires_at: 3 };
  const storage = new MemoryStorage({ "oauth-refresh": refreshStore });
  const loaded = await loadOAuthRefreshStore(oauthStore, storage);
  assert(loaded.tokens[activeHash] && !loaded.tokens[expiredHash], "refresh-state load did not prune expired records");

  const accessHash = `sha256:${"f".repeat(64)}`;
  oauthStore.tokens[accessHash] = { ...tokenRecord(account, NOW + 300), family_id: family };
  recordConsumedRefreshToken(oauthStore, loaded, `sha256:${"1".repeat(64)}`, family, NOW + 1200, NOW);
  revokeOAuthRefreshFamily(oauthStore, loaded, family, NOW + 1200);
  assert(!loaded.tokens[activeHash] && !oauthStore.tokens[accessHash] && loaded.revoked_families[family], "refresh family revocation was incomplete");
}


async function testRequestBodyStreamingBoundaries() {
  const discarded = await discardRequestBody(new Request(`${BASE}/mcp`, {
    method: "POST", body: new Blob(["A".repeat(48)]), headers: { "content-length": "48" },
  }), 16);
  assert(discarded.exceeded === true && discarded.bytes_read === 17, "discarded request body did not remain bounded after the limit");

  const exact = await readBoundedText(new Request(`${BASE}/mcp`, { method: "POST", body: "exact" }), 5);
  assert(exact === "exact", "bounded body reader changed an exact-limit payload");

  let oversized;
  try {
    await readBoundedText(new Request(`${BASE}/mcp`, { method: "POST", body: "oversized" }), 4);
  } catch (error) { oversized = error; }
  assert(oversized?.status === 413 && oversized?.code === "request_body_too_large", "bounded body reader did not reject an oversized stream after draining it");

  const declared = await discardRequestBody({
    headers: new Headers({ "content-length": "1000" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("small")); controller.close(); } }),
  }, 8);
  assert(declared.exceeded === true && declared.bytes_read === 5, "declared oversized body was not drained without retaining bytes");
}

function tokenRecord(account, expiresAt) {
  return {
    client_id: CLIENT_ID, account_id: account.account_id, account_version: account.version, role: account.role,
    scope: `${SERVER} offline_access`, resource: `${BASE}/mcp`, version: "token-version",
    family_id: `mcp_family_${"f".repeat(43)}`, expires_at: expiresAt,
  };
}

function request(method, pathname, body) {
  return new Request(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function formTokenRequest(body, headers = {}) {
  return new Request(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });
}

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(structuredClone(initial))); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (key && typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
    } else this.values.set(key, structuredClone(value));
  }
  async transaction(callback) { return callback(this); }
}

await testAdminAuthentication();
await testAccountOperations();
await testClientOperations();
await testTokenRotationAndReplay();
await testRefreshStateLifecycle();
await testRequestBodyStreamingBoundaries();
console.log("Worker security boundary state-machine test ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
