import { normalizeAccountRole } from "../src/worker/access.ts";
import { consumeAccountAdminNonce } from "../src/worker/account-admin.ts";
import { OAuthController } from "../src/worker/oauth-controller.ts";
import { authorizationPage } from "../src/worker/oauth-authorization-page.ts";
import { accountByName, createAccount, emptyOAuthRefreshStore, emptyOAuthStore, sha256Hex } from "../src/worker/oauth-state.ts";
import { loadOAuthRefreshStore, recordConsumedRefreshToken } from "../src/worker/oauth-refresh-families.ts";
import { oauthRefreshPersistenceEntries } from "../src/worker/oauth-refresh-persistence.ts";
import { isCurrentOAuthStore } from "../src/worker/oauth-store-validation.ts";
import { saveOAuthStores } from "../src/worker/oauth-token-issuance.ts";
import { OAUTH_CLIENT_REGISTRATION_REVISION } from "../src/worker/oauth-client-contract.ts";

const SERVER_NAME = "machine-bridge-mcp";
const BASE = "https://bridge.example.test";
const REDIRECT = "https://client.example.test/callback";
const PASSWORD = `test_password_${"A".repeat(43)}`;

async function testOAuthStoreCapacityBudget() {
  const now = Math.floor(Date.now() / 1000);
  const store = emptyOAuthStore();
  const accountId = `acct_${"a".repeat(43)}`;
  store.accounts[accountId] = {
    account_id: accountId, name: "capacity-owner", display_name: "C".repeat(128), role: "owner", active: true,
    version: 1, password_salt: "s".repeat(43), password_hash: "h".repeat(43), created_at: now, updated_at: now,
  };
  const redirect = `https://client.example.test/${"r".repeat(995)}`;
  const clients = [];
  for (let index = 0; index < 50; index += 1) {
    const suffix = index.toString(36).padStart(43, "0");
    const clientId = `mcp_client_${suffix}`;
    clients.push(clientId);
    store.clients[clientId] = {
      client_id: clientId, client_name: "C".repeat(128), redirect_uris: Array.from({ length: 5 }, (_, offset) => `${redirect.slice(0, 1022)}${offset}`),
      created_at: now, last_used_at: now, has_been_authorized: true,
      registration_identity: `hmac-sha256:${index.toString(16).padStart(64, "0")}`,
      registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
      trusted_account_id: accountId, trusted_account_version: 1, trusted_role: "owner", trusted_at: now,
    };
  }
  for (let index = 0; index < 200; index += 1) {
    const code = `mcp_code_${index.toString(36).padStart(43, "0")}`;
    store.codes[code] = {
      client_id: clients[Math.floor(index / 10)], account_id: accountId, account_version: 1, role: "owner",
      redirect_uri: redirect, code_challenge: "k".repeat(43), scope: `${SERVER_NAME} offline_access`,
      resource: `${BASE}/mcp`, expires_at: now + 300,
    };
  }
  for (let index = 0; index < 500; index += 1) {
    store.tokens[`sha256:${index.toString(16).padStart(64, "0")}`] = {
      client_id: clients[index % clients.length], account_id: accountId, account_version: 1, role: "owner",
      scope: `${SERVER_NAME} offline_access`, resource: `${BASE}/mcp`, version: `token_version_${"v".repeat(43)}`,
      expires_at: now + 900, family_id: `mcp_family_${(index % 50).toString(36).padStart(43, "0")}`,
    };
  }
  for (let index = 0; index < 200; index += 1) {
    store.auth_failures[`hmac-sha256:${(index + 1_000).toString(16).padStart(64, "0")}`] = {
      count: 10, window_started: now, blocked_until: now + 900, last_attempt: now,
    };
  }
  assert(isCurrentOAuthStore(store), "maximum generated-shape OAuth store fixture is not schema-valid");
  const bytes = new TextEncoder().encode(JSON.stringify(store)).byteLength;
  assert(bytes < 1_500_000, "bounded OAuth main store no longer retains conservative single-value headroom");
}

async function testOAuthStoreDeepValidation() {
  const now = Math.floor(Date.now() / 1000);
  const account = await createAccount({ name: "validator", displayName: "Validator", role: "editor", password: PASSWORD, now });
  const clientId = `mcp_client_${"v".repeat(43)}`;
  const codeKey = `mcp_code_${"q".repeat(43)}`;
  const tokenKey = `sha256:${"a".repeat(64)}`;
  const failureKey = `hmac-sha256:${"b".repeat(64)}`;
  const valid = emptyOAuthStore();
  valid.accounts[account.account_id] = account;
  valid.clients[clientId] = {
    client_id: clientId, client_name: "validator-client", redirect_uris: [REDIRECT],
    created_at: now, last_used_at: now, has_been_authorized: true,
    registration_identity: `hmac-sha256:${"1".repeat(64)}`,
    registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
    trusted_account_id: account.account_id, trusted_account_version: account.version, trusted_role: "editor",
  };
  valid.codes[codeKey] = {
    client_id: clientId, account_id: account.account_id, account_version: account.version, role: "editor",
    redirect_uri: REDIRECT, code_challenge: "C".repeat(43), scope: SERVER_NAME, resource: `${BASE}/mcp`, expires_at: now + 300,
  };
  valid.tokens[tokenKey] = {
    client_id: clientId, account_id: account.account_id, account_version: account.version, role: "editor",
    scope: SERVER_NAME, resource: `${BASE}/mcp`, version: "token-version", expires_at: now + 300,
    family_id: `mcp_family_${"f".repeat(43)}`, dpop_jkt: "j".repeat(43),
  };
  valid.auth_failures[failureKey] = { count: 1, window_started: now, blocked_until: 0, last_attempt: now };
  assert(isCurrentOAuthStore(valid), "production-shaped nonempty OAuth store failed deep validation");

  const legacyClient = structuredClone(valid);
  delete legacyClient.clients[clientId].registration_revision;
  assert(isCurrentOAuthStore(legacyClient), "legacy OAuth client without a registration revision became unreadable");

  const malformedRevision = structuredClone(valid);
  malformedRevision.clients[clientId].registration_revision = 0;
  assert(!isCurrentOAuthStore(malformedRevision), "invalid OAuth client registration revision passed deep validation");

  const persistedShortName = structuredClone(valid);
  persistedShortName.accounts[account.account_id].name = "v";
  assert(isCurrentOAuthStore(persistedShortName), "existing short account identity became unreadable during current-store validation");
  assert(accountByName(persistedShortName, "V")?.account_id === account.account_id,
    "existing short account identity became unusable for authorization lookup after upgrade");
  let rejectedShortCreation = false;
  try { await createAccount({ name: "v", role: "reviewer", password: PASSWORD, now }); }
  catch (error) { rejectedShortCreation = /3-64 lowercase/.test(String(error?.message || "")); }
  assert(rejectedShortCreation, "new account creation silently retained the older short-name rule");

  const badClientKey = structuredClone(valid);
  badClientKey.clients.invalid = badClientKey.clients[clientId];
  delete badClientKey.clients[clientId];
  assert(!isCurrentOAuthStore(badClientKey), "invalid OAuth client map key passed deep validation");

  const orphanTrustedAt = structuredClone(valid);
  const orphanClient = orphanTrustedAt.clients[clientId];
  delete orphanClient.trusted_account_id; delete orphanClient.trusted_account_version; delete orphanClient.trusted_role;
  orphanClient.trusted_at = now;
  assert(!isCurrentOAuthStore(orphanTrustedAt), "trusted_at without a trusted authority tuple passed deep validation");

  const credentialRedirect = structuredClone(valid);
  const credentialUri = new URL(REDIRECT);
  credentialUri.username = "synthetic-user";
  credentialUri.password = "synthetic-password";
  credentialRedirect.clients[clientId].redirect_uris = [credentialUri.toString()];
  assert(!isCurrentOAuthStore(credentialRedirect), "credential-bearing OAuth redirect URI passed deep validation");

  const badChallenge = structuredClone(valid);
  badChallenge.codes[codeKey].code_challenge = "short";
  assert(!isCurrentOAuthStore(badChallenge), "invalid PKCE code challenge passed deep validation");

  const reversedFailureWindow = structuredClone(valid);
  reversedFailureWindow.auth_failures[failureKey].last_attempt = now - 1;
  reversedFailureWindow.auth_failures[failureKey].window_started = now;
  assert(!isCurrentOAuthStore(reversedFailureWindow), "reversed OAuth failure window passed deep validation");

  const unknownStoreField = structuredClone(valid);
  unknownStoreField.future_payload = "unexpected";
  assert(!isCurrentOAuthStore(unknownStoreField), "unknown OAuth store field bypassed the versioned schema boundary");

  const unknownRecordField = structuredClone(valid);
  unknownRecordField.clients[clientId].future_payload = "unexpected";
  assert(!isCurrentOAuthStore(unknownRecordField), "unknown OAuth client field bypassed deep record validation");
}

async function testStoreAndRegistration() {
  const storage = new MemoryStorage();
  const controller = createController(storage);
  assert(controller.identityKey() === "token-version", "OAuth identity key did not prefer deployment token version");
  const initial = await controller.oauthStore();
  assert(initial.schema_version === 1 && Object.keys(initial.clients).length === 0, "empty OAuth store was not initialized in memory");

  const first = await controller.registerClient(registrationRequest("198.51.100.10"));
  assert(first.status === 201, "valid dynamic client registration failed");
  const body = await first.json();
  assert(typeof body.client_id === "string" && body.redirect_uris[0] === REDIRECT, "client registration response lost canonical metadata");
  const stored = await storage.get("oauth");
  const client = stored.clients[body.client_id];
  assert(client.registration_identity.startsWith("hmac-sha256:"), "registration source was not stored as a deployment-keyed HMAC");
  assert(client.registration_revision === OAUTH_CLIENT_REGISTRATION_REVISION, "new DCR client omitted the current registration contract revision");

  const retry = await controller.registerClient(registrationRequest("198.51.100.10"));
  const retryBody = await retry.json();
  assert(retry.status === 201 && retryBody.client_id === body.client_id,
    "identical pending DCR retry allocated another OAuth client instead of reusing the registration");
  assert(Object.keys((await storage.get("oauth")).clients).length === 1, "identical DCR retry grew the client registry");

  for (let index = 1; index < 5; index += 1) {
    const response = await controller.registerClient(registrationRequest("198.51.100.10", `https://client.example.test/callback-${index}`));
    assert(response.status === 201, "registration source was throttled before the documented pending-client limit");
  }
  const limited = await controller.registerClient(registrationRequest("198.51.100.10", "https://client.example.test/callback-overflow"));
  assert(limited.status === 429, "pending client limit did not reject the sixth distinct registration for one source");

  const invalid = await controller.registerClient(new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://remote.example.test/callback"] }),
  }));
  assert(invalid.status === 400, "non-local insecure redirect URI was accepted");
}


async function testStaleRegistrationFailsFast() {
  const storage = new MemoryStorage();
  const controller = createController(storage);
  const registration = await controller.registerClient(registrationRequest("203.0.113.44"));
  const client = await registration.json();
  const store = await storage.get("oauth");
  delete store.clients[client.client_id].registration_revision;
  await storage.put("oauth", store);

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: "C".repeat(43), code_challenge_method: "S256",
    scope: `${SERVER_NAME} offline_access`, resource: `${BASE}/mcp`, state: "stale-registration",
  })) authorizeUrl.searchParams.set(key, value);
  const response = await controller.authorizeGet(new Request(authorizeUrl), BASE);
  const body = await response.text();
  assert(response.status === 409, "stale OAuth client registration did not fail before account authorization");
  assert(body.includes("Recreate this app before authorizing it again"), "stale OAuth client failure did not explain the required recovery");
  const persisted = await storage.get("oauth");
  assert(Object.keys(persisted.codes).length === 0 && Object.keys(persisted.tokens).length === 0,
    "stale OAuth client authorization created credentials before failing");
}


async function testAuthorizationPageRendering() {
  const rejected = authorizationPage({
    request: new Request(`${BASE}/oauth/authorize?client_id=query-client&state=query-state&account_password=hidden`),
    base: BASE,
    serverName: SERVER_NAME,
    error: "Invalid <request>",
    submitted: {
      client_id: "submitted-client",
      state: "submitted-state",
      account_name: "<owner>",
      account_password: "must-not-render",
      unrelated: "must-not-render",
    },
    status: 400,
    allowSubmit: false,
  });
  const rejectedBody = await rejected.text();
  assert(rejected.status === 400, "authorization page lost the requested error status");
  assert(rejectedBody.includes("Invalid &lt;request&gt;"), "authorization page did not escape the error message");
  assert(!rejectedBody.includes("must-not-render") && !rejectedBody.includes('name="account_password"') && !rejectedBody.includes("<form"), "authorization page exposed credentials, unrelated fields, or a disabled form");

  const authorized = authorizationPage({
    request: new Request(`${BASE}/oauth/authorize?state=query-state`),
    base: BASE,
    serverName: SERVER_NAME,
    authorization: {
      client: { client_name: "Client <One>" },
      redirectUri: REDIRECT,
      requestedResource: `${BASE}/mcp`,
    },
  });
  const authorizedBody = await authorized.text();
  const csp = authorized.headers.get("content-security-policy") || "";
  assert(authorizedBody.includes("Client &lt;One&gt;") && authorizedBody.includes("<form"), "valid authorization page lost escaped client identity or submit form");
  assert(authorizedBody.includes("Unverified dynamically registered client") && authorizedBody.includes("self-asserted"),
    "first-use dynamic client was rendered as if its attacker-controlled display name were trusted");
  assert(csp.includes(new URL(REDIRECT).origin), "authorization page did not bind CSP to the validated redirect origin");

  const localAuthorized = authorizationPage({
    request: new Request(`${BASE}/oauth/authorize?state=query-state`),
    base: BASE,
    serverName: SERVER_NAME,
    authorization: {
      client: {
        client_name: "Known Local Client",
        has_been_authorized: true,
        trusted_account_id: `acct_${"z".repeat(32)}`,
      },
      redirectUri: "http://127.0.0.1:43123/callback",
      requestedResource: `${BASE}/mcp`,
    },
  });
  const localAuthorizedBody = await localAuthorized.text();
  assert(localAuthorizedBody.includes("Previously authorized and account-bound"),
    "previously authorized dynamic client was not distinguished from first-use registration");
  assert(localAuthorizedBody.includes("Local callback:") && localAuthorizedBody.includes("loopback address"),
    "localhost-only authorization did not present an additional callback warning");

  const queryBacked = authorizationPage({
    request: new Request(`${BASE}/oauth/authorize?client_id=query-client&state=query-state`),
    base: BASE,
    serverName: SERVER_NAME,
  });
  const queryBody = await queryBacked.text();
  assert(queryBody.includes('value="query-client"') && queryBody.includes('value="query-state"'), "authorization page did not preserve query-backed OAuth fields");
}

async function testAuthorizationAndTokens() {
  const storage = new MemoryStorage();
  const controller = createController(storage);
  const registration = await controller.registerClient(registrationRequest("203.0.113.20"));
  const client = await registration.json();
  const store = await storage.get("oauth");
  const now = Math.floor(Date.now() / 1000);
  const account = await createAccount({ name: "test.owner", role: "owner", password: PASSWORD, now });
  store.accounts[account.account_id] = account;
  await storage.put("oauth", store);

  const challenge = "C".repeat(43);
  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: `${SERVER_NAME} offline_access`,
    resource: `${BASE}/mcp`,
    state: "state-value",
  })) authorizeUrl.searchParams.set(key, value);
  const page = await controller.authorizeGet(new Request(authorizeUrl), BASE);
  assert(page.status === 200 && (await page.text()).includes("test.owner") === false, "authorization page leaked account inventory");

  const invalidCredentials = await controller.authorizeSubmit(formRequest(authorizeUrl, {
    account_name: account.name,
    account_password: `test_password_${"B".repeat(43)}`,
  }), BASE);
  assert(invalidCredentials.status === 401, "invalid account credentials were not rejected");
  const failedStore = await storage.get("oauth");
  assert(Object.keys(failedStore.auth_failures).length === 1, "authorization failure was not recorded under a hashed source identity");

  const authorized = await controller.authorizeSubmit(formRequest(authorizeUrl, {
    account_name: account.name,
    account_password: PASSWORD,
  }), BASE);
  assert(authorized.status === 303, "valid account authorization did not issue a redirect");
  const redirect = new URL(authorized.headers.get("location"));
  assert(redirect.origin === new URL(REDIRECT).origin && redirect.searchParams.get("state") === "state-value", "authorization redirect changed the registered callback or state");
  const authorizedStore = await storage.get("oauth");
  assert(Object.keys(authorizedStore.codes).length === 1 && Object.keys(authorizedStore.auth_failures).length === 0, "successful authorization did not replace failure state with a one-time code");

  const rawToken = "access_token_for_controller_test";
  const tokenKey = `sha256:${await sha256Hex(rawToken)}`;
  authorizedStore.tokens[tokenKey] = {
    client_id: client.client_id,
    account_id: account.account_id,
    account_version: account.version,
    role: account.role,
    scope: SERVER_NAME,
    resource: `${BASE}/mcp`,
    version: "token-version",
    expires_at: now + 300,
  };
  await storage.put("oauth", authorizedStore);
  const verified = await controller.verifyAccessToken(rawToken, BASE);
  assert(verified?.accountId === account.account_id && verified.role === "owner", "valid access token lost account authority");
  assert(await controller.verifyAccessToken(rawToken, "https://other.example.test") === null, "access token was not bound to the MCP resource origin");

  const invalidScopeToken = "access_token_with_invalid_scope";
  const invalidScopeKey = `sha256:${await sha256Hex(invalidScopeToken)}`;
  const invalidScopeStore = await storage.get("oauth");
  invalidScopeStore.tokens[invalidScopeKey] = { ...invalidScopeStore.tokens[tokenKey], scope: "offline_access" };
  await storage.put("oauth", invalidScopeStore);
  assert(await controller.verifyAccessToken(invalidScopeToken, BASE) === null,
    "persisted access token without the MCP resource scope remained usable");
  assert(!(invalidScopeKey in (await storage.get("oauth")).tokens),
    "access token with invalid persisted scope was not pruned after fail-closed verification");

  const expiredStore = await storage.get("oauth");
  expiredStore.tokens[tokenKey].expires_at = now - 1;
  await storage.put("oauth", expiredStore);
  assert(await controller.verifyAccessToken(rawToken, BASE) === null, "expired access token remained usable");
  assert(!(tokenKey in (await storage.get("oauth")).tokens), "expired access token was not pruned from persistent state");
}

async function testMalformedRoleRepair() {
  for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
    assert(normalizeAccountRole(inherited) === null, `Worker accepted inherited account role ${inherited}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const account = await createAccount({ name: "repair.target", role: "reviewer", password: PASSWORD, now });
  const tokenKey = `sha256:${"a".repeat(64)}`;
  const codeKey = `mcp_code_${"c".repeat(43)}`;
  const clientId = `mcp_client_${"d".repeat(43)}`;
  account.role = "constructor";
  const storage = new MemoryStorage({ oauth: {
    schema_version: 1,
    accounts: { [account.account_id]: account },
    clients: {},
    codes: { [codeKey]: { client_id: clientId, account_id: account.account_id, account_version: account.version, role: "constructor", redirect_uri: REDIRECT, code_challenge: "C".repeat(43), scope: SERVER_NAME, resource: `${BASE}/mcp`, expires_at: now + 300 } },
    tokens: { [tokenKey]: { client_id: clientId, account_id: account.account_id, account_version: account.version, role: "constructor", scope: SERVER_NAME, resource: `${BASE}/mcp`, version: "token-version", expires_at: now + 300 } },
    auth_failures: {},
  } });
  const repaired = await createController(storage).oauthStore();
  const repairedAccount = repaired.accounts[account.account_id];
  assert(repairedAccount.role === "reviewer" && repairedAccount.active === false, "malformed account role was not repaired fail-closed");
  assert(repairedAccount.version === account.version + 1, "malformed account repair did not invalidate existing credentials");
  assert(Object.keys(repaired.codes).length === 0 && Object.keys(repaired.tokens).length === 0, "malformed account repair retained credentials");
  const persisted = await storage.get("oauth");
  assert(persisted.accounts[account.account_id].active === false, "malformed account repair was not persisted");
}

async function testRefreshReplayStateBoundsAndValidation() {
  const oauthStore = emptyOAuthStore();
  const refreshStore = emptyOAuthRefreshStore();
  const familyId = `mcp_family_${"f".repeat(43)}`;
  oauthStore.tokens[`sha256:${"a".repeat(64)}`] = { family_id: familyId };
  refreshStore.tokens[`sha256:${"b".repeat(64)}`] = { family_id: familyId };
  const consumedAt = 1_800_000_000;
  const source = {
    client_id: `mcp_client_${"c".repeat(43)}`,
    account_id: `acct_${"a".repeat(20)}`,
    account_version: 1,
    role: "owner",
    scope: `${SERVER_NAME} offline_access`,
    resource: `${BASE}/mcp`,
    version: "token-version",
    family_id: familyId,
    issued_at: consumedAt - 60,
    expires_at: consumedAt + 10_000,
    family_expires_at: consumedAt + 20_000,
  };
  for (let index = 0; index < 4_100; index += 1) {
    const hash = `sha256:${(index % 16).toString(16)}${index.toString(16).padStart(63, "0")}`;
    recordConsumedRefreshToken(
      oauthStore,
      refreshStore,
      hash,
      source,
      consumedAt + 10_000,
      consumedAt + index,
    );
  }
  assert(Object.keys(refreshStore.consumed).length === 4_096, "consumed refresh-token replay state exceeded its hard bound");
  assert(!(`sha256:${"0".repeat(64)}` in refreshStore.consumed), "oldest consumed refresh-token marker was not pruned first");
  assert(refreshStore.revoked_families[familyId]?.reason === "replay", "tombstone eviction did not revoke its refresh family");
  assert(Object.keys(oauthStore.tokens).length === 0 && Object.keys(refreshStore.tokens).length === 0, "tombstone eviction retained active family credentials");

  const legacyV2 = structuredClone(refreshStore);
  legacyV2.schema_version = 2;
  for (const marker of Object.values(legacyV2.consumed)) {
    delete marker.retry_until;
    delete marker.retry_issues;
    delete marker.source;
    delete marker.access_scope;
  }
  const migratedStorage = new MemoryStorage({ "oauth-refresh": legacyV2 });
  const migrated = await loadOAuthRefreshStore(oauthStore, migratedStorage);
  assert(migrated.schema_version === 3, "schema-2 refresh state did not migrate without credential loss");
  assert(Object.keys(migrated.consumed).length === 4_096, "schema-2 consumed replay markers were lost during sharded migration");
  assert(Object.keys((await migratedStorage.get("oauth-refresh")).consumed).length === 0,
    "migrated refresh main value retained high-cardinality consumed replay state");
  assert([...migratedStorage.values.keys()].some((key) => key.startsWith("oauth-refresh-consumed:")),
    "migrated refresh state did not persist consumed replay shards");

  const malformed = emptyOAuthRefreshStore();
  malformed.consumed[`sha256:${"a".repeat(64)}`] = {
    family_id: `mcp_family_${"f".repeat(43)}`,
    consumed_at: 0,
    expires_at: consumedAt + 1,
  };
  const storage = new MemoryStorage({ "oauth-refresh": malformed });
  await expectReject(() => loadOAuthRefreshStore(emptyOAuthStore(), storage), "oauth_refresh_state_schema_mismatch");

  const malformedRetryScope = emptyOAuthRefreshStore();
  malformedRetryScope.consumed[`sha256:${"b".repeat(64)}`] = {
    family_id: source.family_id,
    consumed_at: consumedAt,
    expires_at: consumedAt + 100,
    retry_until: consumedAt + 30,
    retry_issues: 0,
    source: { ...source },
    access_scope: `${SERVER_NAME} unexpected_scope`,
  };
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage({ "oauth-refresh": malformedRetryScope })),
    "oauth_refresh_state_schema_mismatch",
  );

  const unknownRefreshField = emptyOAuthRefreshStore();
  unknownRefreshField.future_payload = "unexpected";
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage({ "oauth-refresh": unknownRefreshField })),
    "oauth_refresh_state_schema_mismatch",
  );

  const unknownMarkerField = emptyOAuthRefreshStore();
  unknownMarkerField.consumed[`sha256:${"c".repeat(64)}`] = {
    family_id: source.family_id, consumed_at: consumedAt, expires_at: consumedAt + 100, future_payload: "unexpected",
  };
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage({ "oauth-refresh": unknownMarkerField })),
    "oauth_refresh_state_schema_mismatch",
  );

  const shardedRoot = emptyOAuthRefreshStore();
  const shardHash = `sha256:a${"0".repeat(63)}`;
  const shardMarker = { family_id: source.family_id, consumed_at: consumedAt, expires_at: consumedAt + 100 };
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage({
      "oauth-refresh": shardedRoot,
      "oauth-refresh-consumed:2": { schema_version: 1, records: { [shardHash]: shardMarker }, future_payload: "unexpected" },
    })),
    "oauth_refresh_state_schema_mismatch",
  );
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage({
      "oauth-refresh": shardedRoot,
      "oauth-refresh-consumed:2": {
        schema_version: 1,
        records: { [shardHash]: { ...shardMarker, future_payload: "unexpected" } },
      },
    })),
    "oauth_refresh_state_schema_mismatch",
  );
}

async function testRefreshReplayCompaction() {
  const now = Math.floor(Date.now() / 1000);
  const oauthStore = emptyOAuthStore();
  const refreshStore = emptyOAuthRefreshStore();
  const familyId = `mcp_family_${"z".repeat(43)}`;
  const source = {
    client_id: `mcp_client_${"y".repeat(43)}`,
    account_id: `acct_${"x".repeat(43)}`,
    account_version: 1,
    role: "owner",
    scope: `${SERVER_NAME} offline_access`,
    resource: `${BASE}/mcp`,
    version: "token-version",
    family_id: familyId,
    issued_at: now - 180,
    expires_at: now + 3_600,
    family_expires_at: now + 7_200,
  };
  for (let index = 0; index < 4_096; index += 1) {
    const hash = `sha256:${(index % 16).toString(16)}${index.toString(16).padStart(63, "0")}`;
    recordConsumedRefreshToken(oauthStore, refreshStore, hash, source, now + 7_200, now - 120);
  }
  const expandedBytes = new TextEncoder().encode(JSON.stringify(refreshStore)).byteLength;
  assert(expandedBytes > 2_000_000, "refresh replay fixture no longer exercises a storage-sized expanded state");
  const storage = new MemoryStorage({ "oauth-refresh": refreshStore });
  const compacted = await loadOAuthRefreshStore(oauthStore, storage);
  assert(Object.values(compacted.consumed).every((marker) => (
    marker.source === undefined && marker.retry_until === undefined
    && marker.retry_issues === undefined && marker.access_scope === undefined
  )), "expired refresh retry payload was retained after its concurrency window");
  const compactedBytes = new TextEncoder().encode(JSON.stringify(compacted)).byteLength;
  assert(compactedBytes < 1_000_000, "compacted refresh replay state no longer stays comfortably below the in-memory replay budget");
  const persistedMain = await storage.get("oauth-refresh");
  assert(Object.keys(persistedMain.consumed).length === 0,
    "high-cardinality consumed replay state leaked back into the main refresh value");
  const shards = [...storage.values.entries()].filter(([key]) => key.startsWith("oauth-refresh-consumed:"));
  assert(shards.length === 8, "refresh replay persistence did not maintain the fixed shard set");
  assert(shards.every(([, shard]) => Object.keys(shard.records).length <= 1_024),
    "refresh replay persistence exceeded its per-shard cardinality budget");
  assert(Math.max(...shards.map(([, shard]) => new TextEncoder().encode(JSON.stringify(shard)).byteLength)) < 512_000,
    "compacted refresh replay shard no longer retains conservative single-value headroom");

  const overfull = emptyOAuthRefreshStore();
  for (let index = 0; index < 1_025; index += 1) {
    overfull.consumed[`sha256:a${index.toString(16).padStart(63, "0")}`] = {
      family_id: familyId, consumed_at: now, expires_at: now + 7_200,
    };
  }
  expectThrow(() => oauthRefreshPersistenceEntries(overfull), "shard capacity exceeded");

  const fullRetryShard = emptyOAuthRefreshStore();
  for (let index = 0; index < 1_024; index += 1) {
    const hash = `sha256:a${index.toString(16).padStart(63, "0")}`;
    recordConsumedRefreshToken(oauthStore, fullRetryShard, hash, source, now + 7_200, now);
  }
  const fullRetryEntries = oauthRefreshPersistenceEntries(fullRetryShard);
  const fullRetryShardBytes = Math.max(...Object.entries(fullRetryEntries)
    .filter(([key]) => key.startsWith("oauth-refresh-consumed:"))
    .map(([, shard]) => new TextEncoder().encode(JSON.stringify(shard)).byteLength));
  assert(fullRetryShardBytes < 1_100_000,
    "maximum full retry-window refresh shard no longer retains conservative single-value headroom");
}

async function testOAuthStorePersistenceFailureClassification() {
  const oauthStore = emptyOAuthStore();
  const refreshStore = emptyOAuthRefreshStore();
  for (const expected of ["oauth", "refresh", "commit"]) {
    const failKey = expected === "oauth" ? "oauth" : expected === "refresh" ? "oauth-refresh" : "";
    const storage = {
      async transaction(callback) {
        const tx = { async put(key) { if (key === failKey) throw new Error("synthetic storage failure"); } };
        await callback(tx);
        if (expected === "commit") throw new Error("synthetic commit failure");
      },
    };
    let failure;
    try { await saveOAuthStores(oauthStore, refreshStore, storage); } catch (error) { failure = error; }
    assert(failure?.name === `oauth_store_persist_${expected}_error`, `OAuth persistence ${expected} failure lost its bounded stage`);
  }
}

async function testAdminNonceStateFailsClosed() {
  const authorization = { nonce: "n".repeat(32), expiresAt: 1_800_000_060 };
  const malformed = new MemoryStorage({ "account-admin-nonces": { invalid: "not-a-timestamp" } });
  assert(await consumeAccountAdminNonce(malformed, authorization, 1_800_000_000) === false, "malformed admin nonce state was silently reset");
  const storage = new MemoryStorage();
  assert(await consumeAccountAdminNonce(storage, authorization, 1_800_000_000) === true, "fresh admin nonce was rejected");
  assert(await consumeAccountAdminNonce(storage, authorization, 1_800_000_001) === false, "admin nonce replay was accepted");
}

async function testOAuthLockContainsCallbackFailure() {
  const storage = new MemoryStorage({ oauth: { schema_version: 0 } });
  let blockedCallbackRejected = false;
  const controller = new OAuthController(memoryDurableObjectState(storage, () => { blockedCallbackRejected = true; }), {
    DAEMON_DEVICE_PUBLIC_KEY: "daemon-secret",
    OAUTH_TOKEN_VERSION: "token-version",
  }, SERVER_NAME, "3.0.0");
  await expectReject(() => controller.registerClient(registrationRequest("198.51.100.30")), "oauth_state_schema_mismatch");
  assert(blockedCallbackRejected === false, "OAuth lock allowed a business error to escape blockConcurrencyWhile and reset the Durable Object");
}

async function testInvalidStateFailsClosed() {
  const storage = new MemoryStorage({ oauth: { schema_version: 0 } });
  const controller = createController(storage);
  await expectReject(() => controller.oauthStore(), "oauth_state_schema_mismatch");

  const malformedClient = emptyOAuthStore();
  const clientId = `mcp_client_${"m".repeat(43)}`;
  malformedClient.clients[clientId] = { client_id: clientId };
  await expectReject(() => createController(new MemoryStorage({ oauth: malformedClient })).oauthStore(), "oauth_state_schema_mismatch");

  const malformedToken = emptyOAuthStore();
  malformedToken.tokens[`sha256:${"b".repeat(64)}`] = {
    client_id: clientId, account_id: `acct_${"a".repeat(43)}`, account_version: 1, role: "owner",
    scope: SERVER_NAME, resource: `${BASE}/mcp`, version: "token-version", expires_at: "not-a-timestamp",
  };
  await expectReject(() => createController(new MemoryStorage({ oauth: malformedToken })).oauthStore(), "oauth_state_schema_mismatch");
  const unconfigured = new OAuthController({ storage }, {
    DAEMON_DEVICE_PUBLIC_KEY: "",
    OAUTH_TOKEN_VERSION: "",
  }, SERVER_NAME, "3.0.0");
  expectThrow(() => unconfigured.identityKey(), "server_not_configured");
}

function createController(storage) {
  return new OAuthController(memoryDurableObjectState(storage), {
    DAEMON_DEVICE_PUBLIC_KEY: "daemon-secret",
    OAUTH_TOKEN_VERSION: "token-version",
  }, SERVER_NAME, "3.0.0");
}

function memoryDurableObjectState(storage, onBlockedCallbackError = () => {}) {
  return {
    storage,
    async blockConcurrencyWhile(callback) {
      try {
        return await callback();
      } catch (error) {
        onBlockedCallbackError(error);
        throw error;
      }
    },
  };
}

function registrationRequest(source, redirectUri = REDIRECT) {
  return new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": source },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirectUri, redirectUri] }),
  });
}

function formRequest(url, extra) {
  const body = new URLSearchParams(url.searchParams);
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.20" },
    body,
  });
}

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(structuredClone(initial)));
  }

  async get(key) {
    if (Array.isArray(key)) return new Map(key.flatMap((name) => this.values.has(name) ? [[name, structuredClone(this.values.get(name))]] : []));
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async transaction(callback) {
    const transaction = new MemoryStorage();
    transaction.values = new Map([...this.values].map(([key, value]) => [key, structuredClone(value)]));
    const result = await callback(transaction);
    this.values = transaction.values;
    return result;
  }
}

async function expectReject(callback, message) {
  try {
    await callback();
  } catch (error) {
    if (String(error?.code || error?.message || error).includes(message)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${message}`);
}

function expectThrow(callback, message) {
  try {
    callback();
  } catch (error) {
    if (String(error?.code || error?.message || error).includes(message)) return;
    throw error;
  }
  throw new Error(`expected throw containing ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await testStoreAndRegistration();
await testOAuthStoreCapacityBudget();
await testOAuthStoreDeepValidation();
await testStaleRegistrationFailsFast();
await testAuthorizationPageRendering();
await testAuthorizationAndTokens();
await testMalformedRoleRepair();
await testRefreshReplayStateBoundsAndValidation();
await testRefreshReplayCompaction();
await testOAuthStorePersistenceFailureClassification();
await testAdminNonceStateFailsClosed();
await testOAuthLockContainsCallbackFailure();
await testInvalidStateFailsClosed();
console.log("worker OAuth controller test ok");
