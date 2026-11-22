import { pbkdf2Sync } from "node:crypto";
import { normalizeAccountRole } from "../src/worker/oauth/authority.ts";
import { consumeAccountAdminNonce, handleAccountAdminOperation } from "../src/worker/oauth/account-admin.ts";
import { OAuthController } from "../src/worker/oauth/controller.ts";
import { authorizationPage, authorizationRedirectPage } from "../src/worker/oauth/authorization-page.ts";
import { accountByName, authorizationIdentity, createAccount, emptyOAuthRefreshStore, emptyOAuthStore, pruneAuthFailures, sha256Hex, updateAccount, validateAuthorizationRequest, verifyAccountPassword } from "../src/worker/oauth/state.ts";
import { loadOAuthRefreshStore, recordConsumedRefreshToken } from "../src/worker/oauth/refresh-families.ts";
import { oauthRefreshPersistenceEntries } from "../src/worker/oauth/token-issuance.ts";
import { isCurrentOAuthStore } from "../src/worker/oauth/store-validation.ts";
import { saveOAuthStores } from "../src/worker/oauth/token-issuance.ts";
import { isBrowserNavigationRequest, prefersHtmlDocument, workerErrorClass } from "../src/worker/room/http.ts";
import { authorityRevocations } from "../src/worker/oauth/authority-revocations.ts";
import { MAX_OAUTH_CLIENTS, MAX_OAUTH_REDIRECT_URIS, OAUTH_CLIENT_REGISTRATION_REVISION } from "../src/worker/oauth/contracts.ts";

const SERVER_NAME = "machine-bridge-mcp";
const BASE = "https://bridge.example.test";
const REDIRECT = "https://client.example.test/callback";
const PASSWORD = `test_password_${"A".repeat(43)}`;

async function testHostedPasswordHashFallback() {
  const subtle = crypto.subtle;
  const original = Object.getOwnPropertyDescriptor(subtle, "deriveBits");
  const deriveBits = subtle.deriveBits.bind(subtle);
  Object.defineProperty(subtle, "deriveBits", {
    configurable: true,
    value: (algorithm, ...args) => {
      if (algorithm.name === "PBKDF2" && algorithm.iterations > 100_000) {
        return Promise.reject(new DOMException("PBKDF2 iteration limit", "NotSupportedError"));
      }
      return deriveBits(algorithm, ...args);
    },
  });
  try {
    const account = await createAccount({ name: "hosted-reviewer", role: "reviewer", password: PASSWORD, now: 1 });
    const salt = Buffer.from(account.password_salt, "base64url");
    const reference = pbkdf2Sync(PASSWORD, salt, 100_000, 32, "sha256").toString("base64url");
    assert(account.password_hash === `pbkdf2-sha256$100000$${reference}`, "hosted native hash changed the verifier bytes or 100,000 work factor");
    assert(await verifyAccountPassword(account, PASSWORD), "native 100,000 hash rejected the right password");
    assert(!(await verifyAccountPassword(account, `test_password_${"B".repeat(43)}`)), "native 100,000 hash accepted the wrong password");

    const legacySalt = Buffer.alloc(16, 7);
    const legacyReference = pbkdf2Sync(PASSWORD, legacySalt, 210_000, 32, "sha256").toString("base64url");
    const legacyAccount = {
      ...account,
      account_id: `acct_${"l".repeat(43)}`,
      name: "legacy-reviewer",
      password_salt: legacySalt.toString("base64url"),
      password_hash: `pbkdf2-sha256$210000$${legacyReference}`,
    };
    assert(await verifyAccountPassword(legacyAccount, PASSWORD), "hosted fallback rejected an existing 210,000 verifier");
    assert(!(await verifyAccountPassword(legacyAccount, `test_password_${"B".repeat(43)}`)), "hosted fallback accepted the wrong password");

    const storage = new MemoryStorage();
    const controller = createController(storage);
    const registration = await controller.registerClient(registrationRequest("203.0.113.55"));
    const client = await registration.json();
    const store = await storage.get("oauth");
    store.accounts[legacyAccount.account_id] = legacyAccount;
    await storage.put("oauth", store);

    const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: "C".repeat(43),
      code_challenge_method: "S256",
      scope: `${SERVER_NAME} offline_access`,
      resource: `${BASE}/mcp`,
      state: "legacy-upgrade",
    })) authorizeUrl.searchParams.set(key, value);

    const authorized = await controller.authorizeSubmit(formRequest(authorizeUrl, {
      account_name: legacyAccount.name,
      account_password: PASSWORD,
    }), BASE);
    assert(authorized.status === 303, "legacy 210,000 account authorization did not succeed");
    const upgradedStore = await storage.get("oauth");
    assert(upgradedStore.accounts[legacyAccount.account_id].password_hash.startsWith("pbkdf2-sha256$100000$"),
      "legacy 210,000 account hash was not transparently upgraded to pbkdf2-sha256$100000$ on login");
  } finally {
    if (original) Object.defineProperty(subtle, "deriveBits", original);
    else delete subtle.deriveBits;
  }
}

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
      client_id: clientId, client_name: "C".repeat(128), redirect_uris: Array.from({ length: MAX_OAUTH_REDIRECT_URIS }, (_, offset) => `${redirect.slice(0, 1022)}${offset}`),
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

  for (const mutate of [
    (store) => { store.accounts[account.account_id].role = "OWNER"; },
    (store) => { store.clients[clientId].trusted_role = "OWNER"; },
    (store) => { store.codes[codeKey].role = "OWNER"; },
    (store) => { store.tokens[tokenKey].role = "OWNER"; },
  ]) {
    const nonCanonicalRole = structuredClone(valid);
    mutate(nonCanonicalRole);
    assert(!isCurrentOAuthStore(nonCanonicalRole),
      "non-canonical persisted OAuth role remained current-schema readable");
  }

  const legacyClient = structuredClone(valid);
  delete legacyClient.clients[clientId].registration_revision;
  assert(!isCurrentOAuthStore(legacyClient), "legacy OAuth client without a registration revision remained current-schema readable");

  const malformedRevision = structuredClone(valid);
  malformedRevision.clients[clientId].registration_revision = 0;
  assert(!isCurrentOAuthStore(malformedRevision), "invalid OAuth client registration revision passed deep validation");

  const persistedShortName = structuredClone(valid);
  persistedShortName.accounts[account.account_id].name = "v";
  assert(!isCurrentOAuthStore(persistedShortName), "retired short account identity remained current-schema readable");
  assert(accountByName(persistedShortName, "V") === null,
    "retired short account identity remained usable for authorization lookup");
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

  const sixRedirects = Array.from({ length: 6 }, (_, index) => `${REDIRECT}-${index}`);
  const registerRedirects = (redirect_uris) => controller.registerClient(new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.11" },
    body: JSON.stringify({ redirect_uris }),
  }));
  const six = await registerRedirects(sixRedirects);
  const sixClient = await six.json();
  assert(six.status === 201 && JSON.stringify(sixClient.redirect_uris) === JSON.stringify(sixRedirects),
    "registration did not retain all six redirect URIs");
  const reloaded = await createController(storage).oauthStore();
  assert(JSON.stringify(reloaded.clients[sixClient.client_id]?.redirect_uris) === JSON.stringify(sixRedirects),
    "persisted OAuth client with six redirects did not reload");
  const seven = await registerRedirects([...sixRedirects, `${REDIRECT}-7`]);
  assert(seven.status === 400 && (await seven.json()).error === "invalid_client_metadata",
    "registration accepted more than six redirect URIs");
}


async function testStaleRegistrationRequiresRepair() {
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
  let rejected = false;
  try { await controller.authorizeGet(new Request(authorizeUrl), BASE); }
  catch (error) { rejected = error?.status === 503 && error?.code === "oauth_state_schema_mismatch"; }
  assert(rejected, "stale OAuth client registration was interpreted as a current OAuth store");
  const persisted = await storage.get("oauth");
  assert(Object.keys(persisted.codes).length === 0 && Object.keys(persisted.tokens).length === 0,
    "stale OAuth client state created credentials before current-schema rejection");
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
  assert(/Client &lt;One&gt;/.test(authorizedBody) && /<form/.test(authorizedBody), "valid authorization page lost escaped client identity or submit form");
  assert(/Unverified dynamically registered client/.test(authorizedBody) && /self-asserted/.test(authorizedBody),
    "first-use dynamic client was rendered as if its attacker-controlled display name were trusted");
  assert(/form-action 'self'/.test(csp) && !new RegExp(RegExp.escape(new URL(REDIRECT).origin)).test(csp),
    "authorization page did not lock form-action CSP to 'self'");
  const quoted = authorizationPage({
    request: new Request(`${BASE}/oauth/authorize?state=query-state`),
    base: BASE,
    serverName: "Bridge <'Srv'>",
    authorization: {
      client: { client_name: "Client 'Quote'" },
      redirectUri: REDIRECT,
      requestedResource: `${BASE}/mcp`,
    },
  });
  const quotedBody = await quoted.text();
  assert(quotedBody.includes("Bridge &lt;&#39;Srv&#39;&gt;") && quotedBody.includes("Client &#39;Quote&#39;"),
    "authorization page did not escape single quotes in serverName or client_name");

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

  function formActionSourcesFor(redirectUri) {
    const page = authorizationPage({
      request: new Request(`${BASE}/oauth/authorize?state=query-state`),
      base: BASE,
      serverName: SERVER_NAME,
      authorization: {
        client: { client_name: "Google" },
        redirectUri,
        requestedResource: `${BASE}/mcp/gemini`,
      },
    });
    const csp = page.headers.get("content-security-policy") || "";
    const formAction = csp.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("form-action "));
    return new Set((formAction || "").split(/\s+/).slice(1));
  }

  for (const geminiRedirect of [
    "https://oauth-redirect.googleusercontent.com/r/test",
    "https://oauth-redirect-sandbox.googleusercontent.com/r/test",
    "https://oauth-redirect-test.googleusercontent.com/a/test",
  ]) {
    const sources = formActionSourcesFor(geminiRedirect);
    assert(
      sources.size === 1
        && sources.has("'self'")
        && !sources.has("https://*.google.com")
        && !sources.has("https://*.gemini.google")
        && !sources.has("https://*.googleusercontent.com"),
      `Gemini authorization page CSP broadened beyond 'self' for ${geminiRedirect}`,
    );
  }

  for (const [acceptHeader, expected] of [
    ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", true],
    ["text/html", true],
    ["application/json, text/html;q=0.8", true],
    [undefined, false],
    ["*/*", false],
    ["application/json", false],
    ["text/html;q=0", false],
    ["text/html;q=0.000", false],
    ["text/html-fake", false],
  ]) {
    const request = new Request(`${BASE}/oauth/authorize`, acceptHeader ? { headers: { accept: acceptHeader } } : {});
    assert(prefersHtmlDocument(request) === expected, `prefersHtmlDocument returned wrong value for Accept=${String(acceptHeader)}`);
  }

  for (const [headers, expected] of [
    [{ "sec-fetch-mode": "navigate" }, true],
    [{ "sec-fetch-dest": "document" }, true],
    [{ accept: "text/html" }, true],
    [{ "sec-fetch-mode": "cors", accept: "text/html" }, true],
    [{ "sec-fetch-mode": "same-origin", accept: "application/json" }, false],
    [{ accept: "*/*" }, false],
  ]) {
    const request = new Request(`${BASE}/oauth/authorize`, { headers });
    assert(isBrowserNavigationRequest(request) === expected,
      `isBrowserNavigationRequest returned wrong value for headers=${JSON.stringify(headers)}`);
  }

  const handoffLocation = new URL("https://oauth-redirect.googleusercontent.com/r/client?code=mcp_code_test&state=state-123&iss=https%3A%2F%2Fbridge.example.test");
  const handoff = authorizationRedirectPage({ location: handoffLocation, clientName: "Google <Client>", serverName: "Bridge <'Srv'>" });
  const handoffHtml = await handoff.text();
  assert(handoffHtml.includes("Bridge &lt;&#39;Srv&#39;&gt;"), "handoff page did not escape serverName");
  const handoffCsp = handoff.headers.get("content-security-policy") || "";
  assert(handoff.status === 200, `handoff page returned unexpected status ${handoff.status}`);
  assert(handoff.headers.get("content-type") === "text/html; charset=utf-8", "handoff page used wrong content-type");
  assert(handoff.headers.get("cache-control") === "no-store", "handoff page was cacheable");
  assert(handoff.headers.get("referrer-policy") === "no-referrer", "handoff page leaked referrer");
  assert(handoff.headers.get("x-frame-options") === "DENY", "handoff page missed frame denial");
  assert(
    /default-src 'none'/.test(handoffCsp)
      && /form-action 'none'/.test(handoffCsp)
      && /base-uri 'none'/.test(handoffCsp)
      && /frame-ancestors 'none'/.test(handoffCsp),
    "handoff page weakened CSP directives",
  );
  assert(!/<script\b/i.test(handoffHtml), "handoff page must remain script-free");
  assert(/Google &lt;Client&gt;/.test(handoffHtml), "handoff page failed to escape client name");
  const metaMatch = handoffHtml.match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/);
  assert(metaMatch && metaMatch[1].replaceAll("&amp;", "&") === handoffLocation.href, "handoff meta refresh lost callback URL fidelity");
  const anchorMatch = handoffHtml.match(/<a href="([^"]+)" rel="noreferrer">/);
  assert(anchorMatch && anchorMatch[1].replaceAll("&amp;", "&") === handoffLocation.href, "handoff fallback link lost callback URL fidelity");
  expectThrow(
    () => authorizationRedirectPage({ location: new URL("javascript:alert(1)"), clientName: "Evil", serverName: SERVER_NAME }),
    "HTTPS or HTTP",
  );
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
  const browserSubmitBody = new URLSearchParams(authorizeUrl.searchParams);
  browserSubmitBody.set("account_name", account.name);
  browserSubmitBody.set("account_password", PASSWORD);
  const browserAuthorized = await controller.authorizeSubmit(new Request(authorizeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": "203.0.113.20",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: browserSubmitBody,
  }), BASE);
  assert(browserAuthorized.status === 200, `browser form authorization returned ${browserAuthorized.status}`);
  assert(browserAuthorized.headers.get("content-type") === "text/html; charset=utf-8", "browser form authorization omitted HTML content-type");
  assert(!browserAuthorized.headers.has("location"), "browser HTML handoff unexpectedly set HTTP Location");
  const browserHandoffHtml = await browserAuthorized.text();
  assert(browserHandoffHtml.split(PASSWORD).length === 1, "browser HTML handoff leaked submitted password");
  const browserMeta = browserHandoffHtml.match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/);
  assert(browserMeta, "browser HTML handoff omitted meta refresh callback");
  const browserRedirect = new URL(browserMeta[1].replaceAll("&amp;", "&"));
  assert(
    browserRedirect.origin === new URL(REDIRECT).origin
      && /^mcp_code_[A-Za-z0-9_-]{43}$/.test(browserRedirect.searchParams.get("code") ?? "")
      && browserRedirect.searchParams.get("state") === "state-value"
      && browserRedirect.searchParams.get("iss") === BASE,
    "browser HTML handoff callback missed expected code, state, or issuer",
  );
  const authorizedStore = await storage.get("oauth");
  assert(Object.keys(authorizedStore.codes).length === 2 && Object.keys(authorizedStore.auth_failures).length === 0, "successful authorization did not replace failure state with one-time codes");

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

  let dispatched = 0;
  await controller.runWithCurrentAuthority(verified, () => { dispatched += 1; });
  assert(dispatched === 1, "current authority could not transfer dispatch ownership");
  const currentStore = await storage.get("oauth");
  const revocations = [
    (value) => { delete value.tokens[tokenKey]; },
    (value) => { delete value.clients[client.client_id]; },
    (value) => { value.accounts[account.account_id].active = false; },
    (value) => { value.tokens[tokenKey].family_id = `mcp_family_${"f".repeat(43)}`; },
    (value) => { value.tokens[tokenKey].expires_at = now - 1; },
  ];
  for (const revoke of revocations) {
    const revoked = structuredClone(currentStore);
    revoke(revoked);
    await storage.put("oauth", revoked);
    let denied;
    try { await controller.runWithCurrentAuthority(verified, () => { dispatched += 1; }); }
    catch (error) { denied = error; }
    assert(denied?.code === "authorization_denied" && denied.details?.side_effects_started === false,
      "stale authority reached dispatch after an asynchronous pre-dispatch gap");
    assert(dispatched === 1, "revoked authority performed a daemon side effect");
  }
  await storage.put("oauth", currentStore);


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

async function testMalformedRoleRejection() {
  assert(normalizeAccountRole(["owner"]) === null, "Worker coerced an array account role into owner authority");
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
  const before = JSON.stringify(await storage.get("oauth"));
  let rejected = null;
  try { await createController(storage).oauthStore(); } catch (error) { rejected = error; }
  assert(rejected?.status === 503 && rejected?.code === "oauth_state_schema_mismatch",
    "malformed persisted account role was not rejected at the current-schema boundary");
  const persisted = await storage.get("oauth");
  assert(JSON.stringify(persisted) === before,
    "malformed persisted account role was rewritten despite current-schema rejection");
  assert((await authorityRevocations(storage)).length === 0,
    "schema rejection incorrectly emitted an authority revocation for state that was never accepted");
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

  const retiredV2 = structuredClone(refreshStore);
  retiredV2.schema_version = 2;
  await expectReject(
    () => loadOAuthRefreshStore(oauthStore, new MemoryStorage({ "oauth-refresh": retiredV2 })),
    "oauth_refresh_state_schema_mismatch",
  );

  const malformed = emptyOAuthRefreshStore();
  malformed.consumed[`sha256:${"a".repeat(64)}`] = {
    family_id: `mcp_family_${"f".repeat(43)}`,
    consumed_at: 0,
    expires_at: consumedAt + 1,
  };
  const malformedEntries = oauthRefreshPersistenceEntries(emptyOAuthRefreshStore());
  malformedEntries["oauth-refresh"] = malformed;
  const storage = new MemoryStorage(malformedEntries);
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
  await expectReject(() => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(oauthRefreshPersistenceEntries(malformedRetryScope))),
    "oauth_refresh_state_schema_mismatch");

  const unknownRefreshField = emptyOAuthRefreshStore();
  unknownRefreshField.future_payload = "unexpected";
  const unknownRefreshEntries = oauthRefreshPersistenceEntries(emptyOAuthRefreshStore());
  unknownRefreshEntries["oauth-refresh"] = unknownRefreshField;
  await expectReject(() => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(unknownRefreshEntries)),
    "oauth_refresh_state_schema_mismatch");

  const unknownMarkerField = emptyOAuthRefreshStore();
  unknownMarkerField.consumed[`sha256:${"c".repeat(64)}`] = {
    family_id: source.family_id, consumed_at: consumedAt, expires_at: consumedAt + 100, future_payload: "unexpected",
  };
  await expectReject(() => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(oauthRefreshPersistenceEntries(unknownMarkerField))),
    "oauth_refresh_state_schema_mismatch");

  const shardedRoot = emptyOAuthRefreshStore();
  const shardHash = `sha256:a${"0".repeat(63)}`;
  const shardMarker = { family_id: source.family_id, consumed_at: consumedAt, expires_at: consumedAt + 100 };
  const incompleteShards = oauthRefreshPersistenceEntries(shardedRoot);
  delete incompleteShards["oauth-refresh-consumed:7"];
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(incompleteShards)),
    "oauth_refresh_state_schema_mismatch",
  );
  const unknownShardEnvelope = oauthRefreshPersistenceEntries(shardedRoot);
  unknownShardEnvelope["oauth-refresh-consumed:2"] = {
    schema_version: 1, records: { [shardHash]: shardMarker }, future_payload: "unexpected",
  };
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(unknownShardEnvelope)),
    "oauth_refresh_state_schema_mismatch",
  );
  const unknownShardMarker = oauthRefreshPersistenceEntries(shardedRoot);
  unknownShardMarker["oauth-refresh-consumed:2"] = {
    schema_version: 1,
    records: { [shardHash]: { ...shardMarker, future_payload: "unexpected" } },
  };
  await expectReject(
    () => loadOAuthRefreshStore(emptyOAuthStore(), new MemoryStorage(unknownShardMarker)),
    "oauth_refresh_state_schema_mismatch",
  );
}

async function testRefreshCapacityAuthorityPersistence() {
  const now = Math.floor(Date.now() / 1000);
  const account = await createAccount({ name: "capacity-owner", role: "owner", password: PASSWORD, now });
  const clientId = `mcp_client_${"c".repeat(43)}`, familyId = `mcp_family_${"f".repeat(43)}`;
  const otherFamily = `mcp_family_${"z".repeat(43)}`;
  const accessToken = `mcp_at_${"a".repeat(43)}`, controlToken = `mcp_at_${"c".repeat(43)}`;
  const accessHash = `sha256:${await sha256Hex(accessToken)}`, controlHash = `sha256:${await sha256Hex(controlToken)}`;
  const refreshToken = `mcp_rt_${"r".repeat(43)}`, refreshHash = `sha256:${await sha256Hex(refreshToken)}`;
  const source = { client_id: clientId, account_id: account.account_id, account_version: account.version,
    role: account.role, scope: SERVER_NAME, resource: `${BASE}/mcp`, version: "token-version", family_id: familyId };
  for (const mode of ["load", "rotate-other", "rotate-same"]) {
    for (const failCommit of [false, true]) {
      const oauthStore = emptyOAuthStore(), refreshStore = emptyOAuthRefreshStore();
      oauthStore.accounts[account.account_id] = account;
      oauthStore.clients[clientId] = { client_id: clientId, client_name: "Capacity Client", redirect_uris: [REDIRECT],
        created_at: now, last_used_at: now, has_been_authorized: true, trusted_account_id: account.account_id,
        registration_identity: `hmac-sha256:${"c".repeat(64)}`,
        registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
        trusted_account_version: account.version, trusted_role: account.role, trusted_at: now };
      oauthStore.tokens[accessHash] = { ...source, expires_at: now + 900 };
      oauthStore.tokens[controlHash] = { ...source, family_id: otherFamily, expires_at: now + 900 };
      const refreshSource = { ...source, issued_at: now - 60, expires_at: now + 3_600, family_expires_at: now + 7_200 };
      refreshStore.tokens[`sha256:${"b".repeat(64)}`] = refreshSource;
      refreshStore.tokens[refreshHash] = { ...refreshSource, family_id: mode === "rotate-same" ? familyId : otherFamily };
      for (let index = 0; index < (mode === "load" ? 4_100 : 4_096); index += 1) {
        refreshStore.consumed[`sha256:${(index % 16).toString(16)}${index.toString(16).padStart(63, "0")}`] = {
          family_id: familyId, consumed_at: now - 5_000 + index, expires_at: now + 7_200,
        };
      }
      const storage = new MemoryStorage({ oauth: oauthStore, ...oauthRefreshPersistenceEntries(refreshStore) });
      const before = JSON.stringify([...storage.values]);
      const failure = new Error("synthetic authority queue write failure");
      if (failCommit) {
        const transaction = storage.transaction.bind(storage);
        storage.transaction = (callback) => transaction(async (tx) => {
          const put = tx.put.bind(tx);
          tx.put = (key, value) => key === "authority-revocations" ? Promise.reject(failure) : put(key, value);
          return callback(tx);
        });
      }
      const controller = createController(storage);
      let response, rejected;
      try {
        if (mode === "load") await loadOAuthRefreshStore(await storage.get("oauth"), storage);
        else response = await controller.exchangeToken(new Request(`${BASE}/oauth/token`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
        }), BASE);
      } catch (error) { rejected = error; }
      if (failCommit) {
        assert(rejected === failure || rejected?.cause === failure, "capacity persistence replaced the original queue failure");
        assert(JSON.stringify([...storage.values]) === before, "failed capacity revocation partially committed OAuth or replay state");
        continue;
      }
      if (rejected) throw rejected;
      assert(!Object.hasOwn((await storage.get("oauth")).tokens, accessHash), "capacity eviction retained persisted family access");
      assert(await controller.verifyAccessToken(accessToken, BASE) === null, "capacity eviction regained authority after reload");
      assert(await controller.verifyAccessToken(controlToken, BASE) !== null, "capacity eviction revoked an unrelated family");
      const queue = await authorityRevocations(storage);
      assert(queue.length === 1 && queue[0].family_id === familyId && queue[0].client_id === clientId
        && queue[0].account_id === account.account_id && queue[0].account_version === account.version,
      "capacity eviction lost its durable principal-scoped revocation");
      if (mode !== "load") {
        assert(response.status === (mode === "rotate-same" ? 400 : 200), "capacity rotation returned an invalid grant outcome");
        const body = await response.json();
        if (mode === "rotate-same") assert(body.error === "invalid_grant", "revoked current family returned a token response");
        else assert(await controller.verifyAccessToken(body.access_token, BASE) !== null, "unrelated capacity rotation lost its new access token");
      }
    }
  }
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
  const storage = new MemoryStorage(oauthRefreshPersistenceEntries(refreshStore));
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
    for (const [ErrorType, kind, name] of [
      [Error, "error"], [TypeError, "type_error"], [RangeError, "range_error"],
      [Error, "error", `mcp_rt_${"r".repeat(43)}`],
    ]) {
      const cause = new ErrorType("synthetic private storage failure");
      if (name) cause.name = name;
      const failKey = expected === "oauth" ? "oauth" : expected === "refresh" ? "oauth-refresh" : "";
      const storage = {
        async transaction(callback) {
          const tx = { async put(key) { if (key === failKey) throw cause; } };
          await callback(tx);
          if (expected === "commit") throw cause;
        },
      };
      let failure;
      try { await saveOAuthStores(oauthStore, refreshStore, storage); } catch (error) { failure = error; }
      const category = `oauth_store_persist_${expected}_${kind}`;
      assert(failure?.name === category && workerErrorClass(failure) === category,
        `OAuth persistence ${expected} failure lost its fixed stage/kind`);
      assert(failure?.cause === cause, "OAuth persistence replaced its private causal error");
    }
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

async function testStageARedirectAndCsrfProtections() {
  const storage = new MemoryStorage();
  const controller = createController(storage);
  for (const dangerousRedirect of [
    `https://example.com/${"é".repeat(200)}`,
    `https://example.com?${"a".repeat(1004)}`,
  ]) {
    const rejected = await controller.registerClient(new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.80" },
      body: JSON.stringify({ redirect_uris: [dangerousRedirect] }),
    }));
    assert(rejected.status === 400, `oversized canonical redirect URI was accepted: ${dangerousRedirect.slice(0, 40)}`);
    await controller.oauthStore();
  }

  const registration = await controller.registerClient(registrationRequest("203.0.113.81"));
  const client = await registration.json();
  const store = await storage.get("oauth");
  const now = Math.floor(Date.now() / 1000);
  const account = await createAccount({ name: "csrf.owner", role: "owner", password: PASSWORD, now });
  store.accounts[account.account_id] = account;
  await storage.put("oauth", store);

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: "C".repeat(43),
    code_challenge_method: "S256",
    scope: `${SERVER_NAME} offline_access`,
    resource: `${BASE}/mcp`,
    state: "csrf-state",
  })) authorizeUrl.searchParams.set(key, value);

  for (const crossSiteHeaders of [
    { Origin: "https://evil.test" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Mode": "no-cors" },
  ]) {
    const formBody = new URLSearchParams(authorizeUrl.searchParams);
    formBody.set("account_name", account.name);
    formBody.set("account_password", PASSWORD);
    const blocked = await controller.authorizeSubmit(new Request(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": "203.0.113.81",
        ...crossSiteHeaders,
      },
      body: formBody,
    }), BASE);
    assert(blocked.status === 403, `cross-site authorization submit was not rejected with 403: ${JSON.stringify(crossSiteHeaders)}`);
    assert(Object.keys((await storage.get("oauth")).auth_failures).length === 0, "cross-site request polluted auth_failures");
  }
}

async function testStageAIpv6EvictionAndPatchPreservation() {
  const ip1 = await authorizationIdentity(new Request(`${BASE}/oauth/authorize`, {
    headers: { "CF-Connecting-IP": "2001:db8:1234:5678::1" },
  }), "token-version");
  const ip2 = await authorizationIdentity(new Request(`${BASE}/oauth/authorize`, {
    headers: { "CF-Connecting-IP": "2001:db8:1234:5678:9abc:def0:1:2" },
  }), "token-version");
  const ipOther = await authorizationIdentity(new Request(`${BASE}/oauth/authorize`, {
    headers: { "CF-Connecting-IP": "2001:db8:1234:5679::1" },
  }), "token-version");
  assert(ip1 === ip2, "IPv6 addresses in the same /64 did not share one rate-limit identity");
  assert(ip1 !== ipOther, "IPv6 addresses in different /64 prefixes collided");

  const now = Math.floor(Date.now() / 1000);
  const failureStore = emptyOAuthStore();
  failureStore.auth_failures["hmac-sha256:1"] = { count: 10, window_started: now - 60, blocked_until: now + 900, last_attempt: now - 10 };
  failureStore.auth_failures["hmac-sha256:2"] = { count: 2, window_started: now - 5, blocked_until: 0, last_attempt: now };
  pruneAuthFailures(failureStore, 1, now);
  assert("hmac-sha256:1" in failureStore.auth_failures && !("hmac-sha256:2" in failureStore.auth_failures),
    "pruneAuthFailures evicted an active lockout ahead of an unblocked single failure");

  const dcrStorage = new MemoryStorage();
  const dcrController = createController(dcrStorage);
  const fullStore = emptyOAuthStore();
  const owner = await createAccount({ name: "cap.owner", role: "owner", password: PASSWORD, now });
  fullStore.accounts[owner.account_id] = owner;
  const oldestPendingId = `mcp_client_${"0".repeat(43)}`;
  fullStore.clients[oldestPendingId] = {
    client_id: oldestPendingId,
    client_name: "Stale Pending",
    redirect_uris: [REDIRECT],
    created_at: now - 500,
    last_used_at: now - 500,
    has_been_authorized: false,
    registration_identity: `hmac-sha256:${"0".repeat(64)}`,
    registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
  };
  for (let index = 1; index < MAX_OAUTH_CLIENTS; index += 1) {
    const id = `mcp_client_${index.toString(36).padStart(43, "a")}`;
    fullStore.clients[id] = {
      client_id: id,
      client_name: `Authorized ${index}`,
      redirect_uris: [REDIRECT],
      created_at: now - 100 + index,
      last_used_at: now - 100 + index,
      has_been_authorized: true,
      registration_identity: `hmac-sha256:${index.toString(16).padStart(64, "0")}`,
      registration_revision: OAUTH_CLIENT_REGISTRATION_REVISION,
      trusted_account_id: owner.account_id,
      trusted_account_version: 1,
      trusted_role: "owner",
      trusted_at: now - 100 + index,
    };
  }
  await dcrStorage.put("oauth", fullStore);
  const evictedResponse = await dcrController.registerClient(registrationRequest("198.51.100.77", "https://client.example.test/evictor"));
  assert(evictedResponse.status === 201, "registerClient failed to evict the oldest unauthorized pending client at MAX_OAUTH_CLIENTS");
  const afterEvict = await dcrStorage.get("oauth");
  assert(!afterEvict.clients[oldestPendingId] && Object.keys(afterEvict.clients).length === MAX_OAUTH_CLIENTS,
    "registerClient did not replace the evicted unauthorized client");
  const replaced = Object.values(afterEvict.clients).find((entry) => entry.has_been_authorized === false);
  replaced.has_been_authorized = true;
  replaced.trusted_account_id = owner.account_id;
  replaced.trusted_account_version = 1;
  replaced.trusted_role = "owner";
  replaced.trusted_at = now;
  await dcrStorage.put("oauth", afterEvict);
  const saturatedResponse = await dcrController.registerClient(registrationRequest("198.51.100.78", "https://client.example.test/overflow"));
  assert(saturatedResponse.status === 503, "registerClient did not return 503 when all MAX_OAUTH_CLIENTS slots are authorized");

  const patchStore = emptyOAuthStore();
  patchStore.accounts[owner.account_id] = structuredClone(owner);
  patchStore.accounts[owner.account_id].created_at = now + 100;
  patchStore.accounts[owner.account_id].updated_at = now + 100;
  const activeTokenKey = `sha256:${"e".repeat(64)}`;
  patchStore.tokens[activeTokenKey] = {
    client_id: `mcp_client_${"1".repeat(43)}`,
    account_id: owner.account_id,
    account_version: 1,
    role: "owner",
    scope: SERVER_NAME,
    resource: `${BASE}/mcp`,
    version: "token-version",
    expires_at: now + 900,
    family_id: `mcp_family_${"1".repeat(43)}`,
  };
  let savedRevocation;
  const patchResponse = await handleAccountAdminOperation({
    request: new Request(`${BASE}/admin/accounts`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: owner.account_id, display_name: "Renamed Owner" }),
    }),
    operation: "accounts",
    store: patchStore,
    save: async (revocation) => { savedRevocation = revocation; },
    now: now + 50,
  });
  assert(patchResponse.status === 200, "display_name-only account PATCH failed");
  assert(patchStore.accounts[owner.account_id].version === 1, "display_name-only PATCH bumped account.version");
  assert(patchStore.accounts[owner.account_id].updated_at === now + 100, "clock skew produced updated_at < created_at");
  assert(activeTokenKey in patchStore.tokens && savedRevocation === undefined,
    "display_name-only PATCH revoked active account credentials");
  updateAccount(patchStore.accounts[owner.account_id], { role: "reviewer" }, now + 60);
  assert(patchStore.accounts[owner.account_id].version === 2, "role change did not bump account.version");
}

await testStoreAndRegistration();
await testHostedPasswordHashFallback();
await testOAuthStoreCapacityBudget();
await testOAuthStoreDeepValidation();
await testStaleRegistrationRequiresRepair();
await testAuthorizationPageRendering();
await testAuthorizationAndTokens();
await testMalformedRoleRejection();
await testRefreshReplayStateBoundsAndValidation();
await testRefreshReplayCompaction();
await testRefreshCapacityAuthorityPersistence();
await testOAuthStorePersistenceFailureClassification();
await testAdminNonceStateFailsClosed();
await testOAuthLockContainsCallbackFailure();
await testInvalidStateFailsClosed();
await testStageARedirectAndCsrfProtections();
await testStageAIpv6EvictionAndPatchPreservation();
console.log("worker OAuth controller test ok");

{
  const store = emptyOAuthStore();
  const valid = { response_type: "code", client_id: "constructor", redirect_uri: REDIRECT,
    code_challenge: "C".repeat(43), code_challenge_method: "S256" };
  for (const clientId of ["constructor", "__proto__", "toString"]) {
    assert(validateAuthorizationRequest({ ...valid, client_id: clientId }, BASE, SERVER_NAME, store).status === 400,
      "inherited OAuth client name escaped the malformed-input response");
  }
  for (const field of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource"]) {
    assert(validateAuthorizationRequest({ ...valid, [field]: [valid[field] ?? SERVER_NAME] }, BASE, SERVER_NAME, store).status === 400,
      "OAuth authorization field accepted an array through string coercion");
  }
  const controller = createController(new MemoryStorage());
  const response = await controller.registerClient(new Request(`${BASE}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [[REDIRECT]] }),
  }));
  assert(response.status === 400, "OAuth redirect URI metadata accepted nested arrays");
}
