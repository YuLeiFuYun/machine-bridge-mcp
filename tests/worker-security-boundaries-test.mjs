import { accountAdminAuthorized, handleAccountAdminOperation } from "../src/worker/account-admin.ts";
import { discardRequestBody, readBoundedText } from "../src/worker/http.ts";
import { handleOAuthClientAdminOperation } from "../src/worker/oauth-client-admin.ts";
import { OAUTH_CLIENT_REGISTRATION_REVISION } from "../src/worker/oauth-client-contract.ts";
import { exchangeOAuthToken } from "../src/worker/oauth-tokens.ts";
import {
  acknowledgeAuthorityRevocation, authorityRevocationWireMessage, authorityRevocations, putWithAuthorityRevocation,
} from "../src/worker/authority-revocations.ts";
import { recordMatchesAuthorityRevocation } from "../src/shared/authority-revocation.mjs";
import { deriveRefreshReplacementPair } from "../src/worker/oauth-token-derivation.ts";
import {
  loadOAuthRefreshStore,
  recordConsumedRefreshToken,
  revokeOAuthRefreshFamily,
} from "../src/worker/oauth-refresh-families.ts";
import { oauthRefreshPersistenceEntries, saveOAuthRefreshStore } from "../src/worker/oauth-refresh-persistence.ts";
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
  assert(await authorized.request.text() === body, "admin authorization did not preserve the exact bounded request body for the operation parser");
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

  const oversizedBody = "x".repeat(128 * 1024);
  const oversizedHeaders = accountAdminRequestHeaders({
    sessionIdentity: ADMIN_SESSION, origin: BASE, method: "POST", pathname: "/admin/accounts", body: oversizedBody,
    now: NOW * 1000, nonce: "o".repeat(32),
  });
  const oversizedStream = streamedText(oversizedBody, 32 * 1024);
  const oversizedRequest = new Request(`${BASE}/admin/accounts`, {
    method: "POST", headers: oversizedHeaders, body: oversizedStream.stream, duplex: "half",
  });
  let oversizedError;
  try { await accountAdminAuthorized(oversizedRequest, publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, VERSION, NOW); }
  catch (error) { oversizedError = error; }
  assert(oversizedError?.status === 413 && oversizedError?.code === "request_body_too_large",
    "signed oversized admin body was not rejected by the streaming byte bound");
  assert(oversizedStream.cancelled === true && oversizedStream.pulls <= 3,
    "signed oversized admin body continued reading after the 64 KiB authorization bound");

  const declaredBody = "{}";
  const declaredHeaders = accountAdminRequestHeaders({
    sessionIdentity: ADMIN_SESSION, origin: BASE, method: "POST", pathname: "/admin/accounts", body: declaredBody,
    now: NOW * 1000, nonce: "d".repeat(32),
  });
  declaredHeaders["content-length"] = String(128 * 1024);
  const declaredStream = streamedText(declaredBody, declaredBody.length);
  const declaredRequest = new Request(`${BASE}/admin/accounts`, {
    method: "POST", headers: declaredHeaders, body: declaredStream.stream, duplex: "half",
  });
  let declaredError;
  try { await accountAdminAuthorized(declaredRequest, publicDeviceJwkJson(ADMIN_ROOT), BASE, SERVER, VERSION, NOW); }
  catch (error) { declaredError = error; }
  assert(declaredError?.status === 413 && declaredError?.code === "request_body_too_large",
    "declared oversized signed admin body was not rejected before reading");
  assert(declaredStream.cancelled === true && declaredStream.pulls === 0,
    "declared oversized signed admin body consumed attacker-controlled bytes before cancellation");
}

async function testAccountOperations() {
  const store = emptyOAuthStore();
  let saves = 0;
  const revocations = [];
  const save = async (revocation) => { saves += 1; if (revocation) revocations.push(revocation); };
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
  assert(revocations.length === 3
    && revocations[0]?.accountId === editor.account_id && revocations[0]?.accountVersion === 1
    && revocations[1]?.accountId === editor.account_id && revocations[1]?.accountVersion === 2
    && revocations[2]?.accountId === editor.account_id && revocations[2]?.accountVersion === 3,
  "account mutations did not revoke the exact previous account versions in commit order");
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
  const revocations = [];
  let saves = 0;
  const save = async (revocation) => { saves += 1; revocations.push(revocation); };
  const listed = await handleOAuthClientAdminOperation({ request: request("GET", "/admin/clients"), store, refreshStore, save, now: NOW });
  const listedBody = await listed.json();
  const clients = listedBody.clients;
  assert(clients.length === 1 && clients[0].active_access_tokens === 1 && clients[0].active_refresh_tokens === 1, "trusted client inventory lost token counts");
  assert(clients[0].registration_revision === null && clients[0].registration_current === false,
    "legacy client inventory did not surface its stale registration contract");
  store.clients[CLIENT_ID].registration_revision = OAUTH_CLIENT_REGISTRATION_REVISION;
  const relisted = await handleOAuthClientAdminOperation({ request: request("GET", "/admin/clients"), store, refreshStore, save, now: NOW });
  const currentClient = (await relisted.json()).clients[0];
  assert(currentClient.registration_revision === OAUTH_CLIENT_REGISTRATION_REVISION && currentClient.registration_current === true,
    "current client inventory did not surface its registration contract revision");
  assert(listedBody.maximum === 50, "client admin reported a capacity different from the DCR registration ceiling");
  const invalid = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: "invalid" }), store, refreshStore, save, now: NOW });
  assert(invalid.status === 400, "invalid OAuth client id was accepted for revocation");
  const method = await handleOAuthClientAdminOperation({ request: request("POST", "/admin/clients", {}), store, refreshStore, save, now: NOW });
  assert(method.status === 405 && method.headers.get("allow") === "GET, DELETE", "client admin accepted an unsupported method");
  const unknown = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: `mcp_client_${"z".repeat(43)}` }), store, refreshStore, save, now: NOW });
  assert(unknown.status === 404, "unknown OAuth client revocation did not return not_found");
  const removed = await handleOAuthClientAdminOperation({ request: request("DELETE", "/admin/clients", { client_id: CLIENT_ID }), store, refreshStore, save, now: NOW });
  assert(removed.status === 200 && !store.clients[CLIENT_ID], "trusted OAuth client was not removed");
  assert(Object.keys(store.tokens).length === 0 && Object.keys(refreshStore.tokens).length === 0, "client revocation retained access or refresh tokens");
  assert(saves === 1 && revocations[0]?.accountId === account.account_id
    && revocations[0]?.accountVersion === account.version && revocations[0]?.clientId === CLIENT_ID,
  "client revocation was not persisted with the bound account/client authority revocation");
}

async function testRefreshReplacementDerivation() {
  const seed = `mcp_rt_${"s".repeat(43)}`;
  const first = await deriveRefreshReplacementPair("deployment-secret", seed);
  const repeated = await deriveRefreshReplacementPair("deployment-secret", seed);
  const different = await deriveRefreshReplacementPair("deployment-secret", `mcp_rt_${"t".repeat(43)}`);
  assert(first.accessToken === repeated.accessToken && first.refreshToken === repeated.refreshToken,
    "refresh replacement derivation was not idempotent");
  assert(first.accessToken !== different.accessToken && first.refreshToken !== different.refreshToken,
    "refresh replacement derivation did not bind the consumed token");
  await expectReject(() => deriveRefreshReplacementPair("", seed), "derivation key");
  await expectReject(() => deriveRefreshReplacementPair("deployment-secret", "invalid"), "seed is invalid");
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
  const familyRevocations = [];
  const options = {
    storage, tokenVersion: "token-version", serverName: SERVER,
    loadOAuthStore: async () => store,
    withLock: async (callback) => callback(),
    saveStores: async (oauthStore, refreshStore, revocation) => {
      familyRevocations.push(revocation);
      await putWithAuthorityRevocation(storage, { oauth: oauthStore, ...oauthRefreshPersistenceEntries(refreshStore) }, revocation);
    },
  };
  for (const [override, expectedName] of [
    [{ loadOAuthStore: async () => { throw new Error("simulated load failure"); } }, "oauth_token_stage_load_oauth"],
    [{ withLock: async () => { throw new Error("simulated lock failure"); } }, "oauth_token_stage_lock"],
  ]) {
    let stagedError;
    try {
      await exchangeOAuthToken(formTokenRequest({
        grant_type: "authorization_code", code, client_id: CLIENT_ID, redirect_uri: REDIRECT,
        code_verifier: verifier, resource: `${BASE}/mcp`,
      }), BASE, { ...options, ...override });
    } catch (error) { stagedError = error; }
    assert(stagedError?.name === expectedName, `authorization-code diagnostics lost ${expectedName}`);
  }
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
  const dpopRefreshProof = await createDpopProof({
    ...dpopKeys, method: "POST", url: `${BASE}/oauth/token`, issuedAt: dpopIssuedAt,
    jti: "valid-refresh-proof-1234567",
  });
  const dpopRefresh = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: dpopPair.refresh_token, client_id: CLIENT_ID,
    resource: `${BASE}/mcp`, scope: `${SERVER} offline_access`,
  }, { DPoP: dpopRefreshProof }), BASE, options);
  assert(dpopRefresh.status === 200, "DPoP-bound refresh rotation failed");
  const replayedDpopProof = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: dpopPair.refresh_token, client_id: CLIENT_ID,
    resource: `${BASE}/mcp`, scope: `${SERVER} offline_access`,
  }, { DPoP: dpopRefreshProof }), BASE, options);
  assert(replayedDpopProof.status === 400 && (await replayedDpopProof.json()).error === "invalid_dpop_proof",
    "replayed DPoP proof consumed a concurrent refresh retry");

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

  const malformedRefresh = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: "not-a-refresh-token", client_id: CLIENT_ID,
  }), BASE, options);
  assert(malformedRefresh.status === 400 && (await malformedRefresh.json()).error === "invalid_grant",
    "malformed refresh token did not use the bounded invalid-grant path");
  for (const [overrides, expected] of [
    [{ client_id: `mcp_client_${"x".repeat(43)}` }, "invalid_grant"],
    [{ resource: "https://other.example.test/mcp" }, "invalid_target"],
    [{ scope: `${SERVER} unknown_scope` }, "invalid_scope"],
  ]) {
    const rejected = await exchangeOAuthToken(formTokenRequest({
      grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: CLIENT_ID,
      resource: `${BASE}/mcp`, scope: `${SERVER} offline_access`, ...overrides,
    }), BASE, options);
    assert(rejected.status === 400 && (await rejected.json()).error === expected,
      `refresh grant validation did not reject ${expected}`);
  }

  const retryOne = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  const retryOnePair = await retryOne.json();
  assert(retryOne.status === 200
    && retryOnePair.refresh_token === second.refresh_token
    && retryOnePair.access_token === second.access_token,
  "first concurrent refresh retry did not reproduce the original replacement pair");
  const retryTwo = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  const retryTwoPair = await retryTwo.json();
  assert(retryTwo.status === 200
    && retryTwoPair.refresh_token === second.refresh_token
    && retryTwoPair.access_token === second.access_token,
  "second bounded concurrent refresh retry created a divergent credential branch");
  const retryOverflow = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(retryOverflow.status === 429 && (await retryOverflow.json()).error === "temporarily_unavailable", "refresh retry budget was not bounded");

  const refreshKey = `sha256:${await sha256Hex(first.refresh_token)}`;
  const persistedRefresh = await loadOAuthRefreshStore(store, storage);
  persistedRefresh.consumed[refreshKey].consumed_at = Math.floor(Date.now() / 1000) - 60;
  persistedRefresh.consumed[refreshKey].retry_until = Math.floor(Date.now() / 1000) - 30;
  await saveOAuthRefreshStore(storage, persistedRefresh);
  const replay = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(replay.status === 400 && (await replay.json()).error === "invalid_grant", "post-grace refresh-token replay was not rejected");
  const familyId = persistedRefresh.consumed[refreshKey].family_id;
  assert(familyRevocations.at(-1)?.accountId === account.account_id
    && familyRevocations.at(-1)?.accountVersion === account.version
    && familyRevocations.at(-1)?.clientId === CLIENT_ID
    && familyRevocations.at(-1)?.familyId === familyId,
  "post-grace refresh replay did not persist the bound authority-family revocation");
  assert(!Object.values(store.tokens).some((token) => token.family_id === familyId), "post-grace replay did not revoke the complete access-token family");
  const finalRefreshStore = await loadOAuthRefreshStore(store, storage);
  assert(!Object.values(finalRefreshStore.tokens).some((token) => token.family_id === familyId), "post-grace replay retained refresh tokens");

  const narrowCode = `mcp_code_${"n".repeat(43)}`;
  store.codes[narrowCode] = {
    client_id: CLIENT_ID, account_id: account.account_id, account_version: account.version, role: account.role,
    redirect_uri: REDIRECT, code_challenge: await pkceS256(verifier), scope: `${SERVER} offline_access`, resource: `${BASE}/mcp`, expires_at: NOW + 300,
  };
  const narrowInitial = await exchangeOAuthToken(formTokenRequest({
    grant_type: "authorization_code", code: narrowCode, client_id: CLIENT_ID,
    redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
  }), BASE, options);
  const narrowInitialPair = await narrowInitial.json();
  assert(narrowInitial.status === 200, "narrow-scope refresh fixture authorization-code exchange failed");
  const narrowed = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: narrowInitialPair.refresh_token, client_id: CLIENT_ID,
    resource: `${BASE}/mcp`, scope: SERVER,
  }), BASE, options);
  const narrowedPair = await narrowed.json();
  assert(narrowed.status === 200 && narrowedPair.scope === SERVER, "refresh-token access scope could not be narrowed to an originally granted subset");
  const narrowedAccessKey = `sha256:${await sha256Hex(narrowedPair.access_token)}`;
  assert(store.tokens[narrowedAccessKey]?.scope === SERVER, "narrowed refresh response did not persist the access token's reduced scope");
  const narrowedRefreshKey = `sha256:${await sha256Hex(narrowedPair.refresh_token)}`;
  const afterNarrow = await loadOAuthRefreshStore(store, storage);
  assert(afterNarrow.tokens[narrowedRefreshKey]?.scope === `${SERVER} offline_access`, "replacement refresh token inherited the narrowed access scope instead of the original grant");
  const consumedNarrowKey = `sha256:${await sha256Hex(narrowInitialPair.refresh_token)}`;
  assert(afterNarrow.consumed[consumedNarrowKey]?.access_scope === SERVER, "consumed refresh marker did not retain the access scope needed for idempotent retry");
  const narrowedRetry = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: narrowInitialPair.refresh_token, client_id: CLIENT_ID,
    resource: `${BASE}/mcp`, scope: SERVER,
  }), BASE, options);
  const narrowedRetryPair = await narrowedRetry.json();
  assert(narrowedRetry.status === 200
    && narrowedRetryPair.access_token === narrowedPair.access_token
    && narrowedRetryPair.refresh_token === narrowedPair.refresh_token
    && narrowedRetryPair.scope === SERVER,
  "same-scope concurrent retry did not reproduce the narrowed token pair");
  const widenedRetry = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: narrowInitialPair.refresh_token, client_id: CLIENT_ID,
    resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(widenedRetry.status === 400 && (await widenedRetry.json()).error === "invalid_scope",
    "changed-scope retry of a consumed refresh token was allowed to reinterpret a deterministic access token");
  assert(store.tokens[narrowedAccessKey]?.scope === SERVER, "changed-scope retry widened the already issued deterministic access token");

  const corruptCode = `mcp_code_${"q".repeat(43)}`;
  store.codes[corruptCode] = {
    client_id: CLIENT_ID, account_id: account.account_id, account_version: account.version, role: account.role,
    redirect_uri: REDIRECT, code_challenge: await pkceS256(verifier), scope: "offline_access", resource: `${BASE}/mcp`, expires_at: NOW + 300,
  };
  const corruptCodeExchange = await exchangeOAuthToken(formTokenRequest({
    grant_type: "authorization_code", code: corruptCode, client_id: CLIENT_ID,
    redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(corruptCodeExchange.status === 400 && (await corruptCodeExchange.json()).error === "invalid_grant",
    "persisted authorization code without the MCP resource scope minted credentials");

  const corruptRefreshStore = await storage.get("oauth-refresh");
  corruptRefreshStore.tokens[narrowedRefreshKey].scope = "offline_access";
  await storage.put("oauth-refresh", corruptRefreshStore);
  const corruptRefresh = await exchangeOAuthToken(formTokenRequest({
    grant_type: "refresh_token", refresh_token: narrowedPair.refresh_token, client_id: CLIENT_ID, resource: `${BASE}/mcp`,
  }), BASE, options);
  assert(corruptRefresh.status === 400 && (await corruptRefresh.json()).error === "invalid_grant",
    "persisted refresh token without the MCP resource scope remained rotatable");

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
  recordConsumedRefreshToken(oauthStore, loaded, `sha256:${"1".repeat(64)}`, loaded.tokens[activeHash], NOW + 1200, NOW);
  revokeOAuthRefreshFamily(oauthStore, loaded, family, NOW + 1200);
  assert(!loaded.tokens[activeHash] && !oauthStore.tokens[accessHash] && loaded.revoked_families[family], "refresh family revocation was incomplete");
}


async function testRequestBodyStreamingBoundaries() {
  const discardedBody = countedBody(8);
  const discarded = await discardRequestBody({
    headers: new Headers(), body: discardedBody.stream,
  }, 16);
  assert(discarded.exceeded === true && discarded.bytes_read === 17,
    "discarded request body did not stop at the bounded overflow marker");
  assert(discardedBody.cancelled === true && discardedBody.pulls <= 3,
    "discarded oversized request continued consuming attacker-controlled body data");

  const exact = await readBoundedText(new Request(`${BASE}/mcp`, { method: "POST", body: "exact" }), 5);
  assert(exact === "exact", "bounded body reader changed an exact-limit payload");

  const oversizedBody = countedBody(3);
  let oversized;
  try {
    await readBoundedText({ headers: new Headers(), body: oversizedBody.stream }, 4);
  } catch (error) { oversized = error; }
  assert(oversized?.status === 413 && oversized?.code === "request_body_too_large",
    "bounded body reader did not reject an oversized stream");
  assert(oversizedBody.cancelled === true && oversizedBody.pulls <= 2,
    "bounded body reader drained data after the size limit was known");

  let declaredCancelled = false;
  const declared = await discardRequestBody({
    headers: new Headers({ "content-length": "1000" }),
    body: new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("small")); },
      cancel() { declaredCancelled = true; },
    }, { highWaterMark: 0 }),
  }, 8);
  assert(declared.exceeded === true && declared.bytes_read === 0 && declaredCancelled,
    "declared oversized body was read instead of being cancelled immediately");
}

function streamedText(text, chunkBytes) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (offset >= bytes.byteLength) { controller.close(); return; }
      const end = Math.min(bytes.byteLength, offset + chunkBytes);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
      if (offset >= bytes.byteLength) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, get pulls() { return pulls; }, get cancelled() { return cancelled; } };
}

function countedBody(chunkBytes) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
      if (pulls >= 16) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    stream,
    get pulls() { return pulls; },
    get cancelled() { return cancelled; },
  };
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

async function testAuthorityWritesAvoidBulkPut() {
  const storage = new MemoryStorage();
  const ordinaryPut = storage.put.bind(storage);
  let bulkPutCalled = false;
  storage.put = async (key, value) => {
    if (key && typeof key === "object") {
      bulkPutCalled = true;
      throw new Error("synthetic bulk put rejection");
    }
    return ordinaryPut(key, value);
  };
  await putWithAuthorityRevocation(storage, {
    oauth: { marker: "oauth" },
    "oauth-refresh": { marker: "refresh" },
  });
  assert(bulkPutCalled === false, "authority persistence returned to the deployment-incompatible bulk put path");
  assert(storage.values.get("oauth")?.marker === "oauth" && storage.values.get("oauth-refresh")?.marker === "refresh",
    "authority persistence transaction did not commit every protected state entry");
  await expectReject(() => putWithAuthorityRevocation(storage, {
    "authority-revocations": { schema_version: 1, records: [] },
  }), "protected writes cannot replace the authority revocation queue");
  assert(!storage.values.has("authority-revocations"), "reserved authority queue key was writable through protected-state entries");
}

async function testAuthorityRevocationQueue() {
  const storage = new MemoryStorage();
  const accountId = `acct_${"q".repeat(32)}`;
  const clientId = `mcp_client_${"q".repeat(43)}`;
  const familyId = `mcp_family_${"q".repeat(43)}`;
  const family = { accountId, accountVersion: 7, clientId, familyId };
  await putWithAuthorityRevocation(storage, { oauth: { marker: 1 } }, family, NOW);
  let queued = await authorityRevocations(storage);
  assert(queued.length === 1 && storage.values.get("oauth")?.marker === 1,
    "authority revocation was not committed with its protected state mutation");
  const wire = authorityRevocationWireMessage(queued[0]);
  assert(wire.type === "authority_revoke" && wire.family_id === familyId
    && recordMatchesAuthorityRevocation({
      owner_kind: "account", owner_account_id: accountId, owner_account_version: 7,
      owner_client_id: clientId, owner_family_id: familyId,
    }, family), "authority revocation wire/matcher lost the exact principal binding");
  await putWithAuthorityRevocation(storage, { oauth: { marker: 2 } }, { accountId, accountVersion: 7 }, NOW + 1);
  queued = await authorityRevocations(storage);
  assert(queued.length === 1 && !queued[0].client_id,
    "account-wide authority revocation did not subsume narrower client/family entries");
  assert(await acknowledgeAuthorityRevocation(storage, queued[0].id), "authority revocation acknowledgement did not remove the durable obligation");
  assert((await authorityRevocations(storage)).length === 0, "acknowledged authority revocation remained queued");
  assert(!await acknowledgeAuthorityRevocation(storage, "invalid"), "invalid authority revocation acknowledgement was accepted");
}

async function testAuthorityRevocationCapacityBudget() {
  const records = [];
  for (let index = 0; index < 1_024; index += 1) {
    const suffix = index.toString(36).padStart(6, "0");
    records.push({
      id: `revoke_${"r".repeat(37)}${suffix}`,
      account_id: `acct_${"a".repeat(90)}${suffix}`,
      account_version: Number.MAX_SAFE_INTEGER,
      client_id: `mcp_client_${"c".repeat(37)}${suffix}`,
      family_id: `mcp_family_${"f".repeat(37)}${suffix}`,
      queued_at: Number.MAX_SAFE_INTEGER,
    });
  }
  const queue = { schema_version: 1, records };
  const encodedBytes = new TextEncoder().encode(JSON.stringify(queue)).byteLength;
  assert(encodedBytes < 512_000,
    "maximum authority revocation queue no longer retains a conservative single-value size budget");
  const storage = new MemoryStorage({ "authority-revocations": queue });
  assert((await authorityRevocations(storage)).length === 1_024,
    "maximum bounded authority revocation queue was rejected");
  await storage.put("authority-revocations", { ...queue, future_payload: "x" });
  await expectReject(() => authorityRevocations(storage), "authority revocation state is invalid");
  await storage.put("authority-revocations", { schema_version: 1, records: [{ ...records[0], future_payload: "x" }] });
  await expectReject(() => authorityRevocations(storage), "authority revocation state is invalid");
  await storage.put("authority-revocations", { schema_version: 1, records: [...records, records[0]] });
  await expectReject(() => authorityRevocations(storage), "authority revocation state is invalid");
}

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(structuredClone(initial))); }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.flatMap((name) => this.values.has(name) ? [[name, structuredClone(this.values.get(name))]] : []));
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (key && typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
    } else this.values.set(key, structuredClone(value));
  }
  async delete(key) { return this.values.delete(key); }
  async transaction(callback) {
    const transaction = new MemoryStorage();
    transaction.values = new Map([...this.values].map(([key, value]) => [key, structuredClone(value)]));
    const result = await callback(transaction);
    this.values = transaction.values;
    return result;
  }
}

await testAdminAuthentication();
await testAccountOperations();
await testClientOperations();
await testAuthorityWritesAvoidBulkPut();
await testAuthorityRevocationQueue();
await testAuthorityRevocationCapacityBudget();
await testRefreshReplacementDerivation();
await testTokenRotationAndReplay();
await testRefreshStateLifecycle();
await testRequestBodyStreamingBoundaries();
console.log("Worker security boundary state-machine test ok");

async function expectReject(callback, expected) {
  let rejection;
  try { await callback(); } catch (error) { rejection = error; }
  assert(rejection && String(rejection.message || rejection).includes(expected),
    `expected rejection containing ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
