import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createDaemonAuthentication, createDaemonPreflightHeaders, createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { accountAdminRequestHeaders } from "../src/local/account-admin.mjs";

let daemonInstanceSequence = 0;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const port = await openPort();
const base = `http://127.0.0.1:${port}`;
const persistDir = await mkdtemp(path.join(os.tmpdir(), "mbm-worker-test-"));
const wrangler = path.join(packageRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const OWNER_PASSWORD = `integration_owner_${"A".repeat(43)}`;
const REVIEWER_PASSWORD = `integration_reviewer_${"B".repeat(43)}`;
const EDITOR_PASSWORD = `integration_editor_${"E".repeat(43)}`;
const DAEMON_DEVICE_IDENTITY = createDeviceIdentity();
const DAEMON_SESSION_IDENTITY = createDeviceSessionIdentity(DAEMON_DEVICE_IDENTITY, base, "machine-bridge-mcp", pkg.version);
const args = [
  "dev",
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--persist-to", persistDir,
  "--show-interactive-dev-session=false",
  "--var", `DAEMON_DEVICE_PUBLIC_KEY:${publicDeviceJwkJson(DAEMON_DEVICE_IDENTITY)}`,
  "--var", "OAUTH_TOKEN_VERSION:integration-token-version",
  "--var", "MBM_ALLOWED_ORIGINS:http://localhost:3001",
];

let logs = "";
const daemonSockets = [];
const child = spawn(process.execPath, [wrangler, ...args], {
  cwd: packageRoot,
  env: { ...process.env, NO_COLOR: "1", CI: "1" },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const closed = new Promise((resolve) => { child.once("close", (code, signal) => resolve({ code, signal })); });
child.stdout.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.stderr.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.once("error", (error) => { logs = appendBounded(logs, error.stack || error.message); });

try {
  const health = await waitForWorker(base, child, closed);
  assert(health.ok === true, "health response was not ok");
  assert(health.server === "machine-bridge-mcp", "health server name mismatch");
  assert(health.version === pkg.version, `health version mismatch: ${health.version} != ${pkg.version}`);
  assert(!("daemon" in health), "public health response leaked daemon state");
  const publicMetadata = await fetchJson(`${base}/.well-known/mcp.json`);
  assert(publicMetadata.response.status === 200, "public MCP metadata failed");
  assert(!("tools" in publicMetadata.body), "public MCP metadata exposed potential local tools");
  assert(!("instructions" in publicMetadata.body), "public MCP metadata exposed operational instructions");
  assert(publicMetadata.body.protocolVersions?.includes("2025-11-25"), "public MCP metadata omitted supported versions");
  assert(publicMetadata.body.transport?.type === "streamable-http", "public MCP metadata did not advertise Streamable HTTP");
  const authorizationMetadata = await fetchJson(`${base}/.well-known/oauth-authorization-server/mcp`);
  assert(authorizationMetadata.response.status === 200, "OAuth authorization-server discovery failed");
  assert(authorizationMetadata.body.grant_types_supported?.includes("refresh_token"), "OAuth metadata omitted refresh-token support");
  assert(authorizationMetadata.body.scopes_supported?.includes("offline_access"), "OAuth metadata omitted offline_access");
  const protectedResourceMetadata = await fetchJson(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert(protectedResourceMetadata.response.status === 200, "OAuth protected-resource discovery failed");
  assert(protectedResourceMetadata.body.resource === `${base}/mcp`, "protected-resource metadata changed the MCP resource");
  assert(protectedResourceMetadata.body.authorization_servers?.[0] === base, "protected-resource metadata changed the authorization server");
  const unauthenticatedMcpDiscovery = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  assert(unauthenticatedMcpDiscovery.status === 401, "unauthenticated MCP discovery request did not return 401");
  assert(
    unauthenticatedMcpDiscovery.headers.get("www-authenticate") === `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    "unauthenticated MCP response omitted the protected-resource discovery challenge",
  );
  const wrongHealthMethod = await stableFetch(`${base}/healthz`, { method: "POST" });
  assert(wrongHealthMethod.status === 405, "health endpoint accepted an unsupported method");
  assert(wrongHealthMethod.headers.get("allow") === "GET", "method rejection omitted the Allow header");

  const unrelatedPreflight = await stableFetch(`${base}/oauth/register`, {
    method: "OPTIONS",
    headers: {
      origin: "https://example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(unrelatedPreflight.status === 403, "an unrelated browser origin passed CORS preflight");
  const unrelatedOrigin = await stableFetch(`${base}/healthz`, { headers: { origin: "https://example.com" } });
  assert(unrelatedOrigin.status === 200, "an unrelated actual request was rejected before normal routing");
  assert(unrelatedOrigin.headers.get("access-control-allow-origin") === null, "an unrelated origin received CORS response access");
  const opaqueOrigin = await stableFetch(`${base}/healthz`, { headers: { origin: "null" } });
  assert(opaqueOrigin.status === 200, "an opaque-origin actual request was rejected before normal routing");
  assert(opaqueOrigin.headers.get("access-control-allow-origin") === null, "an opaque origin received CORS response access");
  const opaqueAuthorization = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: {
      origin: "null",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "response_type=code",
  });
  assert(opaqueAuthorization.status === 400, `opaque-origin authorization did not reach OAuth validation: ${opaqueAuthorization.status}`);
  assert(opaqueAuthorization.headers.get("access-control-allow-origin") === null, "opaque-origin authorization received CORS response access");
  assert((await opaqueAuthorization.text()).includes("Authorization cannot continue"), "opaque-origin authorization did not render the normal OAuth error page");
  for (const origin of ["https://chatgpt.com", "https://chat.openai.com", "https://grok.com", "https://x.com"]) {
    const builtInPreflight = await stableFetch(`${base}/oauth/register`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert(builtInPreflight.status === 204, `built-in origin preflight failed for ${origin}: ${builtInPreflight.status}`);
    assert(builtInPreflight.headers.get("access-control-allow-origin") === origin, `built-in preflight omitted ${origin}`);
    const builtInHealth = await stableFetch(`${base}/healthz`, { headers: { origin } });
    assert(builtInHealth.status === 200, `built-in origin could not access health for ${origin}`);
    assert(builtInHealth.headers.get("access-control-allow-origin") === origin, `built-in response omitted ${origin}`);
  }
  const preflight = await stableFetch(`${base}/oauth/register`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3001",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(preflight.status === 204, `configured-origin preflight failed: ${preflight.status}`);
  assert(preflight.headers.get("access-control-allow-origin") === "http://localhost:3001", "preflight omitted exact allowed origin");
  const corsHealth = await stableFetch(`${base}/healthz`, { headers: { origin: "http://localhost:3001" } });
  assert(corsHealth.status === 200, "configured browser origin could not access health endpoint");
  assert(corsHealth.headers.get("access-control-allow-origin") === "http://localhost:3001", "actual response omitted CORS origin");

  const unauthenticatedAdmin = await stableFetch(`${base}/admin/accounts`);
  assert(unauthenticatedAdmin.status === 401, "account administration accepted an unauthenticated request");
  const legacyBearerAdmin = await stableFetch(`${base}/admin/accounts`, {
    headers: { authorization: "Bearer integration-admin-secret" },
  });
  assert(legacyBearerAdmin.status === 401, "account administration still accepted the long-lived bearer protocol");
  const replayOptions = adminRequest("GET", "/admin/accounts");
  const firstSignedAdmin = await stableFetch(`${base}/admin/accounts`, replayOptions);
  const replayedSignedAdmin = await stableFetch(`${base}/admin/accounts`, replayOptions);
  assert(firstSignedAdmin.status === 200 && replayedSignedAdmin.status === 401, "account administration nonce replay was not rejected");
  const shortNameAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "a", role: "owner", password: OWNER_PASSWORD,
  }));
  assert(shortNameAccount.response.status === 400, "account administration accepted a one-character account name despite the 3-64 character contract");
  const weakPasswordAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "weak", role: "owner", password: "human-chosen-password",
  }));
  assert(weakPasswordAccount.response.status === 400, "account administration accepted a human-chosen password");
  assert(weakPasswordAccount.body.message === "account name, display name, role, or password is invalid", "account validation exposed an internal error message");

  const ownerAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "owner", display_name: "Integration Owner", role: "owner", password: OWNER_PASSWORD,
  }));
  assert(ownerAccount.response.status === 201, `owner account creation failed: ${ownerAccount.response.status}`);
  assert(ownerAccount.body.account?.role === "owner", "first account was not created as owner");
  const reviewerAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "reviewer", role: "reviewer", password: REVIEWER_PASSWORD,
  }));
  assert(reviewerAccount.response.status === 201, `reviewer account creation failed: ${reviewerAccount.response.status}`);
  const editorAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "editor", role: "editor", password: EDITOR_PASSWORD,
  }));
  assert(editorAccount.response.status === 201, `editor account creation failed: ${editorAccount.response.status}`);

  const invalidRegistration = await stableFetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://example.com/callback"] }),
  });
  assert(invalidRegistration.status === 400, "non-loopback HTTP redirect URI was accepted");

  const redirectUriInput = "http://LOCALHOST:80/callback/../callback";
  const chatGptRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const claudeRedirectUri = "https://claude.ai/api/mcp/auth_callback";
  const copilotRedirectUri = "https://global.consent.azure-apim.net/redirect/machine-bridge-mcp-test";
  const consentLookalikeRedirectUri = "https://global.consent.azure-apim.net.example.com/callback";
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Integration\u202e <Client>\u200b", redirect_uris: [redirectUriInput, chatGptRedirectUri, claudeRedirectUri, copilotRedirectUri, consentLookalikeRedirectUri] }),
  });
  assert(registration.response.status === 200, `client registration failed: ${registration.response.status}`);
  assert(typeof registration.body.client_id === "string", "registration did not return client_id");
  assert(registration.body.client_name === "Integration <Client>", "registration retained Unicode display-control characters");
  assert(registration.body.redirect_uris?.[0] === "http://localhost/callback", "registration did not canonicalize redirect URI");
  assert(registration.body.redirect_uris?.[1] === chatGptRedirectUri, "registration changed the ChatGPT redirect URI");
  assert(registration.body.redirect_uris?.[2] === claudeRedirectUri, "registration changed the Claude redirect URI");
  assert(registration.body.redirect_uris?.[3] === copilotRedirectUri, "registration changed the Copilot Studio redirect URI");
  assert(registration.body.redirect_uris?.[4] === consentLookalikeRedirectUri, "registration changed the consent-domain lookalike redirect URI");
  assert(registration.body.grant_types?.includes("refresh_token"), "dynamic client registration omitted refresh-token support");
  const redirectUri = registration.body.redirect_uris[0];

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: registration.body.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "machine-bridge-mcp offline_access",
    resource: `${base}/mcp`,
    state: "integration-state",
  };

  const unknownPage = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, client_id: "unknown", resource: `https://safe.example/\u202eresource` })}`);
  const unknownHtml = await unknownPage.text();
  assert(unknownPage.status === 400, "unknown OAuth client did not fail on GET authorization");
  assert(!unknownHtml.includes('name="account_password"'), "invalid authorization request displayed a password form");
  assert(!unknownHtml.includes("\u202e"), "invalid authorization page retained a Unicode display control in resource text");

  const page = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams(authorization)}`);
  const pageHtml = await page.text();
  assert(page.status === 200, `authorization page failed: ${page.status}`);
  assert(pageHtml.includes("Integration &lt;Client&gt;") && !pageHtml.includes("\u202e") && !pageHtml.includes("\u200b"), "authorization page omitted, failed to escape, or retained display controls in client name");
  assert(pageHtml.includes(redirectUri), "authorization page omitted redirect URI");
  const authorizationCsp = page.headers.get("content-security-policy") ?? "";
  assert(authorizationCsp.includes("frame-ancestors 'none'"), "authorization page lacks CSP frame protection");
  const authorizationFormActions = cspDirectiveSources(authorizationCsp, "form-action");
  assert(authorizationFormActions.size === 2 && authorizationFormActions.has("'self'") && authorizationFormActions.has("http://localhost"), "authorization page CSP did not contain only self and the validated loopback redirect origin");
  assert(page.headers.get("cache-control") === "no-store", "authorization page is cacheable");

  const chatGptPage = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, redirect_uri: chatGptRedirectUri, state: "chatgpt-page-state" })}`);
  const chatGptPageCsp = chatGptPage.headers.get("content-security-policy") ?? "";
  assert(chatGptPage.status === 200, `ChatGPT authorization page failed: ${chatGptPage.status}`);
  const chatGptFormActions = cspDirectiveSources(chatGptPageCsp, "form-action");
  assert(chatGptFormActions.size === 2 && chatGptFormActions.has("'self'") && chatGptFormActions.has("https://chatgpt.com"), "ChatGPT authorization page CSP did not contain only self and its validated redirect origin");

  const claudePage = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, redirect_uri: claudeRedirectUri, state: "claude-page-state" })}`);
  const claudePageCsp = claudePage.headers.get("content-security-policy") ?? "";
  assert(claudePage.status === 200, `Claude authorization page failed: ${claudePage.status}`);
  const claudeFormActions = cspDirectiveSources(claudePageCsp, "form-action");
  assert(claudeFormActions.size === 2 && claudeFormActions.has("'self'") && claudeFormActions.has("https://claude.ai"), "Claude authorization page CSP did not contain only self and its validated redirect origin");

  const copilotPage = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, redirect_uri: copilotRedirectUri, state: "copilot-page-state" })}`);
  const copilotPageCsp = copilotPage.headers.get("content-security-policy") ?? "";
  assert(copilotPage.status === 200, `Copilot Studio authorization page failed: ${copilotPage.status}`);
  const copilotFormActions = cspDirectiveSources(copilotPageCsp, "form-action");
  assert(
    copilotFormActions.size === 4
      && copilotFormActions.has("'self'")
      && copilotFormActions.has("https://global.consent.azure-apim.net")
      && copilotFormActions.has("https://*.consent.azure-apim.net")
      && copilotFormActions.has("https://copilotstudio.microsoft.com"),
    "Copilot Studio authorization page CSP did not allow only self, the validated global callback, Microsoft consent subdomains, and the final studio callback",
  );

  const consentLookalikePage = await stableFetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, redirect_uri: consentLookalikeRedirectUri, state: "consent-lookalike-state" })}`);
  const consentLookalikeCsp = consentLookalikePage.headers.get("content-security-policy") ?? "";
  assert(consentLookalikePage.status === 200, `consent-domain lookalike authorization page failed: ${consentLookalikePage.status}`);
  const consentLookalikeFormActions = cspDirectiveSources(consentLookalikeCsp, "form-action");
  assert(
    consentLookalikeFormActions.size === 2
      && consentLookalikeFormActions.has("'self'")
      && consentLookalikeFormActions.has("https://global.consent.azure-apim.net.example.com")
      && !consentLookalikeFormActions.has("https://*.consent.azure-apim.net")
      && !consentLookalikeFormActions.has("https://copilotstudio.microsoft.com"),
    "consent-domain lookalike received the Microsoft callback-chain exception",
  );

  const wrongPassword = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-wrong" },
    body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: `invalid_owner_${"C".repeat(43)}` }),
    redirect: "manual",
  });
  const wrongHtml = await wrongPassword.text();
  assert(wrongPassword.status === 401, `wrong password returned ${wrongPassword.status}`);
  assert(!wrongHtml.includes("invalid_owner_"), "authorization response reflected the submitted password");
  assert(wrongHtml.includes("Invalid account credentials."), "retry page omitted the credential error");
  assert(wrongHtml.includes('role="alert"') && wrongHtml.includes('aria-live="assertive"'), "retry page does not expose an accessible error status");
  assert(wrongHtml.includes('name="account_name" value="owner"'), "retry page did not preserve the non-secret account name");
  assert(wrongHtml.includes("Integration &lt;Client&gt;"), "retry page omitted validated client context");

  const approved = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-valid" },
    body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: OWNER_PASSWORD }),
    redirect: "manual",
  });
  assert(approved.status === 303, `valid authorization returned ${approved.status}`);
  const location = approved.headers.get("location");
  assert(location, "authorization redirect omitted Location");
  const redirect = new URL(location);
  const code = redirect.searchParams.get("code");
  assert(code, "authorization redirect omitted code");
  assert(redirect.searchParams.get("state") === "integration-state", "authorization state was not preserved");

  const chatGptAuthorization = {
    response_type: "code",
    client_id: registration.body.client_id,
    redirect_uri: chatGptRedirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "machine-bridge-mcp",
    resource: `${base}/mcp`,
    state: "chatgpt-state:/?&=%",
    account_name: "owner", account_password: OWNER_PASSWORD,
  };
  const chatGptApproved = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-chatgpt" },
    body: new URLSearchParams(chatGptAuthorization),
    redirect: "manual",
  });
  assert(chatGptApproved.status === 303, `ChatGPT authorization returned ${chatGptApproved.status}`);
  const chatGptLocation = chatGptApproved.headers.get("location");
  assert(chatGptLocation, "ChatGPT authorization redirect omitted Location");
  const chatGptRedirect = new URL(chatGptLocation);
  assert(chatGptRedirect.origin === "https://chatgpt.com", "ChatGPT authorization redirect changed origin");
  assert(chatGptRedirect.pathname === "/connector_platform_oauth_redirect", "ChatGPT authorization redirect changed path");
  assert(chatGptRedirect.searchParams.get("code")?.startsWith("mcp_code_"), "ChatGPT authorization redirect omitted a valid code");
  assert(chatGptRedirect.searchParams.get("state") === chatGptAuthorization.state, "ChatGPT authorization redirect corrupted state");

  const claudeAuthorization = {
    ...authorization,
    redirect_uri: claudeRedirectUri,
    state: "claude-state:/?&=%",
    account_name: "owner",
    account_password: OWNER_PASSWORD,
  };
  const claudeApproved = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-claude" },
    body: new URLSearchParams(claudeAuthorization),
    redirect: "manual",
  });
  assert(claudeApproved.status === 303, `Claude authorization returned ${claudeApproved.status}`);
  const claudeLocation = claudeApproved.headers.get("location");
  assert(claudeLocation, "Claude authorization redirect omitted Location");
  const claudeRedirect = new URL(claudeLocation);
  assert(claudeRedirect.origin === "https://claude.ai", "Claude authorization redirect changed origin");
  assert(claudeRedirect.pathname === "/api/mcp/auth_callback", "Claude authorization redirect changed path");
  assert(claudeRedirect.searchParams.get("code")?.startsWith("mcp_code_"), "Claude authorization redirect omitted a valid code");
  assert(claudeRedirect.searchParams.get("state") === claudeAuthorization.state, "Claude authorization redirect corrupted state");

  const wrongVerifier = await stableFetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: "A".repeat(43),
      resource: `${base}/mcp`,
    }),
  });
  assert(wrongVerifier.status === 400, "invalid PKCE verifier was accepted");

  const token = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(token.response.status === 200, `token exchange failed: ${token.response.status}`);
  assert(typeof token.body.access_token === "string", "token exchange omitted access_token");
  assert(typeof token.body.refresh_token === "string", "token exchange omitted refresh_token");
  assert(token.body.scope === "machine-bridge-mcp offline_access", "token exchange changed the granted scope");
  const refreshed = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
      scope: token.body.scope,
    }),
  });
  assert(refreshed.response.status === 200, `refresh-token exchange failed: ${refreshed.response.status}`);
  assert(typeof refreshed.body.access_token === "string" && refreshed.body.access_token !== token.body.access_token, "refresh did not rotate the access token");
  assert(typeof refreshed.body.refresh_token === "string" && refreshed.body.refresh_token !== token.body.refresh_token, "refresh did not rotate the refresh token");
  assert(refreshed.body.expires_in === 900, "access-token lifetime was not reduced to 15 minutes");
  let ownerAccessToken = refreshed.body.access_token;
  const refreshReplay = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(refreshReplay.response.status === 400 && refreshReplay.body.error === "invalid_grant", "rotated refresh token replay was accepted");
  const familyRefreshAfterReplay = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(familyRefreshAfterReplay.response.status === 400 && familyRefreshAfterReplay.body.error === "invalid_grant", "refresh-token replay did not revoke the complete token family");
  const revokedFamilyAccess = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "revoked-family", version: "1" } } }),
  });
  assert(revokedFamilyAccess.status === 401, "refresh-token replay did not revoke the family's access token");
  const replacementOwnerCredentials = await issueAccountToken({
    base,
    clientId: registration.body.client_id,
    redirectUri,
    accountName: "owner",
    password: OWNER_PASSWORD,
    state: "owner-replacement-state",
  });
  ownerAccessToken = replacementOwnerCredentials.accessToken;

  const reviewerRegistration = await registerTestClient({ base, redirectUri, name: "Reviewer Integration Client" });
  const reviewerCredentials = await issueAccountToken({
    base,
    clientId: reviewerRegistration.client_id,
    redirectUri,
    accountName: "reviewer",
    password: REVIEWER_PASSWORD,
    state: "reviewer-state",
  });
  const reviewerToken = reviewerCredentials.accessToken;
  const reviewerRefreshToken = reviewerCredentials.refreshToken;
  const editorRegistration = await registerTestClient({ base, redirectUri, name: "Editor Integration Client" });
  const editorCredentials = await issueAccountToken({
    base,
    clientId: editorRegistration.client_id,
    redirectUri,
    accountName: "editor",
    password: EDITOR_PASSWORD,
    state: "editor-state",
  });
  const editorToken = editorCredentials.accessToken;

  const replay = await stableFetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(replay.status === 400, "authorization code replay was accepted");

  const invalidUtf8 = await stableFetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0xff, 0xfe]),
  });
  assert(invalidUtf8.status === 400, "invalid UTF-8 request body was accepted");

  const unauthenticated = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {},
  });
  assert(unauthenticated.status === 401, "MCP endpoint accepted a request without a bearer token");

  const initialized = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration", version: "1" } },
    }),
  });
  assert(initialized.response.status === 200, `authenticated initialize failed: ${initialized.response.status}`);
  assert(initialized.body.result?.protocolVersion === "2025-11-25", "initialize did not negotiate the latest supported protocol");
  assert(initialized.body.result?.serverInfo?.version === pkg.version, "initialize returned the wrong Worker version");
  assert(initialized.body.result?.capabilities?.tools, "initialize omitted tools capability");
  const primarySession = initialized.response.headers.get("mcp-session-id");
  assert(/^mcp_[A-Za-z0-9_-]{32}_[A-Za-z0-9_-]{43}$/.test(primarySession || ""), "initialize did not issue a valid MCP session id");

  const secondInitialized = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration-second-window", version: "1" } },
    }),
  });
  const secondarySession = secondInitialized.response.headers.get("mcp-session-id");
  assert(secondInitialized.response.status === 200 && secondarySession && secondarySession !== primarySession, "independent initialize did not create an isolated MCP session");

  const invalidSession = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": tamperSessionId(primarySession),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
  });
  assert(invalidSession.response.status === 404 && invalidSession.body.error?.code === -32001, "tampered MCP session id was accepted");

  const unsupportedProtocol = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "1900-01-01",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
  });
  assert(unsupportedProtocol.response.status === 400, "unsupported MCP protocol header was accepted");
  assert(unsupportedProtocol.body.error?.data?.supported?.includes("2025-11-25"), "unsupported protocol response omitted supported versions");

  const toolsWithoutDaemon = await callToolsList(base, ownerAccessToken, 3);
  assert(toolsWithoutDaemon.length === 1 && toolsWithoutDaemon[0].name === "server_info", "disconnected Worker advertised unavailable local tools");

  const oneTimePreflightHeaders = createDaemonPreflightHeaders(
    DAEMON_SESSION_IDENTITY,
    base,
    "machine-bridge-mcp",
    pkg.version,
  );
  const preflightProbeSocket = await connectDaemon(base, oneTimePreflightHeaders);
  daemonSockets.push(preflightProbeSocket);
  const replayStatus = await rejectedDaemonUpgradeStatus(base, oneTimePreflightHeaders);
  assert(replayStatus === 401, `replayed daemon preflight returned unexpected status ${replayStatus}`);

  const firstDaemon = await connectDaemon(base);
  daemonSockets.push(firstDaemon);
  await sendDaemonHello(firstDaemon, ["read_file", "write_file", "exec_command"]);
  const firstStatus = await callServerInfo(base, ownerAccessToken, 21);
  assert(firstStatus.daemon?.connected === true, "first daemon did not become active after hello");
  assert(firstStatus.daemon?.tools?.includes("read_file"), "first daemon tools were not advertised");
  assert(!firstStatus.daemon?.tools?.includes("write_file"), "review policy did not filter write_file");
  assert(!firstStatus.daemon?.tools?.includes("exec_command"), "review policy did not filter exec_command");
  assert(firstStatus.daemon?.readiness_verified === true, "first daemon was advertised before end-to-end readiness verification");
  const invalidProbeCandidate = await connectDaemon(base);
  daemonSockets.push(invalidProbeCandidate);
  const invalidProbe = await beginDaemonHello(invalidProbeCandidate, ["list_files"]);
  const invalidProbeNotice = waitForWsMessage(invalidProbeCandidate, "error");
  const invalidProbeClosed = waitForWsClose(invalidProbeCandidate);
  invalidProbeCandidate.send(JSON.stringify({ type: "relay_probe_result", id: `${invalidProbe.id}-wrong` }));
  assert((await invalidProbeNotice).error === "invalid_relay_probe_result", "invalid readiness result returned the wrong protocol error");
  assert((await invalidProbeClosed).code === 1002, "invalid readiness result did not close with protocol-error status");
  const statusAfterInvalidProbe = await callServerInfo(base, ownerAccessToken, 211);
  assert(statusAfterInvalidProbe.daemon?.connected === true && statusAfterInvalidProbe.daemon?.tools?.includes("read_file"), "failed replacement readiness probe displaced the incumbent daemon");
  assert(firstStatus.tool_delivery?.host_exposed_tools_known_to_server === false, "Worker server_info incorrectly claimed host tool visibility");
  assert(firstStatus.tool_delivery?.host_may_expose_subset === true, "Worker server_info omitted host-side filtering boundary");

  const timedOutCandidate = await connectDaemon(base);
  daemonSockets.push(timedOutCandidate);
  const timeoutNotice = await waitForWsMessage(timedOutCandidate, "error", 15_000);
  assert(timeoutNotice.error === "daemon_hello_timeout", `unexpected candidate timeout error: ${timeoutNotice.error}`);
  const statusAfterCandidateTimeout = await callServerInfo(base, ownerAccessToken, 22);
  assert(statusAfterCandidateTimeout.daemon?.connected === true, "candidate hello timeout displaced the active daemon");
  assert(statusAfterCandidateTimeout.daemon?.tools?.includes("read_file"), "candidate hello timeout changed active daemon tools");
  if (timedOutCandidate.readyState === WebSocket.OPEN) {
    const expiredCandidateClosed = waitForWsClose(timedOutCandidate);
    timedOutCandidate.send(JSON.stringify({ type: "hello", tools: ["list_files"], policy: {} }));
    const expiredCloseInfo = await expiredCandidateClosed;
    assert(expiredCloseInfo.code === 1008, `expired candidate closed with unexpected code ${expiredCloseInfo.code}`);
  }

  const invalidCandidate = await connectDaemon(base);
  daemonSockets.push(invalidCandidate);
  const invalidCandidateClosed = waitForWsClose(invalidCandidate);
  invalidCandidate.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
  const invalidCloseInfo = await invalidCandidateClosed;
  assert(invalidCloseInfo.code === 1008, `pre-hello daemon message closed with unexpected code ${invalidCloseInfo.code}`);
  const statusAfterInvalidCandidate = await callServerInfo(base, ownerAccessToken, 23);
  assert(statusAfterInvalidCandidate.daemon?.connected === true, "invalid candidate displaced the active daemon");
  assert(statusAfterInvalidCandidate.daemon?.tools?.includes("read_file"), "invalid candidate changed active daemon tools");

  const invalidJsonCandidate = await connectDaemon(base);
  daemonSockets.push(invalidJsonCandidate);
  const invalidJsonNotice = waitForWsMessage(invalidJsonCandidate, "error");
  const invalidJsonClosed = waitForWsClose(invalidJsonCandidate);
  invalidJsonCandidate.send("{");
  assert((await invalidJsonNotice).error === "invalid_json", "invalid daemon JSON returned the wrong protocol error");
  assert((await invalidJsonClosed).code === 1007, "invalid daemon JSON did not close with invalid-payload status");

  const nonObjectCandidate = await connectDaemon(base);
  daemonSockets.push(nonObjectCandidate);
  const nonObjectNotice = waitForWsMessage(nonObjectCandidate, "error");
  const nonObjectClosed = waitForWsClose(nonObjectCandidate);
  nonObjectCandidate.send("null");
  assert((await nonObjectNotice).error === "invalid_message", "non-object daemon JSON returned the wrong protocol error");
  assert((await nonObjectClosed).code === 1002, "non-object daemon JSON did not close with protocol-error status");
  const missingInstanceCandidate = await connectDaemon(base);
  daemonSockets.push(missingInstanceCandidate);
  const missingInstanceNotice = waitForWsMessage(missingInstanceCandidate, "error");
  const missingInstanceClosed = waitForWsClose(missingInstanceCandidate);
  missingInstanceCandidate.send(JSON.stringify({ type: "hello", tools: ["list_dir"], policy: defaultDaemonPolicy() }));
  assert((await missingInstanceNotice).error === "invalid_daemon_instance", "missing daemon instance id returned the wrong protocol error");
  assert((await missingInstanceClosed).code === 1002, "missing daemon instance id did not close with protocol-error status");

  const statusAfterMalformedCandidates = await callServerInfo(base, ownerAccessToken, 231);
  assert(statusAfterMalformedCandidates.daemon?.connected === true, "malformed candidate displaced the active daemon");
  assert(statusAfterMalformedCandidates.daemon?.tools?.includes("read_file"), "malformed candidate changed active daemon tools");

  let candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const statusBeforeHello = await callServerInfo(base, ownerAccessToken, 24);
  assert(statusBeforeHello.daemon?.connected === true, "candidate connection displaced the active daemon before hello");
  assert(statusBeforeHello.daemon?.tools?.includes("read_file"), "candidate connection changed active tools before hello");

  const candidateInstanceId = nextDaemonInstanceId();
  const candidateTools = ["session_bootstrap", "resolve_task_capabilities", "list_dir", "view_image", "run_process", "exec_command"];
  const candidatePolicy = { profile: "agent", allowWrite: true, allowExec: true, execMode: "direct", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
  const firstClosed = waitForWsClose(firstDaemon);
  const replacementProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  const statusDuringProbe = await callServerInfo(base, ownerAccessToken, 241);
  assert(statusDuringProbe.daemon?.connected === true && statusDuringProbe.daemon?.tools?.includes("read_file"), "unverified replacement displaced the incumbent daemon");
  assert(statusDuringProbe.worker?.daemon_probes === 1, "server_info did not expose the in-progress readiness probe");
  assert(statusDuringProbe.worker?.sockets_live?.ready === 1 && statusDuringProbe.worker?.sockets_live?.probing === 1, "server_info conflated authenticated transport with verified readiness");
  await completeDaemonProbe(candidateDaemon, replacementProbe);
  const closeInfo = await firstClosed;
  assert(closeInfo.code === 1012, `replaced daemon closed with unexpected code ${closeInfo.code}`);
  const statusAfterHello = await callServerInfo(base, ownerAccessToken, 25);
  assert(statusAfterHello.daemon?.count === 1, `expected one active daemon after replacement, got ${statusAfterHello.daemon?.count}`);
  assert(statusAfterHello.daemon?.readiness_verified === true && statusAfterHello.worker?.sockets_live?.ready === 1, "verified daemon readiness was not observable");
  assert(statusAfterHello.daemon?.tools?.includes("list_dir"), "candidate daemon did not become active after hello");
  assert(statusAfterHello.daemon?.tools?.includes("view_image"), "candidate daemon image tool was not advertised");
  assert(statusAfterHello.daemon?.tools?.includes("run_process"), "agent policy did not retain direct process execution");
  assert(!statusAfterHello.daemon?.tools?.includes("exec_command"), "agent policy did not filter shell execution");
  assert(!statusAfterHello.daemon?.tools?.includes("read_file"), "replaced daemon tools remained active");

  const streamedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const streamedResponsePromise = stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...mcpHeaders(ownerAccessToken, primarySession),
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 879, method: "tools/call", params: { name: "list_dir", arguments: { path: "." } } }),
  });
  const streamedRelay = await streamedRelayPromise;
  const streamedResponse = await streamedResponsePromise;
  assert(streamedResponse.status === 200, `streamed tool call failed: ${streamedResponse.status}`);
  assert(streamedResponse.headers.get("content-type")?.startsWith("text/event-stream"), "event-stream client received a buffered JSON response");
  const streamedReader = streamedResponse.body.getReader();
  const streamedInitial = new TextDecoder().decode((await streamedReader.read()).value);
  assert(streamedInitial === ": connected\n\n", "streamed tool call did not prime the client with a non-message frame before completion");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: streamedRelay.id, ok: true, result: { streamed: true } }));
  const streamedResult = await readSseJsonRpcResponse(streamedReader, streamedInitial);
  assert(streamedResult.result?.structuredContent?.streamed === true, "streamed tool call lost the terminal result");

  const disconnectedHttpRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const disconnectedHttpController = new AbortController();
  const disconnectedHttpFetch = fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(ownerAccessToken, primarySession),
    signal: disconnectedHttpController.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 878, method: "tools/call", params: { name: "list_dir", arguments: { path: "." } } }),
  }).catch((error) => error);
  const disconnectedHttpRelay = await disconnectedHttpRelayPromise;
  disconnectedHttpController.abort();
  await disconnectedHttpFetch;
  await sleep(50);
  const disconnectedHttpStatus = await callServerInfo(base, ownerAccessToken, 8780);
  assert(disconnectedHttpStatus.worker?.pending_calls?.active === 1, "HTTP disconnect incorrectly cancelled the MCP operation");
  assert(disconnectedHttpStatus.worker?.pending_calls?.request_keys === 1, "HTTP disconnect removed the explicit-cancellation request key");
  const disconnectedHttpCancelNotice = waitForWsMessage(candidateDaemon, "cancel_call", 10_000, "HTTP-disconnect cleanup cancellation");
  const disconnectedHttpCancellation = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(ownerAccessToken, primarySession),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 878, reason: "explicit cleanup after HTTP disconnect" } }),
  });
  assert(disconnectedHttpCancellation.status === 202, "explicit cancellation after HTTP disconnect failed");
  assert((await disconnectedHttpCancelNotice).id === disconnectedHttpRelay.id, "explicit cancellation after HTTP disconnect targeted the wrong daemon call");

  const firstWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const firstWindowCall = toolCallRequest(base, ownerAccessToken, primarySession, 880, "list_dir", { path: "." });
  const firstWindowRelay = await firstWindowRelayPromise;
  const secondWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const secondWindowCall = toolCallRequest(base, ownerAccessToken, secondarySession, 880, "list_dir", { path: "." });
  const secondWindowRelay = await secondWindowRelayPromise;
  assert(firstWindowRelay.id !== secondWindowRelay.id, "two MCP sessions reused an internal daemon call id");
  const concurrentStatus = await callServerInfo(base, ownerAccessToken, 8810);
  assert(concurrentStatus.worker?.pending_calls?.active === 2, "Worker did not retain two concurrent session calls");
  assert(concurrentStatus.worker?.pending_calls?.request_keys === 2, "Worker did not index concurrent calls by isolated session");
  assert(concurrentStatus.worker?.pending_calls?.by_tool?.list_dir === 2, "pending-call diagnostics omitted concurrent tool counts");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: secondWindowRelay.id, ok: true, result: { window: "second" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: firstWindowRelay.id, ok: true, result: { window: "first" } }));
  const [firstWindowResult, secondWindowResult] = await Promise.all([firstWindowCall, secondWindowCall]);
  assert(firstWindowResult.body.result?.structuredContent?.window === "first", "first MCP session received another session's result");
  assert(secondWindowResult.body.result?.structuredContent?.window === "second", "second MCP session received another session's result");

  const reconnectRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reconnectCall = toolCallRequest(base, ownerAccessToken, primarySession, 8801, "list_dir", { path: "." });
  const reconnectRelay = await reconnectRelayPromise;
  const disconnectedCandidate = candidateDaemon;
  const disconnectedCandidateClosed = waitForWsClose(disconnectedCandidate);
  disconnectedCandidate.terminate();
  await disconnectedCandidateClosed;
  const detachedStatus = await callServerInfo(base, ownerAccessToken, 8802);
  assert(detachedStatus.worker?.pending_calls?.active === 1, "transient daemon disconnect lost the pending MCP request");
  assert(detachedStatus.worker?.pending_calls?.detached === 1, "pending request was not marked detached during reconnect grace");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const resumedCalls = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(resumedCalls.ids.length === 1 && resumedCalls.ids[0] === reconnectRelay.id, "Worker did not authorize exactly the detached call during reconnect");
  const reboundStatus = await callServerInfo(base, ownerAccessToken, 8803);
  assert(reboundStatus.worker?.pending_calls?.active === 1, "same daemon instance reconnect did not retain the pending request");
  assert(reboundStatus.worker?.pending_calls?.detached === 0, "same daemon instance reconnect did not rebind the pending request");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: reconnectRelay.id, ok: true, result: { resumed: true } }));
  const reconnectResult = await reconnectCall;
  assert(reconnectResult.body.result?.structuredContent?.resumed === true, "MCP request did not complete after same-instance daemon reconnect");

  const cancelledReconnectRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const cancelledReconnectCall = toolCallRequest(base, ownerAccessToken, primarySession, 8804, "list_dir", { path: "." });
  await cancelledReconnectRelayPromise;
  const cancelledReconnectSocket = candidateDaemon;
  const cancelledReconnectClosed = waitForWsClose(cancelledReconnectSocket);
  cancelledReconnectSocket.terminate();
  await cancelledReconnectClosed;
  const cancelledWhileDetached = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(ownerAccessToken, primarySession),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8804, reason: "cancel during relay interruption" } }),
  });
  assert(cancelledWhileDetached.status === 202, "detached-call cancellation notification failed");
  const cancelledReconnectResult = await cancelledReconnectCall;
  assert(cancelledReconnectResult.body.result?.isError === true
    && JSON.stringify(cancelledReconnectResult.body.result).includes("cancelled"), "detached call did not settle as cancelled");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const postCancelResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(postCancelResume.ids.length === 0, "same-instance reconnect attempted to resume a request cancelled while detached");

  const sessionlessFirstRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const sessionlessFirst = toolCallRequest(base, ownerAccessToken, "", 881, "list_dir", { path: "." });
  const sessionlessFirstRelay = await sessionlessFirstRelayPromise;
  const sessionlessSecondRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const sessionlessSecond = toolCallRequest(base, ownerAccessToken, "", 881, "list_dir", { path: "." });
  const sessionlessSecondRelay = await sessionlessSecondRelayPromise;
  const sessionlessStatus = await callServerInfo(base, ownerAccessToken, 8811);
  assert(sessionlessStatus.worker?.pending_calls?.active === 2 && sessionlessStatus.worker?.pending_calls?.request_keys === 0, "sessionless independent POST requests shared a token-level request-id lock");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: sessionlessFirstRelay.id, ok: true, result: { request: "one" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: sessionlessSecondRelay.id, ok: true, result: { request: "two" } }));
  await Promise.all([sessionlessFirst, sessionlessSecond]);

  const cancelFirstRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const cancelFirstCall = toolCallRequest(base, ownerAccessToken, primarySession, 882, "list_dir", { path: "." });
  const cancelFirstRelay = await cancelFirstRelayPromise;
  const cancelSecondRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const cancelSecondCall = toolCallRequest(base, ownerAccessToken, secondarySession, 882, "list_dir", { path: "." });
  const cancelSecondRelay = await cancelSecondRelayPromise;
  const isolatedCancelNotice = waitForWsMessage(candidateDaemon, "cancel_call", 10_000, "session-isolated cancellation");
  const isolatedCancellation = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(ownerAccessToken, primarySession),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 882, reason: "cancel first window only" } }),
  });
  assert(isolatedCancellation.status === 202, "session-scoped cancellation notification failed");
  assert((await isolatedCancelNotice).id === cancelFirstRelay.id, "session-scoped cancellation targeted the wrong window");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: cancelSecondRelay.id, ok: true, result: { window: "still-running" } }));
  const [cancelFirstResult, cancelSecondResult] = await Promise.all([cancelFirstCall, cancelSecondCall]);
  assert(cancelFirstResult.body.result?.isError === true && JSON.stringify(cancelFirstResult.body.result).includes("cancelled"), "cancelled session did not settle as cancelled");
  assert(cancelSecondResult.body.result?.structuredContent?.window === "still-running", "cancelling one MCP session interrupted another session");

  const duplicateRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const duplicateOriginal = toolCallRequest(base, ownerAccessToken, primarySession, 883, "list_dir", { path: "." });
  const duplicateRelay = await duplicateRelayPromise;
  const duplicateRequest = await toolCallRequest(base, ownerAccessToken, primarySession, 883, "list_dir", { path: "." });
  assert(duplicateRequest.body.result?.isError === true && JSON.stringify(duplicateRequest.body.result).includes("MCP session"), "same-session duplicate request id was not rejected precisely");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: duplicateRelay.id, ok: true, result: { original: true } }));
  assert((await duplicateOriginal).body.result?.structuredContent?.original === true, "same-session duplicate corrupted the original call");

  const initializedWithDaemonPromise = fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 251,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration-reinitialize", version: "1" } },
    }),
  });
  const bootstrapCall = await waitForWsMessage(candidateDaemon, "tool_call");
  assert(bootstrapCall.tool === "session_bootstrap", "Worker did not request local session bootstrap during initialize");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: bootstrapCall.id, ok: true, result: { instructions: "worker injected global model instructions" } }));
  const initializedWithDaemon = await initializedWithDaemonPromise;
  assert(initializedWithDaemon.body.result?.instructions?.includes("worker injected global model instructions"), "Worker initialize did not append daemon session instructions");

  const idlessToolCall = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "server_info", arguments: {} } }),
  });
  assert(idlessToolCall.response.status === 200 && idlessToolCall.body.error?.code === -32600, "Worker accepted tools/call without a request id");

  const activeTools = await callToolsList(base, ownerAccessToken, 26);
  assert(activeTools.some((tool) => tool.name === "server_info"), "active tool list omitted server_info");
  assert(activeTools.some((tool) => tool.name === "list_dir"), "active tool list omitted daemon-advertised tool");
  assert(activeTools.some((tool) => tool.name === "session_bootstrap"), "active tool list omitted session bootstrap");
  assert(!activeTools.some((tool) => tool.name === "read_file"), "active tool list retained a replaced daemon tool");
  assert(activeTools.find((tool) => tool.name === "list_dir")?.annotations?.readOnlyHint === true, "tool annotations were not returned");

  const reviewerTools = await callToolsList(base, reviewerToken, 27);
  assert(reviewerTools.some((tool) => tool.name === "list_dir"), "reviewer could not access a read-only daemon tool");
  assert(!reviewerTools.some((tool) => tool.name === "run_process"), "reviewer was shown a process-execution tool");

  const reviewerDenied = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewerToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 271, method: "tools/call", params: { name: "run_process", arguments: { argv: ["true"] } } }),
  });
  assert(reviewerDenied.body.result?.isError === true, "reviewer process execution was not rejected");
  assert(JSON.stringify(reviewerDenied.body.result).includes("not allowed for this account role"), "reviewer denial returned the wrong reason");

  const reviewerReadPromise = fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewerToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 272, method: "tools/call", params: { name: "list_dir", arguments: { path: "." } } }),
  });
  const reviewerRelay = await waitForWsMessage(candidateDaemon, "tool_call");
  assert(reviewerRelay.authorization?.role === "reviewer", "reviewer role was not forwarded to the daemon");
  assert(reviewerRelay.authorization?.account_id === reviewerAccount.body.account.account_id, "reviewer account id was not forwarded to the daemon");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: reviewerRelay.id, ok: true, result: { entries: [] } }));
  const reviewerRead = await reviewerReadPromise;
  assert(reviewerRead.body.result?.isError === false, "reviewer read-only call failed");

  const remoteImageCall = fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 76, method: "tools/call", params: { name: "view_image", arguments: { path: "pixel.png" } } }),
  });
  const relayedImageCall = await waitForWsMessage(candidateDaemon, "tool_call");
  assert(relayedImageCall.tool === "view_image", "Worker relayed the wrong rich-content tool");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: relayedImageCall.id,
    ok: true,
    result: {
      $mcp: {
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        structuredContent: { path: "pixel.png", size: 8, mime_type: "image/png" },
      },
    },
  }));
  const remoteImage = await remoteImageCall;
  assert(remoteImage.response.status === 200, "rich image tools/call failed");
  assert(remoteImage.body.result?.content?.[0]?.type === "image", "Worker flattened native MCP image content");
  assert(remoteImage.body.result?.structuredContent?.path === "pixel.png", "Worker omitted rich structuredContent");
  assert(!JSON.stringify(remoteImage.body.result).includes("$mcp"), "Worker leaked the internal rich-result envelope");

  const relayTimeoutCall = fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 75, method: "tools/call", params: { name: "run_process", arguments: { argv: ["never-runs"], timeout_seconds: 1 } } }),
  });
  const timedRelay = await waitForWsMessage(candidateDaemon, "tool_call");
  assert(timedRelay.tool === "run_process", "Worker did not relay timeout test call");
  const relayTimeoutCancel = await waitForWsMessage(candidateDaemon, "cancel_call", 10_000);
  assert(relayTimeoutCancel.id === timedRelay.id, "Worker timeout cancellation targeted the wrong daemon call");
  const relayTimeoutResult = await relayTimeoutCall;
  assert(relayTimeoutResult.response.status === 200, "timed-out tools/call did not settle cleanly");
  assert(relayTimeoutResult.body.result?.isError === true, "timed-out tools/call was not marked as an error");
  assert(JSON.stringify(relayTimeoutResult.body.result).includes("timed out"), "timed-out tools/call returned the wrong error");

  const remoteCall = fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": primarySession,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "list_dir", arguments: { path: "." } } }),
  });
  const relayedCall = await waitForWsMessage(candidateDaemon, "tool_call");
  assert(relayedCall.tool === "list_dir", "Worker relayed the wrong tool");
  const cancelNotice = waitForWsMessage(candidateDaemon, "cancel_call", 10_000, "ordinary explicit cancellation");
  const cancelled = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": primarySession,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 77, reason: "integration test" } }),
  });
  assert(cancelled.status === 202, `cancellation notification returned ${cancelled.status}`);
  const cancelledRelay = await cancelNotice;
  assert(cancelledRelay.id === relayedCall.id, "Worker cancellation targeted the wrong daemon call");
  const cancelledResult = await remoteCall;
  assert(cancelledResult.response.status === 200, "cancelled tools/call did not settle cleanly");
  assert(cancelledResult.body.result?.isError === true, "cancelled tools/call was not marked as an error");
  assert(JSON.stringify(cancelledResult.body.result).includes("cancelled"), "cancelled tools/call returned the wrong error");

  const demoteLastOwner = await stableFetch(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: ownerAccount.body.account.account_id, role: "reviewer",
  }));
  assert(demoteLastOwner.status === 409, "last active owner could be demoted");

  const reviewerRoleChange = await fetchJson(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: reviewerAccount.body.account.account_id, role: "editor",
  }));
  assert(reviewerRoleChange.response.status === 200, "reviewer role change failed");
  const revokedReviewer = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 273, method: "ping", params: {} }),
  });
  assert(revokedReviewer.status === 401, "role change did not revoke the changed account token");
  const revokedReviewerRefresh = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: reviewerRefreshToken,
      client_id: reviewerRegistration.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(revokedReviewerRefresh.response.status === 400 && revokedReviewerRefresh.body.error === "invalid_grant", "role change did not revoke the changed account refresh token");
  const ownerAfterReviewerChange = await callServerInfo(base, ownerAccessToken, 274);
  assert(ownerAfterReviewerChange.account?.role === "owner", "another account change invalidated the owner token");
  assert(ownerAfterReviewerChange.authorization.execution_model.owner_ambient_authority === "daemon_os_user", "owner server_info omitted daemon OS-user ambient authority");
  assert(ownerAfterReviewerChange.authority_summary?.includes("daemon OS user"), "owner authority summary hid ambient authority");

  for (let index = 0; index < 5; index += 1) {
    const extraRegistration = await stableFetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `Quota Client ${index}`, redirect_uris: [redirectUri] }),
    });
    assert(extraRegistration.status === 200, `pending-registration quota rejected client ${index + 1} too early`);
  }
  const registrationOverflow = await stableFetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Quota Overflow", redirect_uris: [redirectUri] }),
  });
  assert(registrationOverflow.status === 429, "per-source pending-registration quota was not enforced");

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const failedLogin = await stableFetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: `invalid_attempt_${String(attempt).padStart(2, "0")}${"D".repeat(41)}` }),
      redirect: "manual",
    });
    const expectedStatus = attempt === 10 ? 429 : 401;
    assert(failedLogin.status === expectedStatus, `password throttling attempt ${attempt} returned ${failedLogin.status}`);
  }
  const blockedLogin = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: OWNER_PASSWORD }),
    redirect: "manual",
  });
  assert(blockedLogin.status === 429, "blocked source could immediately retry with the correct password");

  const fullDaemon = await connectDaemon(base);
  daemonSockets.push(fullDaemon);
  await sendDaemonHello(fullDaemon, ["project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"], {
    profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell",
    unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true,
  });
  const editorStatus = await callServerInfo(base, editorToken, 275);
  assert(editorStatus.account?.account_id === editorAccount.body.account.account_id && editorStatus.account?.role === "editor", "server_info reported the wrong authenticated editor account");
  assert(editorStatus.daemon?.policy?.profile === "full", "full daemon ceiling was not preserved");
  assert(editorStatus.daemon?.policy_scope === "daemon_capability_ceiling_not_account_authority", "daemon policy scope remained ambiguous");
  assert(editorStatus.tool_delivery?.full_profile_scope === "daemon-capability-ceiling-before-account-filtering", "full-profile delivery scope remained ambiguous");
  assert(editorStatus.authorization?.account_policy?.profile === "edit", "editor account policy was not reported");
  assert(editorStatus.authorization?.effective_policy?.profile === "edit", "editor effective policy was incorrectly reported as full");
  assert(editorStatus.authorization?.effective_profile_is_full === false, "editor was marked as full authority");
  assert(editorStatus.authorization?.effective_tools?.includes("write_file"), "editor effective tools omitted deterministic mutation");
  assert(!editorStatus.authorization?.effective_tools?.includes("exec_command"), "editor effective tools exposed shell execution");
  assert(!editorStatus.authorization?.effective_tools?.includes("browser_action"), "editor effective tools exposed browser authority");
  assert(JSON.stringify(editorStatus.tools) === JSON.stringify(editorStatus.authorization.effective_tools), "top-level tools diverged from authoritative effective tools");
  assert(editorStatus.authority_summary?.includes("not this account's permission"), "authority summary did not reject the daemon-policy misinterpretation");
  assert(editorStatus.authority_summary?.includes("without a per-operation prompt"), "authority summary hid automatic execution semantics");
  assert(editorStatus.authorization.execution_model.within_effective_authority === "automatic_without_per_operation_prompt", "server_info omitted the automatic execution model");
  assert(editorStatus.authorization.execution_model.owner_ambient_authority === "not_owner", "delegated account was mislabeled as owner ambient authority");

  const editorOverviewPromise = toolCallRequest(base, editorToken, "", 276, "project_overview", {});
  const editorOverviewRelay = await waitForWsMessage(fullDaemon, "tool_call");
  assert(editorOverviewRelay.authorization?.role === "editor", "project_overview did not relay the editor role");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: editorOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "",
      policy: { profile: "custom", origin: "effective", revision: 5, allowWrite: true, allowExec: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      topLevel: [],
    },
  }));
  const editorOverview = (await editorOverviewPromise).body.result?.structuredContent;
  assert(editorOverview?.policy?.profile === "edit", "remote project_overview exposed the daemon full policy as editor authority");
  assert(editorOverview?.daemonPolicy?.profile === "full", "remote project_overview lost the daemon capability ceiling");
  assert(editorOverview?.tools?.includes("write_file") && !editorOverview?.tools?.includes("exec_command") && !editorOverview?.tools?.includes("browser_action"), "remote project_overview did not expose editor-effective tools");
  assert(editorOverview?.daemonTools?.includes("exec_command") && editorOverview?.daemonTools?.includes("browser_action"), "remote project_overview did not preserve daemon-advertised tools separately");
  assert(editorOverview?.policyScope === "authenticated_account_effective_authority", "remote project_overview policy scope remained ambiguous");

  const duplicateHelloDaemon = await connectDaemon(base);
  daemonSockets.push(duplicateHelloDaemon);
  await sendDaemonHello(duplicateHelloDaemon, ["list_dir"]);
  const duplicateHelloNotice = waitForWsMessage(duplicateHelloDaemon, "error");
  const duplicateHelloClosed = waitForWsClose(duplicateHelloDaemon);
  duplicateHelloDaemon.send(JSON.stringify({ type: "hello", tools: ["list_dir"], policy: {} }));
  assert((await duplicateHelloNotice).error === "duplicate_hello", "duplicate daemon hello returned the wrong protocol error");
  assert((await duplicateHelloClosed).code === 1002, "duplicate daemon hello did not close with protocol-error status");

  const unknownMessageDaemon = await connectDaemon(base);
  daemonSockets.push(unknownMessageDaemon);
  await sendDaemonHello(unknownMessageDaemon, ["list_dir"]);
  const unknownMessageNotice = waitForWsMessage(unknownMessageDaemon, "error");
  const unknownMessageClosed = waitForWsClose(unknownMessageDaemon);
  unknownMessageDaemon.send(JSON.stringify({ type: "future_daemon_message" }));
  assert((await unknownMessageNotice).error === "unknown_message_type", "unknown daemon message returned the wrong protocol error");
  assert((await unknownMessageClosed).code === 1002, "unknown daemon message did not close with protocol-error status");

  assert(!logs.includes("Uncaught TypeError"), "wrangler reported an uncaught runtime TypeError");
  console.log("worker OAuth/MCP integration test ok");
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n--- wrangler output ---\n${logs}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of daemonSockets) {
    try { socket.close(1000, "test complete"); } catch {}
  }
  terminate(child, "SIGTERM");
  await Promise.race([closed, sleep(3000)]);
  terminate(child, "SIGKILL");
  await rm(persistDir, { recursive: true, force: true }).catch(() => {});
}

async function registerTestClient({ base, redirectUri, name }) {
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  });
  assert(registration.response.status === 200, `test client registration failed: ${registration.response.status}`);
  return registration.body;
}

async function issueAccountToken({ base, clientId, redirectUri, accountName, password, state }) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "machine-bridge-mcp",
    resource: `${base}/mcp`,
    state,
    account_name: accountName,
    account_password: password,
  };
  const approved = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(authorization),
    redirect: "manual",
  });
  assert(approved.status === 303, `account authorization failed: ${approved.status}`);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  assert(code, "account authorization omitted code");
  const token = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(token.response.status === 200, `account token exchange failed: ${token.response.status}`);
  assert(typeof token.body.access_token === "string", "account token exchange omitted access_token");
  assert(typeof token.body.refresh_token === "string", "account token exchange omitted refresh_token");
  return { accessToken: token.body.access_token, refreshToken: token.body.refresh_token };
}

async function connectDaemon(origin, headers = createDaemonPreflightHeaders(
  DAEMON_SESSION_IDENTITY,
  origin,
  "machine-bridge-mcp",
  pkg.version,
)) {
  const wsUrl = `${origin.replace(/^http/, "ws")}/daemon/ws`;
  const socket = new WebSocket(wsUrl, { headers });
  const welcome = waitForWsMessage(socket, "welcome");
  await withTimeout(new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  }), 5000, "daemon websocket open");
  socket.mbmWelcome = await welcome;
  return socket;
}


async function rejectedDaemonUpgradeStatus(origin, headers) {
  const wsUrl = `${origin.replace(/^http/, "ws")}/daemon/ws`;
  return withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers });
    let settled = false;
    socket.once("unexpected-response", (_request, response) => {
      settled = true;
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      socket.close();
      if (!settled) reject(new Error("replayed daemon preflight unexpectedly upgraded"));
    });
    socket.once("error", (error) => {
      if (!settled) reject(error);
    });
  }), 5000, "replayed daemon preflight rejection");
}

async function sendDaemonHello(socket, tools, policy = defaultDaemonPolicy(), instanceId = nextDaemonInstanceId()) {
  const probe = await beginDaemonHello(socket, tools, policy, instanceId);
  return completeDaemonProbe(socket, probe);
}

async function beginDaemonHello(socket, tools, policy = defaultDaemonPolicy(), instanceId = nextDaemonInstanceId()) {
  const handshake = waitForWsMessageSequence(socket, ["hello_ack", "relay_probe"]);
  const authentication = await createDaemonAuthentication(DAEMON_SESSION_IDENTITY, socket.mbmWelcome, instanceId);
  socket.send(JSON.stringify({
    type: "hello",
    instance_id: instanceId,
    tools,
    policy,
    protocol_versions: ["2025-11-25"],
    authentication,
  }));
  const [, probe] = await handshake;
  assert(typeof probe.id === "string" && probe.id.startsWith("probe_"), "Worker readiness probe omitted a valid id");
  return probe;
}

async function completeDaemonProbe(socket, probe) {
  const ready = waitForWsMessageSequence(socket, ["resume_calls", "ready_ack"]);
  socket.send(JSON.stringify({ type: "relay_probe_result", id: probe.id }));
  const [resume] = await ready;
  assert(Array.isArray(resume.ids), "Worker resume_calls omitted its call-id array");
  return resume;
}

function nextDaemonInstanceId() {
  daemonInstanceSequence += 1;
  return `daemon_integration_${String(daemonInstanceSequence).padStart(6, "0")}`;
}

function defaultDaemonPolicy() {
  return { profile: "review", allowWrite: false, allowExec: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
}

function waitForWsMessageSequence(socket, expectedTypes, timeoutMs = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (data) => {
      try {
        const value = JSON.parse(String(data));
        const expected = expectedTypes[messages.length];
        if (value.type !== expected) throw new Error(`expected websocket message ${expected}, received ${value.type}`);
        messages.push(value);
        if (messages.length === expectedTypes.length) {
          cleanup();
          resolve(messages);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = (code) => { cleanup(); reject(new Error(`websocket closed before ${expectedTypes.join(", ")}: ${code}`)); };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  }), timeoutMs, `websocket message sequence ${expectedTypes.join(", ")}`);
}


function waitForWsMessage(socket, expectedType, timeoutMs = 5000, label = expectedType) {
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup();
      try {
        const value = JSON.parse(String(data));
        if (value.type !== expectedType) throw new Error(`expected websocket message ${expectedType}, received ${value.type}`);
        resolve(value);
      } catch (error) { reject(error); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = (code) => { cleanup(); reject(new Error(`websocket closed before ${expectedType}: ${code}`)); };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  }), timeoutMs, `websocket message ${label}`);
}

function waitForWsClose(socket, timeoutMs = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    socket.once("error", reject);
  }), timeoutMs, "daemon close");
}

function tamperSessionId(value) {
  const signatureStart = value.lastIndexOf("_") + 1;
  const replacement = value[signatureStart] === "A" ? "B" : "A";
  return `${value.slice(0, signatureStart)}${replacement}${value.slice(signatureStart + 1)}`;
}

function mcpHeaders(accessToken, sessionId = "") {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "mcp-protocol-version": "2025-11-25",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

function toolCallRequest(origin, accessToken, sessionId, id, name, argumentsValue) {
  return fetchJson(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } }),
  });
}

async function callServerInfo(origin, accessToken, id) {
  const response = await fetchJson(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "server_info", arguments: {} } }),
  });
  assert(response.response.status === 200, `server_info call failed: ${response.response.status}`);
  const text = response.body.result?.content?.[0]?.text;
  const structured = response.body.result?.structuredContent;
  assert(typeof text === "string", "server_info result did not contain text");
  assert(structured && typeof structured === "object", "server_info result omitted structuredContent");
  assert(JSON.stringify(structured) === JSON.stringify(JSON.parse(text)), "server_info text and structuredContent diverged");
  return structured;
}

async function callToolsList(origin, accessToken, id) {
  const response = await fetchJson(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  assert(response.response.status === 200, `tools/list failed: ${response.response.status}`);
  assert(Array.isArray(response.body.result?.tools), "tools/list did not return an array");
  return response.body.result.tools;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForWorker(origin, processHandle, closedPromise) {
  let consecutiveHealthy = 0;
  let latestBody = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      const result = await closedPromise;
      throw new Error(`wrangler exited before readiness: ${JSON.stringify(result)}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        latestBody = await response.json();
        consecutiveHealthy += 1;
        if (consecutiveHealthy >= 3) {
          await sleep(200);
          return latestBody;
        }
      } else {
        consecutiveHealthy = 0;
      }
    } catch {
      consecutiveHealthy = 0;
    }
    await sleep(150);
  }
  throw new Error(`wrangler dev did not become stably ready within 30s (exitCode=${processHandle.exitCode}, signalCode=${processHandle.signalCode})`);
}


function adminRequest(method, pathname, body) {
  const serializedBody = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    headers: {
      ...accountAdminRequestHeaders({
        sessionIdentity: DAEMON_SESSION_IDENTITY,
        origin: new URL(base).origin,
        method,
        pathname,
        body: serializedBody,
      }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : serializedBody,
  };
}

async function stableFetch(url, options = {}, attempts = 3) {
  let lastResponse;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      if (response.status !== 503 || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await sleep(100 * attempt);
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error("fetch failed without a response");
}

async function readSseJsonRpcResponse(reader, initialText = "") {
  const decoder = new TextDecoder();
  let text = initialText;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data: "));
  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(dataLines[index].slice(6)); } catch {}
  }
  throw new Error(`SSE response omitted a JSON-RPC message: ${text.slice(0, 512)}`);
}

async function fetchJson(url, options) {
  const response = await stableFetch(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body };
}

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portValue = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(portValue));
    });
  });
}

function terminate(processHandle, signal) {
  if (!processHandle?.pid || processHandle.exitCode !== null) return;
  try {
    if (process.platform === "win32") processHandle.kill(signal);
    else process.kill(-processHandle.pid, signal);
  } catch {
    try { processHandle.kill(signal); } catch {}
  }
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function cspDirectiveSources(policy, directiveName) {
  for (const directive of String(policy || "").split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === directiveName) return new Set(tokens.slice(1));
  }
  return new Set();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
