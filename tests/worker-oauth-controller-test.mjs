import { normalizeAccountRole } from "../src/worker/access.ts";
import { consumeAccountAdminNonce } from "../src/worker/account-admin.ts";
import { OAuthController } from "../src/worker/oauth-controller.ts";
import { authorizationPage } from "../src/worker/oauth-authorization-page.ts";
import { createAccount, emptyOAuthRefreshStore, emptyOAuthStore, sha256Hex } from "../src/worker/oauth-state.ts";
import { loadOAuthRefreshStore, recordConsumedRefreshToken } from "../src/worker/oauth-refresh-families.ts";

const SERVER_NAME = "machine-bridge-mcp";
const BASE = "https://bridge.example.test";
const REDIRECT = "https://client.example.test/callback";
const PASSWORD = `test_password_${"A".repeat(43)}`;

async function testStoreAndRegistration() {
  const storage = new MemoryStorage();
  const controller = createController(storage);
  assert(controller.identityKey() === "token-version", "OAuth identity key did not prefer deployment token version");
  const initial = await controller.oauthStore();
  assert(initial.schema_version === 1 && Object.keys(initial.clients).length === 0, "empty OAuth store was not initialized in memory");

  const first = await controller.registerClient(registrationRequest("198.51.100.10"));
  assert(first.status === 200, "valid dynamic client registration failed");
  const body = await first.json();
  assert(typeof body.client_id === "string" && body.redirect_uris[0] === REDIRECT, "client registration response lost canonical metadata");
  const stored = await storage.get("oauth");
  const client = stored.clients[body.client_id];
  assert(client.registration_identity.startsWith("hmac-sha256:"), "registration source was not stored as a deployment-keyed HMAC");

  for (let index = 1; index < 5; index += 1) {
    const response = await controller.registerClient(registrationRequest("198.51.100.10"));
    assert(response.status === 200, "registration source was throttled before the documented pending-client limit");
  }
  const limited = await controller.registerClient(registrationRequest("198.51.100.10"));
  assert(limited.status === 429, "pending client limit did not reject the sixth registration for one source");

  const invalid = await controller.registerClient(new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://remote.example.test/callback"] }),
  }));
  assert(invalid.status === 400, "non-local insecure redirect URI was accepted");
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
  assert(csp.includes(new URL(REDIRECT).origin), "authorization page did not bind CSP to the validated redirect origin");

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
  const tokenKey = "sha256:malformed-role-token";
  const codeKey = "malformed-role-code";
  account.role = "constructor";
  const storage = new MemoryStorage({ oauth: {
    schema_version: 1,
    accounts: { [account.account_id]: account },
    clients: {},
    codes: { [codeKey]: { client_id: "client", account_id: account.account_id, account_version: account.version, role: "constructor", redirect_uri: REDIRECT, code_challenge: "C".repeat(43), scope: SERVER_NAME, resource: `${BASE}/mcp`, expires_at: now + 300 } },
    tokens: { [tokenKey]: { client_id: "client", account_id: account.account_id, account_version: account.version, role: "constructor", scope: SERVER_NAME, resource: `${BASE}/mcp`, version: "token-version", expires_at: now + 300 } },
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
  const refreshStore = emptyOAuthRefreshStore();
  const consumedAt = 1_800_000_000;
  for (let index = 0; index < 4_100; index += 1) {
    const hash = `sha256:${index.toString(16).padStart(64, "0")}`;
    recordConsumedRefreshToken(
      refreshStore,
      hash,
      `mcp_family_${"f".repeat(43)}`,
      consumedAt + 10_000,
      consumedAt + index,
    );
  }
  assert(Object.keys(refreshStore.consumed).length === 4_096, "consumed refresh-token replay state exceeded its hard bound");
  assert(!(`sha256:${"0".repeat(64)}` in refreshStore.consumed), "oldest consumed refresh-token marker was not pruned first");

  const malformed = emptyOAuthRefreshStore();
  malformed.consumed[`sha256:${"a".repeat(64)}`] = {
    family_id: `mcp_family_${"f".repeat(43)}`,
    consumed_at: 0,
    expires_at: consumedAt + 1,
  };
  const storage = new MemoryStorage({ "oauth-refresh": malformed });
  await expectReject(() => loadOAuthRefreshStore(emptyOAuthStore(), storage), "oauth_refresh_state_schema_mismatch");
}

async function testAdminNonceStateFailsClosed() {
  const authorization = { nonce: "n".repeat(32), expiresAt: 1_800_000_060 };
  const malformed = new MemoryStorage({ "account-admin-nonces": { invalid: "not-a-timestamp" } });
  assert(await consumeAccountAdminNonce(malformed, authorization, 1_800_000_000) === false, "malformed admin nonce state was silently reset");
  const storage = new MemoryStorage();
  assert(await consumeAccountAdminNonce(storage, authorization, 1_800_000_000) === true, "fresh admin nonce was rejected");
  assert(await consumeAccountAdminNonce(storage, authorization, 1_800_000_001) === false, "admin nonce replay was accepted");
}

async function testInvalidStateFailsClosed() {
  const storage = new MemoryStorage({ oauth: { schema_version: 0 } });
  const controller = createController(storage);
  await expectReject(() => controller.oauthStore(), "oauth_state_schema_mismatch");
  const unconfigured = new OAuthController({ storage }, {
    ACCOUNT_ADMIN_SECRET: "",
    DAEMON_DEVICE_PUBLIC_KEY: "",
    OAUTH_TOKEN_VERSION: "",
  }, SERVER_NAME);
  expectThrow(() => unconfigured.identityKey(), "server_not_configured");
}

function createController(storage) {
  return new OAuthController({ storage }, {
    ACCOUNT_ADMIN_SECRET: "admin-secret",
    DAEMON_DEVICE_PUBLIC_KEY: "daemon-secret",
    OAUTH_TOKEN_VERSION: "token-version",
  }, SERVER_NAME);
}

function registrationRequest(source) {
  return new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": source },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT, REDIRECT] }),
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
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
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
await testAuthorizationPageRendering();
await testAuthorizationAndTokens();
await testMalformedRoleRepair();
await testRefreshReplayStateBoundsAndValidation();
await testAdminNonceStateFailsClosed();
await testInvalidStateFailsClosed();
console.log("worker OAuth controller test ok");
