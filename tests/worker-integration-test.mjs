import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createDaemonAuthentication, createDaemonPreflightHeaders, createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { createDaemonHttpRelayHeaders } from "../src/local/daemon-http-relay-auth.mjs";
import { accountAdminRequestHeaders } from "../src/local/account-admin.mjs";
import { workerToolsForRole } from "../src/worker/worker-tool-authority.ts";
import serverMetadata from "../src/shared/server-metadata.json" with { type: "json" };
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../src/worker/mcp-subscription-contract.ts";
import { runOfficialMcpConformance } from "../scripts/official-mcp-conformance.mjs";

let daemonInstanceSequence = 0;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const TOOL_SCHEMA_GENERATION = Number(serverMetadata.toolSchemaGeneration);
const WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS = 10_000;
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
const activeHttpRequests = new Set();
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
  assert(publicMetadata.body.protocolVersion === "2026-07-28", "public MCP metadata omitted the current protocol version");
  assert(JSON.stringify(publicMetadata.body.protocolVersions) === JSON.stringify(["2026-07-28"]),
    "public MCP metadata advertised a removed protocol version");
  assert(!("protocolEras" in publicMetadata.body), "public MCP metadata retained a removed protocol-era taxonomy");
  assert(publicMetadata.body.transport?.type === "streamable-http", "public MCP metadata did not advertise Streamable HTTP");
  assert(JSON.stringify(publicMetadata.body.transport?.initializationCompatibility?.protocolVersions)
      === JSON.stringify(["2025-11-25", "2025-06-18"])
      && publicMetadata.body.transport?.initializationCompatibility?.sessionless === true,
  "public MCP metadata omitted the bounded stateless initialization compatibility surface");
  assert(!Object.hasOwn(publicMetadata.body.transport ?? {}, "protocolSessions")
    && !Object.hasOwn(publicMetadata.body.transport ?? {}, "resumableSse")
    && JSON.stringify(publicMetadata.body.transport?.methods) === JSON.stringify(["POST"]),
  "public MCP metadata retained removed session/resumability flags or GET semantics");
  const authorizationMetadata = await fetchJson(`${base}/.well-known/oauth-authorization-server/mcp`);
  assert(authorizationMetadata.response.status === 200, "OAuth authorization-server discovery failed");
  assert(authorizationMetadata.body.grant_types_supported?.includes("refresh_token"), "OAuth metadata omitted refresh-token support");
  assert(authorizationMetadata.body.scopes_supported?.includes("offline_access"), "OAuth metadata omitted offline_access");
  assert(authorizationMetadata.body.authorization_response_iss_parameter_supported === true,
    "OAuth authorization-server metadata did not advertise RFC 9207 issuer responses");
  const protectedResourceMetadata = await fetchJson(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert(protectedResourceMetadata.response.status === 200, "OAuth protected-resource discovery failed");
  assert(protectedResourceMetadata.body.resource === `${base}/mcp`, "protected-resource metadata changed the MCP resource");
  assert(protectedResourceMetadata.body.authorization_servers?.[0] === base, "protected-resource metadata changed the authorization server");
  assert(!protectedResourceMetadata.body.scopes_supported?.includes("offline_access"),
    "protected-resource metadata advertised refresh-token policy as a resource scope");
  const unauthenticatedMcpDiscovery = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  assert(unauthenticatedMcpDiscovery.status === 401, "unauthenticated MCP discovery request did not return 401");
  for (const mode of ["poll", "subscribe"]) {
    const removedInternalStream = await stableFetch(`${base}/mcp`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "x-machine-bridge-internal-mcp-stream-mode": mode,
        "x-machine-bridge-internal-mcp-stream-id": `stream_${"S".repeat(43)}`,
      },
    });
    assert(removedInternalStream.status === 405,
      `removed internal-stream ${mode} mode was still recognized as an MCP delivery path`);
  }
  const spoofedCurrentControl = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "server/discover",
      "x-machine-bridge-internal-mcp-stream-mode": "cancel",
      "x-machine-bridge-internal-mcp-stream-id": `stream_${"S".repeat(43)}`,
    },
    body: JSON.stringify(currentMcpRequest(0, "server/discover", {})),
  });
  assert(spoofedCurrentControl.status === 401,
    "caller-supplied current internal-stream control headers bypassed MCP authorization");
  assert(
    unauthenticatedMcpDiscovery.headers.get("www-authenticate") === `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="machine-bridge-mcp"`,
    "unauthenticated MCP response omitted the protected-resource discovery or minimum-scope challenge",
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
  for (const origin of ["https://example.com", "null"]) {
    const rejectedMcpOrigin = await stableFetch(`${base}/mcp`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }),
    });
    assert(rejectedMcpOrigin.status === 403, `invalid MCP Origin was not rejected before authentication: ${origin}`);
    assert((await rejectedMcpOrigin.json()).error === "origin_not_allowed", `invalid MCP Origin returned the wrong error: ${origin}`);
  }
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
  for (const origin of ["https://chatgpt.com", "https://grok.com", "https://x.com"]) {
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
  const allowedHeaders = preflight.headers.get("access-control-allow-headers") || "";
  const allowedHeaderNames = allowedHeaders.split(/,\s*/);
  for (const requiredHeader of ["authorization", "dpop", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
    assert(allowedHeaderNames.includes(requiredHeader), `MCP CORS preflight omitted ${requiredHeader}`);
  }
  for (const removedHeader of ["last-event-id", "mcp-session-id"]) {
    assert(!allowedHeaderNames.includes(removedHeader), `MCP CORS preflight still advertised removed ${removedHeader}`);
  }
  const corsHealth = await stableFetch(`${base}/healthz`, { headers: { origin: "http://localhost:3001" } });
  assert(corsHealth.status === 200, "configured browser origin could not access health endpoint");
  assert(corsHealth.headers.get("access-control-allow-origin") === "http://localhost:3001", "actual response omitted CORS origin");

  const unauthenticatedAdmin = await stableFetch(`${base}/admin/accounts`);
  assert(unauthenticatedAdmin.status === 401, "account administration accepted an unauthenticated request");
  const removedBearerAdmin = await stableFetch(`${base}/admin/accounts`, {
    headers: { authorization: "Bearer integration-admin-secret" },
  });
  assert(removedBearerAdmin.status === 401, "account administration still accepted the long-lived bearer protocol");
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
  const chatGptRedirectUri = "https://chatgpt.com/connector/oauth/integration-callback";
  const claudeRedirectUri = "https://claude.ai/api/mcp/auth_callback";
  const copilotRedirectUri = "https://global.consent.azure-apim.net/redirect/machine-bridge-mcp-test";
  const consentLookalikeRedirectUri = "https://global.consent.azure-apim.net.example.com/callback";
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Integration\u202e <Client>\u200b", redirect_uris: [redirectUriInput, chatGptRedirectUri, claudeRedirectUri, copilotRedirectUri, consentLookalikeRedirectUri] }),
  });
  assert(registration.response.status === 201, `client registration failed: ${registration.response.status}`);
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
  assert(redirect.searchParams.get("iss") === base, "authorization redirect omitted or changed the RFC 9207 issuer");

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
  assert(chatGptRedirect.pathname === "/connector/oauth/integration-callback", "ChatGPT authorization redirect changed path");
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
  assert(token.response.headers.get("cache-control") === "no-store" && token.response.headers.get("pragma") === "no-cache",
    "OAuth token response omitted mandatory no-store/no-cache cache controls");
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
  assert(refreshed.response.headers.get("pragma") === "no-cache", "OAuth refresh response omitted Pragma: no-cache");
  assert(typeof refreshed.body.access_token === "string" && refreshed.body.access_token !== token.body.access_token, "refresh did not rotate the access token");
  assert(typeof refreshed.body.refresh_token === "string" && refreshed.body.refresh_token !== token.body.refresh_token, "refresh did not rotate the refresh token");
  assert(refreshed.body.expires_in === 900, "access-token lifetime was not reduced to 15 minutes");
  const concurrentRetry = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(concurrentRetry.response.status === 200
    && concurrentRetry.body.refresh_token === refreshed.body.refresh_token
    && concurrentRetry.body.access_token === refreshed.body.access_token,
  "bounded concurrent refresh retry did not reproduce the original replacement credentials");
  const familyRefreshAfterRetry = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(familyRefreshAfterRetry.response.status === 200, "concurrent refresh recovery incorrectly revoked the token family");
  let ownerAccessToken = familyRefreshAfterRetry.body.access_token;
  let ownerRefreshToken = familyRefreshAfterRetry.body.refresh_token;
  const conformanceCheckout = String(process.env.MBM_OFFICIAL_CONFORMANCE_CHECKOUT || "").trim();
  const conformanceScenarios = String(process.env.MBM_OFFICIAL_CONFORMANCE_SCENARIOS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (conformanceCheckout && conformanceScenarios.length > 0) {
    for (const scenario of conformanceScenarios) {
      const conformance = await runOfficialMcpConformance({
        checkout: conformanceCheckout,
        upstream: `${base}/mcp`,
        accessToken: ownerAccessToken,
        scenario,
        specVersion: "2026-07-28",
        timeoutMs: Number(process.env.MBM_OFFICIAL_CONFORMANCE_TIMEOUT_MS || 60_000),
        verbose: process.env.MBM_OFFICIAL_CONFORMANCE_VERBOSE === "1",
        expectedFailures: path.join(packageRoot, "tests", "mcp-conformance-baseline.yml"),
      });
      logs = appendBounded(logs, `\n--- official conformance ${scenario} ---\n${conformance.stdout}\n${conformance.stderr}`);
      if (conformance.code !== 0 && process.env.MBM_OFFICIAL_CONFORMANCE_ALLOW_FAILURE !== "1") {
        throw new Error(`official MCP conformance scenario failed: ${scenario}\n${conformance.stdout}\n${conformance.stderr}`);
      }
    }
  }
  const retainedFamilyAccess = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/list"),
    body: JSON.stringify(currentMcpRequest(99, "tools/list", {})),
  });
  assert(retainedFamilyAccess.status === 200, "concurrent refresh retry invalidated the replacement access token");
  const retainedFamilyTools = await retainedFamilyAccess.json();
  assert(retainedFamilyTools.result?.ttlMs === 0, "current tools/list still advertised a reusable cross-release schema cache");
  const retainedReadJob = retainedFamilyTools.result?.tools?.find((tool) => tool.name === "read_job");
  assert(retainedReadJob?.inputSchema?.properties?.wait_ms?.default === 40_000
    && retainedReadJob?.inputSchema?.properties?.wait_ms?.maximum === 60_000
    && retainedReadJob?.inputSchema?.required?.includes("recovery_key")
    && retainedReadJob?.inputSchema?.properties?.recovery_key?.pattern === "^mcp_jr_[A-Za-z0-9_-]{43}$"
    && String(retainedReadJob?.description || "").includes(`Tool schema generation ${TOOL_SCHEMA_GENERATION}.`)
    && String(retainedReadJob?.description || "").includes("server-side long-poll")
    && String(retainedReadJob?.description || "").includes("public wait_ms maximum of 60 seconds")
    && String(retainedReadJob?.description || "").includes("job_id alone is not remote read authority")
    && String(retainedReadJob?.description || "").includes("same assistant response")
    && String(retainedReadJob?.description || "").includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time")
    && !String(retainedReadJob?.description || "").includes("read an active job at most once"),
  "current tools/list omitted capability-bound paced read_job/schema-freshness guidance");

  const currentDiscovery = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "server/discover"),
    body: JSON.stringify(currentMcpRequest(9000, "server/discover", {})),
  });
  assert(currentDiscovery.response.status === 200, `current server/discover failed: ${currentDiscovery.response.status}`);
  assert(currentDiscovery.body.result?.resultType === "complete"
    && JSON.stringify(currentDiscovery.body.result?.supportedVersions) === JSON.stringify(["2026-07-28"]),
  "current discovery omitted resultType or advertised a removed protocol version");
  assert(currentDiscovery.body.result?.cacheScope === "public"
    && currentDiscovery.body.result?.ttlMs === 0
    && String(currentDiscovery.body.result?.instructions || "").includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time")
    && currentDiscovery.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version === pkg.version,
  "current discovery omitted non-cacheable continuation instructions or server identity metadata");
  assert(currentDiscovery.response.headers.get("mcp-session-id") === null, "current discovery minted a protocol session");

  const spoofedCurrentCancelHeaders = currentMcpHeaders(ownerAccessToken, "tools/list");
  spoofedCurrentCancelHeaders["x-machine-bridge-internal-mcp-stream-mode"] = "current-cancel";
  spoofedCurrentCancelHeaders["x-machine-bridge-internal-mcp-stream-id"] = `stream_${"S".repeat(43)}`;
  const spoofedCurrentCancel = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: spoofedCurrentCancelHeaders,
    body: JSON.stringify(currentMcpRequest(90001, "tools/list", {})),
  });
  assert(spoofedCurrentCancel.response.status === 200
    && Array.isArray(spoofedCurrentCancel.body.result?.tools),
  "public internal current-cancel headers reached the Durable Object control path");

  const currentMissingMethodHeaders = currentMcpHeaders(ownerAccessToken, "server/discover");
  delete currentMissingMethodHeaders["Mcp-Method"];
  const currentMissingMethod = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMissingMethodHeaders,
    body: JSON.stringify(currentMcpRequest(9001, "server/discover", {})),
  });
  assert(currentMissingMethod.response.status === 400 && currentMissingMethod.body.error?.code === -32020,
    "current request missing Mcp-Method did not fail with HeaderMismatch");

  const currentMissingBodyVersion = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "server/discover"),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 90011, method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
    }),
  });
  assert(currentMissingBodyVersion.response.status === 400 && currentMissingBodyVersion.body.error?.code === -32020,
    "current HTTP request missing body protocol version bypassed HeaderMismatch precedence");

  const currentWrongContentTypeHeaders = currentMcpHeaders(ownerAccessToken, "server/discover");
  currentWrongContentTypeHeaders["content-type"] = "text/plain; a=application/json";
  const currentWrongContentType = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentWrongContentTypeHeaders,
    body: JSON.stringify(currentMcpRequest(90012, "server/discover", {})),
  });
  assert(currentWrongContentType.response.status === 415 && currentWrongContentType.body.error?.code === -32600,
    "current HTTP request with a non-JSON media type did not fail with 415 Unsupported Media Type");
  const currentWrongContentTypeInvalidBody = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentWrongContentTypeHeaders,
    body: "not-json-at-all",
  });
  assert(currentWrongContentTypeInvalidBody.response.status === 415
    && currentWrongContentTypeInvalidBody.body.id === null
    && currentWrongContentTypeInvalidBody.body.error?.code === -32600,
  "current Content-Type validation ran after JSON parsing instead of before body materialization");

  const unsupportedCurrent = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/list", "", "1900-01-01"),
    body: JSON.stringify(currentMcpRequest(9002, "tools/list", {}, "1900-01-01")),
  });
  assert(unsupportedCurrent.response.status === 400 && unsupportedCurrent.body.error?.code === -32022,
    "current unsupported version did not use the protocol-defined error");
  assert(JSON.stringify(unsupportedCurrent.body.error?.data?.supported) === JSON.stringify(["2026-07-28"]),
    "current unsupported-version error advertised a removed protocol version");

  const currentGet = await stableFetch(`${base}/mcp`, {
    method: "GET",
    headers: { authorization: `Bearer ${ownerAccessToken}`, "MCP-Protocol-Version": "2026-07-28" },
  });
  assert(currentGet.status === 405 && currentGet.headers.get("allow") === "POST", "current MCP GET was not rejected");

  const currentToolsWithoutDaemon = await currentMcpCall(base, ownerAccessToken, 9003, "tools/list", {});
  assert(currentToolsWithoutDaemon.response.status === 200
    && currentToolsWithoutDaemon.body.result?.resultType === "complete"
    && currentToolsWithoutDaemon.body.result?.cacheScope === "private",
  "current tools/list omitted complete/private cache semantics");
  const currentUnavailable = await currentMcpCall(base, ownerAccessToken, 9004, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  assert(currentUnavailable.body.result?.resultType === "complete"
    && currentUnavailable.body.result?.isError === true
    && currentUnavailable.body.result?.structuredContent?.error?.code === "unavailable",
  "current tool call without a daemon did not fail closed inside a complete tool result");

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

  const legacyProtocolVersion = "2025-06-18";
  const compatibilityInitialize = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1000,
      method: "initialize",
      params: {
        protocolVersion: legacyProtocolVersion,
        capabilities: {},
        clientInfo: { name: "ChatGPT", version: "integration" },
      },
    }),
  });
  assert(compatibilityInitialize.response.status === 200
      && compatibilityInitialize.body.result?.protocolVersion === legacyProtocolVersion
      && compatibilityInitialize.body.result?.capabilities?.tools
      && compatibilityInitialize.body.result?.serverInfo?.name === "machine-bridge-mcp",
  "stateless initialization compatibility did not initialize the hosted MCP client");
  assert(compatibilityInitialize.response.headers.get("mcp-session-id") === null,
    "initialization compatibility minted a removed MCP session id");

  const compatibilityInitialized = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": legacyProtocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  assert(compatibilityInitialized.status === 202,
    "stateless initialization compatibility rejected notifications/initialized");

  const compatibilityTools = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": legacyProtocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1001, method: "tools/list", params: {} }),
  });
  assert(compatibilityTools.response.status === 200
      && compatibilityTools.body.result?.tools?.some((tool) => tool.name === "server_info")
      && compatibilityTools.response.headers.get("mcp-session-id") === null,
  "stateless initialization compatibility did not expose the authenticated tool list");

  const compatibilityToolCall = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${ownerAccessToken}`,
      "mcp-protocol-version": legacyProtocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1002, method: "tools/call", params: { name: "server_info", arguments: { detail: "summary" } },
    }),
  });
  assert(compatibilityToolCall.response.status === 200
      && compatibilityToolCall.response.headers.get("content-type")?.startsWith("application/json")
      && compatibilityToolCall.body.result?.isError === false,
  "stateless initialization compatibility did not execute a JSON tool call");

  const removedInitialize = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerAccessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "outdated-client", version: "1" } },
    }),
  });
  assert(removedInitialize.response.status === 400 && removedInitialize.body.error?.code === -32601
    && JSON.stringify(removedInitialize.body.error?.data?.supported) === JSON.stringify(["2026-07-28"]),
  "removed initialize flow did not return explicit current-version upgrade guidance");

  const removedSessionHeader = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...currentMcpHeaders(ownerAccessToken, "tools/list"),
      "mcp-session-id": "removed-session-protocol",
    },
    body: JSON.stringify(currentMcpRequest(2, "tools/list", {})),
  });
  assert(removedSessionHeader.response.status === 400 && removedSessionHeader.body.error?.code === -32601,
    "removed MCP session header was silently accepted");

  const unsupportedProtocol = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/list", "", "1900-01-01"),
    body: JSON.stringify(currentMcpRequest(3, "tools/list", {}, "1900-01-01")),
  });
  assert(unsupportedProtocol.response.status === 400, "unsupported MCP protocol header was accepted");
  assert(JSON.stringify(unsupportedProtocol.body.error?.data?.supported) === JSON.stringify(["2026-07-28"]),
    "unsupported protocol response advertised anything except the current version");

  const toolsWithoutDaemon = await callToolsList(base, ownerAccessToken, 3);
  const stableOwnerToolNames = workerToolsForRole("owner").map((tool) => tool.name).sort();
  assert(JSON.stringify(toolsWithoutDaemon.map((tool) => tool.name).sort()) === JSON.stringify(stableOwnerToolNames),
    "transient daemon absence changed the authenticated account tool catalog");
  const unavailableWithoutDaemon = await callTool(base, ownerAccessToken, 31, "list_dir", { path: "." });
  assert(unavailableWithoutDaemon.result?.isError === true
    && unavailableWithoutDaemon.result?.structuredContent?.error?.code === "unavailable",
  "stable catalog did not fail closed when the daemon was unavailable");

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
  const toolsWithDaemon = await callToolsList(base, ownerAccessToken, 20);
  assert(JSON.stringify(toolsWithDaemon.map((tool) => tool.name).sort()) === JSON.stringify(stableOwnerToolNames),
    "daemon connection changed the stable authenticated account tool catalog");
  const firstStatus = await callServerInfo(base, ownerAccessToken, 21);
  assert(firstStatus.daemon?.connected === true, "first daemon did not become active after hello");
  assert(firstStatus.daemon?.tools?.includes("read_file"), "first daemon tools were not advertised");
  assert(!firstStatus.daemon?.tools?.includes("write_file"), "review policy did not filter write_file");
  assert(!firstStatus.daemon?.tools?.includes("exec_command"), "review policy did not filter exec_command");
  assert(firstStatus.daemon?.readiness_verified === true, "first daemon was advertised before end-to-end readiness verification");
  assert(firstStatus.tool_delivery?.remote_managed_job_read_nonterminal_progress_minimum_ms === 30_000,
    "full server_info lost the hosted nonterminal progress coalescing contract");
  const compactFirstStatus = await callServerInfo(base, ownerAccessToken, 210, { detail: "summary" });
  assert(compactFirstStatus.detail === "summary" && compactFirstStatus.version === pkg.version
    && compactFirstStatus.authorization?.account?.role === "owner" && !("account_id" in compactFirstStatus.authorization.account)
    && compactFirstStatus.authorization?.effective_policy?.profile === "review"
    && compactFirstStatus.daemon?.connected === true && compactFirstStatus.daemon?.readiness_verified === true
    && compactFirstStatus.worker?.sockets_live?.ready === 1 && !("observability" in compactFirstStatus.worker)
    && !("remote_managed_job_read_nonterminal_progress_minimum_ms" in compactFirstStatus.tool_delivery)
    && !("oauth" in compactFirstStatus) && !("tools" in compactFirstStatus),
  "remote compact server_info lost authority/readiness state or retained cold-path fields");
  const compactFirstStatusJson = JSON.stringify(compactFirstStatus);
  assert(compactFirstStatusJson.length < JSON.stringify(firstStatus).length * 0.6,
    "remote compact server_info did not materially reduce the payload");
  // Current freshness adds bounded per-account subscription diagnostics; keep explicit headroom without dropping prior summary fields.
  assert(compactFirstStatusJson.length <= 2600,
    `remote compact server_info exceeded its hot-path output budget: ${compactFirstStatusJson.length} chars`);
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
  assert(firstStatus.tool_delivery?.remote_process_delivery_mode === "durable_job"
    && firstStatus.tool_delivery?.remote_process_acceptance_max_ms === 10_000
    && firstStatus.tool_delivery?.remote_process_execution_timeout_max_ms === 600_000
    && firstStatus.tool_delivery?.managed_job_resource_admission_wait_max_ms === 1_800_000
    && firstStatus.tool_delivery?.remote_managed_job_read_wait_default_ms === 40_000
    && firstStatus.tool_delivery?.remote_managed_job_read_wait_max_ms === 60_000
    && firstStatus.tool_delivery?.remote_process_session_start_execution_max_ms === 10_000
    && firstStatus.tool_delivery?.tool_schema_generation === TOOL_SCHEMA_GENERATION
    && firstStatus.tool_delivery?.tool_schema_server_version === firstStatus.version
    && firstStatus.tool_delivery?.discovery_ttl_ms === 0
    && firstStatus.tool_delivery?.tool_list_ttl_ms === 0
    && firstStatus.tool_delivery?.host_visible_schema_known_to_server === false
    && firstStatus.tool_delivery?.host_schema_refresh_required_on_generation_change === true
    && firstStatus.tool_delivery?.host_turn_deadline_observable === false
    && firstStatus.tool_delivery?.managed_jobs_detached_from_mcp_response === true
    && !("remote_process_foreground_execution_max_ms" in firstStatus.tool_delivery),
  "Worker server_info lost schema freshness evidence or the separated durable-process acceptance/execution contract");

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
  const candidateTools = ["session_bootstrap", "resolve_task_capabilities", "list_dir", "view_image", "run_process", "exec_command", "start_job", "read_job"];
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

  const currentAgentTools = await currentMcpCall(base, ownerAccessToken, 9100, "tools/list", {});
  assert(currentAgentTools.response.status === 200
    && currentAgentTools.body.result?.resultType === "complete"
    && currentAgentTools.body.result?.tools?.some((tool) => tool.name === "run_process"),
  "current tools/list did not expose the authenticated stable catalog");

  const currentRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const currentToolPromise = currentMcpCall(base, ownerAccessToken, 9101, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const currentRelay = await currentRelayPromise;
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: currentRelay.id, ok: true, result: { current: true } }));
  const currentTool = await currentToolPromise;
  assert(currentTool.response.status === 200
    && currentTool.body.result?.resultType === "complete"
    && currentTool.body.result?.structuredContent?.current === true
    && currentTool.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version === pkg.version,
  "current tools/call lost resultType, structured content, or server identity");
  assert(currentTool.response.headers.get("mcp-session-id") === null, "current tool call minted a removed session");

  const malformedMessages = captureWsMessageTypes(candidateDaemon);
  const malformedCurrentTool = await currentMcpCall(base, ownerAccessToken, 9107, "tools/call", {
    name: "list_dir", arguments: { path: ".", unexpected: "must-not-dispatch" },
  });
  assert(malformedCurrentTool.body.error?.code === -32602
    && malformedCurrentTool.body.error?.data?.validation_issues?.[0]?.instancePath === "/unexpected",
  "current malformed tool arguments were not returned as Invalid params");
  assert(!malformedMessages.stop().includes("tool_call"), "current malformed tool arguments reached the daemon");
  const unknownMessages = captureWsMessageTypes(candidateDaemon);
  const unknownCurrentTool = await currentMcpCall(base, ownerAccessToken, 9108, "tools/call", {
    name: "missing_tool", arguments: {},
  });
  assert(unknownCurrentTool.body.error?.code === -32602, "current unknown tool was not returned as Invalid params");
  assert(!unknownMessages.stop().includes("tool_call"), "current unknown tool reached the daemon");

  const mismatchMessages = captureWsMessageTypes(candidateDaemon);
  const mismatchedName = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "read_file"),
    body: JSON.stringify(currentMcpRequest(9102, "tools/call", { name: "list_dir", arguments: { path: "." } })),
  });
  assert(mismatchedName.response.status === 400 && mismatchedName.body.error?.code === -32020,
    "current Mcp-Name/body mismatch was accepted");
  assert(!mismatchMessages.stop().includes("tool_call"), "header mismatch reached the daemon");

  const initializeMessages = captureWsMessageTypes(candidateDaemon);
  const currentInitialize = await currentMcpCall(base, ownerAccessToken, 9109, "initialize", {});
  assert(currentInitialize.response.status === 400 && currentInitialize.body.error?.code === -32601
    && currentInitialize.body.error?.data?.supported?.length === 1
    && currentInitialize.body.error.data.supported[0] === "2026-07-28",
  "removed HTTP initialize did not return bounded current-version upgrade guidance");
  assert(!initializeMessages.stop().includes("tool_call"), "removed HTTP initialize reached the daemon");

  const removedPing = await currentMcpCall(base, ownerAccessToken, 9103, "ping", {});
  assert(removedPing.response.status === 404 && removedPing.body.error?.code === -32601,
    "current HTTP retained removed ping semantics");

  const invalidSubscription = await currentMcpCall(base, ownerAccessToken, 9111, "subscriptions/listen", {});
  assert(invalidSubscription.response.status === 400 && invalidSubscription.body.error?.code === -32602,
    "current HTTP accepted a subscription without notifications");

  const subscriptionAbort = new AbortController();
  const subscriptionResponse = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "subscriptions/listen"),
    body: JSON.stringify(currentMcpRequest(9104, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    })),
    signal: subscriptionAbort.signal,
  });
  const subscriptionReader = subscriptionResponse.body.getReader();
  const subscriptionMessages = await readSseJsonMessages(subscriptionReader, 2);
  assert(subscriptionResponse.status === 200
      && subscriptionResponse.headers.get("content-type")?.startsWith("text/event-stream"),
  "current HTTP subscription did not use its request-scoped SSE response");
  assert(subscriptionMessages.length === 2
      && subscriptionMessages[0].method === "notifications/subscriptions/acknowledged"
      && subscriptionMessages[0].params?.notifications?.toolsListChanged === true,
  "current HTTP subscription did not acknowledge the supported toolsListChanged notification");
  assert(subscriptionMessages[0].params?._meta?.["io.modelcontextprotocol/subscriptionId"] === 9104
      && subscriptionMessages[1].method === "notifications/tools/list_changed"
      && subscriptionMessages[1].params?._meta?.["io.modelcontextprotocol/subscriptionId"] === 9104,
  "current HTTP subscription did not emit a correlated tool-list freshness edge");
  const activeSubscriptionStatus = await callServerInfo(base, ownerAccessToken, 9120);
  assert(activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_supported === true
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account === 1
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_opened_for_account === true
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_client_receipt_observable === false
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_lease_ms === MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS,
  "server_info did not distinguish a server-opened toolsListChanged stream from unobservable client receipt");
  const pendingSubscriptionRead = subscriptionReader.read();
  assert(await Promise.race([
    pendingSubscriptionRead.then(() => "settled"),
    new Promise((resolve) => { setTimeout(() => resolve("open"), 25); }),
  ]) === "open", "current HTTP toolsListChanged subscription closed before its bounded server lease");
  subscriptionAbort.abort();
  const cancelledSubscriptionRead = await Promise.race([
    pendingSubscriptionRead.then((result) => ({ settled: true, done: result.done === true }), () => ({ settled: true, done: true })),
    sleep(1_000).then(() => ({ settled: false, done: false })),
  ]);
  assert(cancelledSubscriptionRead.settled && cancelledSubscriptionRead.done,
    "current HTTP request abort did not settle the subscription response body");
  let releasedSubscriptionStatus = await callServerInfo(base, ownerAccessToken, 9121);
  const releaseDeadline = Date.now() + MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS + 2_000;
  let releaseProbeId = 9122;
  while (releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account !== 0
      && Date.now() < releaseDeadline) {
    await sleep(250);
    releasedSubscriptionStatus = await callServerInfo(base, ownerAccessToken, releaseProbeId++);
  }
  assert(releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account === 0
      && releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_opened_for_account === true,
  "current HTTP request abort did not release Durable Object subscription capacity within the bounded server lease");
  const currentNotification = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "notifications/cancelled"),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        _meta: currentMcpRequest(0, "unused", {}).params._meta,
        requestId: 9105,
      },
    }),
  });
  assert(currentNotification.response.status === 404 && currentNotification.body.error?.code === -32601,
    "current HTTP accepted a stdio-only cancellation notification");

  const duplicateRelaySequence = waitForWsMessageSequence(candidateDaemon, ["tool_call", "tool_call"], 10_000);
  const duplicateCurrentA = currentMcpCall(base, ownerAccessToken, 9110, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const duplicateCurrentB = currentMcpCall(base, ownerAccessToken, 9110, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const [duplicateRelayA, duplicateRelayB] = await duplicateRelaySequence;
  assert(duplicateRelayA.id !== duplicateRelayB.id,
    "current HTTP requests sharing a JSON-RPC id reused an internal daemon call id");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: duplicateRelayA.id, ok: true, result: { request: "a" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: duplicateRelayB.id, ok: true, result: { request: "b" } }));
  const [duplicateResultA, duplicateResultB] = await Promise.all([duplicateCurrentA, duplicateCurrentB]);
  const duplicateValues = [
    duplicateResultA.body.result?.structuredContent?.request,
    duplicateResultB.body.result?.structuredContent?.request,
  ].sort();
  assert(JSON.stringify(duplicateValues) === JSON.stringify(["a", "b"]),
    "stateless current HTTP calls with the same request id conflicted or crossed results");

  const remoteAgentTools = await callToolsList(base, ownerAccessToken, 2501);
  const remoteRunProcess = remoteAgentTools.find((tool) => tool.name === "run_process");
  assert(remoteRunProcess?.inputSchema?.properties?.timeout_seconds?.maximum === 600
    && remoteRunProcess?.inputSchema?.properties?.timeout_seconds?.default === 600
    && remoteRunProcess?.inputSchema?.required?.includes("idempotency_key")
    && String(remoteRunProcess?.description || "").includes("one-step durable job")
    && String(remoteRunProcess?.description || "").includes("read_job"),
  "remote tools/list lost the durable-process execution and recovery contract");
  const remoteBrowserWait = remoteAgentTools.find((tool) => tool.name === "browser_wait");
  assert(remoteBrowserWait?.inputSchema?.properties?.timeout_seconds?.maximum === 45
    && remoteBrowserWait?.inputSchema?.properties?.timeout_seconds?.default === 20
    && remoteBrowserWait?.inputSchema?.required?.includes("tab_id")
    && String(remoteBrowserWait?.description || "").includes("explicit tab_id"),
  "remote tools/list lost the reply-safe browser timeout or explicit-tab concurrency contract");
  const remoteReadProcess = remoteAgentTools.find((tool) => tool.name === "read_process");
  const remoteReadProcessDescription = String(remoteReadProcess?.description || "");
  assert(remoteReadProcess?.inputSchema?.properties?.wait_ms?.maximum === 1000
    && remoteReadProcess?.inputSchema?.properties?.wait_ms?.default === 1000
    && remoteReadProcessDescription.includes("paced follow-up")
    && remoteReadProcessDescription.includes("wait_ms=0")
    && remoteReadProcessDescription.includes("same MCP call")
    && remoteReadProcessDescription.includes("next_blocking_poll_after_ms")
    && remoteReadProcessDescription.includes("must not busy-loop"),
  "remote tools/list lost the one-second server-paced process-follow-up contract");
  const remoteListJobsDescription = String(remoteAgentTools.find((tool) => tool.name === "list_jobs")?.description || "");
  assert(remoteListJobsDescription.includes("aggregate retained/capacity/activity state only")
    && remoteListJobsDescription.includes("deliberately omits job handles")
    && remoteListJobsDescription.includes("recovery_key")
    && remoteListJobsDescription.includes("do not repeat list_jobs"),
  "remote tools/list lost aggregate-only hosted managed-job inventory guidance");
  const overLimitMessages = captureWsMessageTypes(candidateDaemon);
  const overLimit = await callTool(base, ownerAccessToken, 2502, "run_process", {
    argv: ["must-not-run"], timeout_seconds: 601, idempotency_key: "worker-over-limit",
  });
  assert(!overLimitMessages.stop().includes("tool_call"),
    "over-limit JSON tool call reached the daemon before rejection");
  assert(overLimit.result?.isError === true
    && overLimit.result?.structuredContent?.error?.code === "invalid_request"
    && overLimit.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimit.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && overLimit.result?.structuredContent?.error?.details?.validation_issues?.some((issue) => issue.instancePath === "/timeout_seconds" && issue.keyword === "maximum"),
  "over-limit durable-process rejection omitted its stale-schema compatibility contract");

  const overLimitPollMessages = captureWsMessageTypes(candidateDaemon);
  const overLimitPoll = await callTool(base, ownerAccessToken, 25020, "read_process", {
    session_id: "proc_stale_schema", wait_ms: 6000,
  });
  assert(!overLimitPollMessages.stop().includes("tool_call"),
    "over-limit process poll reached the daemon before rejection");
  assert(overLimitPoll.result?.isError === true
    && overLimitPoll.result?.structuredContent?.error?.code === "invalid_request"
    && overLimitPoll.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimitPoll.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && overLimitPoll.result?.structuredContent?.error?.details?.validation_issues?.some((issue) => issue.instancePath === "/wait_ms" && issue.keyword === "maximum"),
  "over-limit process poll omitted its stale-schema compatibility contract");

  const malformedTimeoutMessages = captureWsMessageTypes(candidateDaemon);
  const malformedTimeout = await callTool(base, ownerAccessToken, 25021, "run_process", {
    argv: ["must-not-run"], timeout_seconds: "60", idempotency_key: "worker-malformed-timeout",
  });
  assert(!malformedTimeoutMessages.stop().includes("tool_call"),
    "malformed JSON foreground timeout reached the daemon before rejection");
  assert(malformedTimeout.error?.code === -32602
    && malformedTimeout.error?.data?.side_effects_started === false
    && malformedTimeout.error?.data?.validation_issues?.some((issue) => issue.instancePath === "/timeout_seconds" && issue.keyword === "type"),
  "malformed foreground timeout omitted its pre-dispatch schema contract");

  const missingNameMessages = captureWsMessageTypes(candidateDaemon);
  const missingName = await currentMcpCall(base, ownerAccessToken, 25022, "tools/call", { arguments: {} });
  assert(missingName.response.status === 400
    && !missingNameMessages.stop().includes("tool_call")
    && missingName.body.error?.code === -32602
    && missingName.body.error?.message === "name must be a string",
  "current tools/call without a name escaped pre-dispatch HTTP validation");

  const nonObjectArgumentsMessages = captureWsMessageTypes(candidateDaemon);
  const nonObjectArguments = await callTool(base, ownerAccessToken, 25023, "list_dir", []);
  assert(!nonObjectArgumentsMessages.stop().includes("tool_call")
    && nonObjectArguments.error?.code === -32602
    && nonObjectArguments.error?.data?.side_effects_started === false
    && nonObjectArguments.error?.data?.validation_issues?.some((issue) => issue.instancePath === "" && issue.keyword === "type"),
  "removed tools/call silently coerced non-object arguments");

  const overLimitStreamMessages = captureWsMessageTypes(candidateDaemon);
  const overLimitStream = await currentMcpCall(base, ownerAccessToken, 2503, "tools/call", {
    name: "run_process", arguments: { argv: ["must-not-stream-run"], timeout_seconds: 601, idempotency_key: "worker-stream-over-limit" },
  });
  assert(!overLimitStreamMessages.stop().includes("tool_call"),
    "over-limit streamed tool call reached the daemon before rejection");
  assert(overLimitStream.body.result?.isError === true
    && overLimitStream.body.result?.structuredContent?.error?.code === "invalid_request"
    && overLimitStream.body.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimitStream.body.result?.structuredContent?.error?.details?.schema_refresh_recommended === true,
  "stale-schema current tool call omitted its pre-dispatch compatibility contract");

  const missingRecoveryKeyMessages = captureWsMessageTypes(candidateDaemon);
  const missingRecoveryKey = await callTool(base, ownerAccessToken, 25031, "run_process", {
    argv: ["must-not-run"], timeout_seconds: 10,
  });
  assert(!missingRecoveryKeyMessages.stop().includes("tool_call"),
    "durable process without a caller-held recovery key reached the daemon");
  assert(missingRecoveryKey.result?.isError === true
    && missingRecoveryKey.result?.structuredContent?.error?.code === "invalid_request"
    && missingRecoveryKey.result?.structuredContent?.error?.details?.side_effects_started === false
    && missingRecoveryKey.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && missingRecoveryKey.result?.structuredContent?.error?.details?.recovery_credential_required === "idempotency_key",
  "missing durable-process recovery credential did not return a stale-schema-safe no-side-effect error");

  const streamedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const streamedResponsePromise = stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "list_dir"),
    body: JSON.stringify(currentMcpRequest(879, "tools/call", { name: "list_dir", arguments: { path: "." } })),
  });
  const streamedRelay = await streamedRelayPromise;
  const streamedResponse = await streamedResponsePromise;
  assert(streamedResponse.status === 200 && streamedResponse.headers.get("content-type")?.startsWith("text/event-stream"),
    "current event-stream request did not use request-scoped SSE");
  const streamedReader = streamedResponse.body.getReader();
  const streamedInitial = new TextDecoder().decode((await streamedReader.read()).value);
  assert(streamedInitial === ": connected\n\n", "current response stream exposed a replay/session event id");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: streamedRelay.id, ok: true, result: { streamed: true } }));
  const streamedEnvelope = await readSseJsonRpcResponse(streamedReader, streamedInitial);
  assert(streamedEnvelope.message.result?.structuredContent?.streamed === true
    && streamedEnvelope.eventIds.length === 0,
  "current streamed tool call lost its result or regained replay event ids");

  const removedGet = await stableFetch(`${base}/mcp`, {
    method: "GET",
    headers: { authorization: `Bearer ${ownerAccessToken}`, "MCP-Protocol-Version": "2026-07-28", "Last-Event-ID": "removed" },
  });
  assert(removedGet.status === 405 && removedGet.headers.get("allow") === "POST",
    "removed GET/Last-Event-ID resumption path was still served");

  const firstWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const firstWindowCall = toolCallRequest(base, ownerAccessToken, 880, "list_dir", { path: "." });
  const firstWindowRelay = await firstWindowRelayPromise;
  const secondWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const secondWindowCall = toolCallRequest(base, ownerAccessToken, 880, "list_dir", { path: "." });
  const secondWindowRelay = await secondWindowRelayPromise;
  assert(firstWindowRelay.id !== secondWindowRelay.id, "two MCP request streams reused an internal daemon call id");
  const concurrentStatus = await callServerInfo(base, ownerAccessToken, 8810);
  assert(concurrentStatus.worker?.pending_calls?.active === 2, "Worker did not retain two concurrent request-scoped calls");
  assert(concurrentStatus.worker?.pending_calls?.request_keys === 2, "Worker did not isolate concurrent request-stream keys");
  assert(concurrentStatus.worker?.pending_calls?.by_tool?.list_dir === 2, "pending-call diagnostics omitted concurrent tool counts");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: secondWindowRelay.id, ok: true, result: { window: "second" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: firstWindowRelay.id, ok: true, result: { window: "first" } }));
  const [firstWindowResult, secondWindowResult] = await Promise.all([firstWindowCall, secondWindowCall]);
  assert(firstWindowResult.body.result?.structuredContent?.window === "first", "first MCP request stream received another request's result");
  assert(secondWindowResult.body.result?.structuredContent?.window === "second", "second MCP request stream received another request's result");

  const handoverRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const handoverCall = toolCallRequest(base, ownerAccessToken, 8799, "list_dir", { path: "." });
  const handoverRelay = await handoverRelayPromise;
  const handoverPreviousSocket = candidateDaemon;
  const handoverPreviousClosed = waitForWsClose(handoverPreviousSocket);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const handoverResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(handoverResume.ids.length === 1 && handoverResume.ids[0] === handoverRelay.id, "verified same-instance socket handover did not transfer the attached call before closing the incumbent");
  await handoverPreviousClosed;
  const handoverStatus = await callServerInfo(base, ownerAccessToken, 87990);
  assert(handoverStatus.worker?.pending_calls?.active === 1 && handoverStatus.worker?.pending_calls?.detached === 0, "verified socket handover left the transferred call detached");
  const handoverResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: handoverRelay.id, ok: true, result: { handover: true } }));
  assert((await handoverResultAck).id === handoverRelay.id, "transferred call result was not acknowledged");
  assert((await handoverCall).body.result?.structuredContent?.handover === true, "transferred call did not complete on the verified replacement socket");

  const duplicateResultBaseline = await callServerInfo(base, ownerAccessToken, 87991);
  const baselineOwnerMissing = duplicateResultBaseline.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0;
  const baselineStaleRejected = duplicateResultBaseline.worker?.observability?.terminal_results?.stale_connection_rejected ?? 0;
  const duplicateResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: handoverRelay.id, ok: true, result: { handover: true } }));
  assert((await duplicateResultAck).id === handoverRelay.id, "duplicate terminal result was not acknowledged");
  let duplicateResultStatus = duplicateResultBaseline;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    duplicateResultStatus = await callServerInfo(base, ownerAccessToken, 87992 + attempt);
    if ((duplicateResultStatus.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) > baselineOwnerMissing) break;
    await sleep(25);
  }
  assert((duplicateResultStatus.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) === baselineOwnerMissing + 1,
    "duplicate terminal result was not classified as owner-missing and acknowledged");
  assert((duplicateResultStatus.worker?.observability?.terminal_results?.stale_connection_rejected ?? 0) === baselineStaleRejected,
    "duplicate terminal result was misclassified as a stale-connection rejection");

  const reconnectRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reconnectCall = toolCallRequest(base, ownerAccessToken, 8801, "list_dir", { path: "." });
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

  const plannedDrainJobId = `job_${"d".repeat(64)}`;
  const plannedDrainAcceptanceRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const plannedDrainAcceptanceCall = toolCallRequest(base, ownerAccessToken, 88030, "start_job", {
    idempotency_key: "planned-drain-capability", steps: [{ argv: ["true"] }],
  });
  const plannedDrainAcceptanceRelay = await plannedDrainAcceptanceRelayPromise;
  assert(plannedDrainAcceptanceRelay.tool === "start_job"
    && !("recovery_key" in plannedDrainAcceptanceRelay.arguments)
    && !("control_key" in plannedDrainAcceptanceRelay.arguments),
  "hosted managed-job capability material crossed the Worker/daemon request boundary");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: plannedDrainAcceptanceRelay.id, ok: true,
    result: { accepted: true, job_id: plannedDrainJobId, status: "running", recovery: { tool: "read_job", job_id: plannedDrainJobId } },
  }));
  const plannedDrainAcceptanceResult = await plannedDrainAcceptanceCall;
  const plannedDrainRecoveryKey = plannedDrainAcceptanceResult.body.result?.structuredContent?.recovery_key;
  assert(typeof plannedDrainRecoveryKey === "string" && /^mcp_jr_[A-Za-z0-9_-]{43}$/.test(plannedDrainRecoveryKey),
    "hosted managed-job acceptance did not return a read recovery capability");
  const plannedDrainRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const plannedDrainCall = toolCallRequest(base, ownerAccessToken, 88031, "read_job", {
    job_id: plannedDrainJobId, recovery_key: plannedDrainRecoveryKey, wait_ms: 0,
  });
  const plannedDrainRelay = await plannedDrainRelayPromise;
  assert(plannedDrainRelay.arguments?.job_id === plannedDrainJobId && !("recovery_key" in plannedDrainRelay.arguments),
    "hosted read_job forwarded its recovery capability to the daemon");
  const plannedDrainBaseline = await callServerInfo(base, ownerAccessToken, 88032);
  const plannedDrainAckPromise = waitForWsMessage(candidateDaemon, "daemon_draining_ack");
  const plannedDrainId = `drain_${"p".repeat(24)}`;
  candidateDaemon.send(JSON.stringify({ type: "daemon_draining", drain_id: plannedDrainId, active_calls: 1 }));
  assert((await plannedDrainAckPromise).drain_id === plannedDrainId,
    "planned daemon drain was not acknowledged before the daemon transport closed");
  const plannedDrainResult = await plannedDrainCall;
  const plannedDrainError = plannedDrainResult.body.result?.structuredContent?.error;
  assert(plannedDrainResult.body.result?.isError === true
    && plannedDrainError?.code === "unavailable"
    && plannedDrainError?.retryable === true
    && plannedDrainError?.details?.reason === "daemon_planned_drain"
    && plannedDrainError?.details?.side_effects_started === false
    && plannedDrainError?.details?.recovery?.mode === "read_same_job"
    && plannedDrainError?.details?.recovery?.job_id === plannedDrainJobId,
  "planned daemon drain did not convert an active read_job into a structured same-job recovery settlement");
  const plannedDrainStatus = await callServerInfo(base, ownerAccessToken, 88033);
  assert((plannedDrainStatus.worker?.observability?.continuity?.planned_drains ?? 0)
      === (plannedDrainBaseline.worker?.observability?.continuity?.planned_drains ?? 0) + 1
    && (plannedDrainStatus.worker?.observability?.continuity?.planned_drain_calls ?? 0)
      === (plannedDrainBaseline.worker?.observability?.continuity?.planned_drain_calls ?? 0) + 1
    && plannedDrainStatus.daemon?.connected === false,
  "Worker isolate-local continuity diagnostics did not record the planned drain settlement");

  const drainedCandidate = candidateDaemon;
  const drainedCandidateClosed = waitForWsClose(drainedCandidate);
  drainedCandidate.terminate();
  await drainedCandidateClosed;
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const postDrainResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(postDrainResume.ids.length === 0, "planned drain left an old pending call eligible for same-instance resume");
  const postDrainStatus = await callServerInfo(base, ownerAccessToken, 88034);
  assert((postDrainStatus.worker?.continuity_evidence?.planned_drains ?? 0)
      === (plannedDrainBaseline.worker?.continuity_evidence?.planned_drains ?? 0) + 1
    && (postDrainStatus.worker?.continuity_evidence?.planned_drain_calls ?? 0)
      === (plannedDrainBaseline.worker?.continuity_evidence?.planned_drain_calls ?? 0) + 1
    && postDrainStatus.worker?.continuity_evidence?.last_planned_drain_at,
  "Worker durable continuity evidence did not survive the planned-drain reconnect boundary");

  const fallbackRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const fallbackCall = toolCallRequest(base, ownerAccessToken, 8880, "list_dir", { path: "." });
  const fallbackRelay = await fallbackRelayPromise;
  const fallbackBaseline = await callServerInfo(base, ownerAccessToken, 8881);
  const fallbackOwnerMissing = fallbackBaseline.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0;
  const fallbackPreviousSocket = candidateDaemon;
  const fallbackPreviousClosed = waitForWsClose(fallbackPreviousSocket);
  fallbackPreviousSocket.terminate();
  await fallbackPreviousClosed;

  const fallbackSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const fallbackBase = {
    protocol: 1,
    session_id: fallbackSessionId,
    instance_id: candidateInstanceId,
    ack_worker_seq: 0,
    owned_call_ids: [fallbackRelay.id],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: {
      schema_version: 1, transport: "https", network_route: "system-network-stack",
      outage_count: 1, outage_active: true, outage_duration_ms: 1,
    },
  };
  const fallbackProbing = await daemonHttpExchange(fallbackBase);
  assert(fallbackProbing.response.status === 200
    && fallbackProbing.body.phase === "probing"
    && /^activate_[A-Za-z0-9_-]{43}$/.test(fallbackProbing.body.activation_token || ""),
  "signed HTTPS fallback did not enter bounded probing on its first authenticated exchange");
  const fallbackResume = fallbackProbing.body.messages?.find((message) => message.payload?.type === "resume_calls")?.payload;
  const fallbackReadyAck = fallbackProbing.body.messages?.find((message) => message.payload?.type === "ready_ack")?.payload;
  assert(fallbackResume?.ids?.length === 1 && fallbackResume.ids[0] === fallbackRelay.id,
    "HTTPS fallback did not rebind exactly the same-instance in-flight call");
  assert(fallbackReadyAck?.server === "machine-bridge-mcp" && fallbackReadyAck?.version === pkg.version,
    "HTTPS fallback omitted the verified ready acknowledgement");
  const fallbackProbeStatus = await callServerInfo(base, ownerAccessToken, 8882);
  assert(fallbackProbeStatus.worker?.sockets_live?.https_fallback_ready === 0
    && fallbackProbeStatus.daemon?.connected === false,
  "probing HTTPS fallback was advertised as ready before the local runtime proved ready_ack delivery");
  const ackWorkerSeq = Math.max(...fallbackProbing.body.messages.map((message) => message.seq));
  const fallbackVerified = await daemonHttpExchange({
    ...fallbackBase,
    activation_token: fallbackProbing.body.activation_token,
    ack_worker_seq: ackWorkerSeq,
    messages: [
      { seq: 1, payload: { type: "https_ready" } },
      { seq: 2, payload: { type: "resume_calls_ack", missing_ids: [] } },
    ],
  });
  assert(fallbackVerified.response.status === 200 && fallbackVerified.body.phase === "ready"
    && fallbackVerified.body.ack_daemon_seq === 2,
  "HTTPS fallback did not become ready after explicit local verified-ready proof");
  const fallbackReadyStatus = await callServerInfo(base, ownerAccessToken, 8882);
  assert(fallbackReadyStatus.worker?.sockets_live?.https_fallback_ready === 1
    && fallbackReadyStatus.daemon?.connected === true,
  "server_info did not report the ready HTTPS daemon fallback");

  const fallbackResultExchange = {
    ...fallbackBase,
    activation_token: fallbackProbing.body.activation_token,
    ack_worker_seq: ackWorkerSeq,
    messages: [{ seq: 3, payload: { type: "tool_result", id: fallbackRelay.id, ok: true, result: { https_fallback: true } } }],
  };
  const lostFallbackResponse = await daemonHttpExchange(fallbackResultExchange);
  assert(lostFallbackResponse.response.status === 200 && lostFallbackResponse.body.ack_daemon_seq === 3,
    "HTTPS fallback did not commit the first daemon result sequence");
  const fallbackResult = await fallbackCall;
  assert(fallbackResult.body.result?.structuredContent?.https_fallback === true,
    "MCP request did not settle through the HTTPS fallback");
  const replayedFallbackResponse = await daemonHttpExchange(fallbackResultExchange);
  assert(replayedFallbackResponse.response.status === 200 && replayedFallbackResponse.body.ack_daemon_seq === 3,
    "lost HTTPS response retry did not converge on the already-committed daemon sequence");
  const fallbackAfterReplay = await callServerInfo(base, ownerAccessToken, 8883);
  assert((fallbackAfterReplay.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) === fallbackOwnerMissing,
    "replayed HTTPS transport sequence re-entered tool-result handling instead of being deduplicated");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const fallbackHandoverProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, fallbackHandoverProbe);
  const fallbackHandoverStatus = await callServerInfo(base, ownerAccessToken, 8884);
  assert(fallbackHandoverStatus.worker?.sockets_live?.ready === 1
    && fallbackHandoverStatus.worker?.sockets_live?.https_fallback_ready === 0,
  "verified WebSocket did not reclaim primary daemon ownership from HTTPS fallback");
  const fallbackStandby = await daemonHttpExchange(fallbackResultExchange);
  assert(fallbackStandby.response.status === 409 && fallbackStandby.body.error === "unknown_daemon_http_session",
    "superseded HTTPS fallback session was not rejected after verified WSS reclaimed ownership");

  const staleTakeoverConnectionId = candidateDaemon.mbmWelcome?.connection_id;
  assert(/^connection_[A-Za-z0-9_-]{43}$/.test(String(staleTakeoverConnectionId || "")),
    "Worker welcome did not expose the connection identity required for generation-bound fallback takeover");
  const stalePreviousSocket = candidateDaemon;
  const stalePreviousClosed = waitForWsClose(stalePreviousSocket);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const recoveredProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, recoveredProbe);
  await stalePreviousClosed;
  const staleTakeoverSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const staleTakeover = await daemonHttpExchange({
    protocol: 1,
    session_id: staleTakeoverSessionId,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    takeover_websocket_connection_id: staleTakeoverConnectionId,
    ack_worker_seq: 0,
    owned_call_ids: [],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  });
  assert(staleTakeover.response.status === 200 && staleTakeover.body.phase === "standby",
    "stale HTTPS takeover was not fenced off after a newer same-instance WebSocket became ready");
  const afterStaleTakeover = await callServerInfo(base, ownerAccessToken, 8885);
  assert(afterStaleTakeover.worker?.sockets_live?.ready === 1
    && afterStaleTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "stale HTTPS takeover retired the newer verified WebSocket generation");
  const legacyTakeover = await daemonHttpExchange({
    protocol: 1,
    session_id: `relay_http_${randomBytes(32).toString("base64url")}`,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    ack_worker_seq: 0,
    owned_call_ids: [],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  });
  assert(legacyTakeover.response.status === 400 && legacyTakeover.body.error === "invalid_daemon_http_exchange",
    "generation-less HTTPS takeover remained accepted after its rolling compatibility boundary expired");
  const afterLegacyTakeover = await callServerInfo(base, ownerAccessToken, 8886);
  assert(afterLegacyTakeover.worker?.sockets_live?.ready === 1
    && afterLegacyTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "rejected generation-less HTTPS takeover changed verified WebSocket ownership");

  const asymmetricRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const asymmetricCall = toolCallRequest(base, ownerAccessToken, 8890, "list_dir", { path: "." });
  const asymmetricRelay = await asymmetricRelayPromise;
  const asymmetricSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const asymmetricBase = {
    protocol: 1,
    session_id: asymmetricSessionId,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    takeover_websocket_connection_id: candidateDaemon.mbmWelcome.connection_id,
    ack_worker_seq: 0,
    owned_call_ids: [asymmetricRelay.id],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  };
  const invalidTakeover = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: `activate_${"z".repeat(43)}`,
  });
  assert(invalidTakeover.response.status === 409,
    "invalid new HTTPS takeover session was not rejected before transport ownership changed");
  const afterInvalidTakeover = await callServerInfo(base, ownerAccessToken, 8890);
  assert(afterInvalidTakeover.worker?.sockets_live?.ready === 1
    && afterInvalidTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "invalid signed HTTPS takeover request retired the healthy WebSocket before candidate validation");

  const asymmetricPreviousSocket = candidateDaemon;
  const asymmetricPreviousClosed = waitForWsClose(asymmetricPreviousSocket);
  const asymmetricProbing = await daemonHttpExchange(asymmetricBase);
  assert(asymmetricProbing.response.status === 200 && asymmetricProbing.body.phase === "probing",
    "authenticated same-instance HTTPS takeover was blocked by the Worker-side zombie WebSocket");
  await asymmetricPreviousClosed;
  const asymmetricResume = asymmetricProbing.body.messages?.find((message) => message.payload?.type === "resume_calls")?.payload;
  assert(asymmetricResume?.ids?.length === 1 && asymmetricResume.ids[0] === asymmetricRelay.id,
    "same-instance HTTPS takeover lost the in-flight WebSocket call during ownership transfer");
  const asymmetricAckWorkerSeq = Math.max(...asymmetricProbing.body.messages.map((message) => message.seq));
  const asymmetricVerified = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: asymmetricProbing.body.activation_token,
    ack_worker_seq: asymmetricAckWorkerSeq,
    messages: [
      { seq: 1, payload: { type: "https_ready" } },
      { seq: 2, payload: { type: "resume_calls_ack", missing_ids: [] } },
    ],
  });
  assert(asymmetricVerified.response.status === 200 && asymmetricVerified.body.phase === "ready",
    "same-instance HTTPS takeover did not finish verified readiness after retiring the zombie WebSocket");
  const asymmetricResult = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: asymmetricProbing.body.activation_token,
    ack_worker_seq: asymmetricAckWorkerSeq,
    messages: [{ seq: 3, payload: {
      type: "tool_result", id: asymmetricRelay.id, ok: true, result: { asymmetric_https_takeover: true },
    } }],
  });
  assert(asymmetricResult.response.status === 200 && asymmetricResult.body.ack_daemon_seq === 3,
    "same-instance HTTPS takeover did not acknowledge the transferred call result");
  const asymmetricSettled = await asymmetricCall;
  assert(asymmetricSettled.body.result?.structuredContent?.asymmetric_https_takeover === true,
    "in-flight call did not settle after asymmetric WebSocket-to-HTTPS takeover");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const asymmetricReturnProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, asymmetricReturnProbe);
  const asymmetricReturnStatus = await callServerInfo(base, ownerAccessToken, 8891);
  assert(asymmetricReturnStatus.worker?.sockets_live?.ready === 1
    && asymmetricReturnStatus.worker?.sockets_live?.https_fallback_ready === 0,
  "WebSocket did not reclaim primary ownership after asymmetric HTTPS takeover recovery");

  const missingOwnershipRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const missingOwnershipCall = toolCallRequest(base, ownerAccessToken, 8804, "list_dir", { path: "." });
  const missingOwnershipRelay = await missingOwnershipRelayPromise;
  const missingOwnershipPreviousSocket = candidateDaemon;
  const missingOwnershipPreviousClosed = waitForWsClose(missingOwnershipPreviousSocket);
  missingOwnershipPreviousSocket.terminate();
  await missingOwnershipPreviousClosed;
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const missingOwnershipResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(missingOwnershipResume.ids.length === 1 && missingOwnershipResume.ids[0] === missingOwnershipRelay.id,
    "same-instance reconnect did not carry the simulated undelivered call into resume reconciliation");
  const missingOwnershipRedelivery = waitForWsMessage(candidateDaemon, "tool_call");
  candidateDaemon.send(JSON.stringify({
    type: "resume_calls_ack",
    missing_ids: [missingOwnershipRelay.id],
  }));
  const redeliveredMissingOwnership = await missingOwnershipRedelivery;
  assert(redeliveredMissingOwnership.id === missingOwnershipRelay.id
    && redeliveredMissingOwnership.tool === missingOwnershipRelay.tool
    && JSON.stringify(redeliveredMissingOwnership.arguments) === JSON.stringify(missingOwnershipRelay.arguments)
    && Number.isInteger(redeliveredMissingOwnership.timeout_ms)
    && redeliveredMissingOwnership.timeout_ms > 0
    && redeliveredMissingOwnership.timeout_ms <= missingOwnershipRelay.timeout_ms,
  "daemon-proven non-delivery did not redeliver the exact original call inside its remaining execution budget");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: missingOwnershipRelay.id, ok: true,
    result: { proven_non_delivery_redelivered: true },
  }));
  const missingOwnershipResult = await missingOwnershipCall;
  assert(missingOwnershipResult.response.status === 200
    && missingOwnershipResult.body.result?.isError !== true
    && missingOwnershipResult.body.result?.structuredContent?.proven_non_delivery_redelivered === true,
  "daemon-proven non-delivery did not recover transparently through one safe same-id transport redelivery");

  const idlessMessages = captureWsMessageTypes(candidateDaemon);
  const idlessBody = currentMcpRequest(250, "tools/call", { name: "server_info", arguments: {} });
  delete idlessBody.id;
  const idlessToolCall = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "server_info"),
    body: JSON.stringify(idlessBody),
  });
  assert(idlessToolCall.response.status === 404 && idlessToolCall.body.error?.code === -32601
    && !idlessMessages.stop().includes("tool_call"),
  "Worker accepted tools/call as a notification or dispatched it without a request id");

  // Keep this long integration suite from turning the production per-credential 120/60s limiter into a CI timing oracle.
  // Rate-limit keys/429 behavior have dedicated tests; this phase only needs the same owner authority on fresh credentials.
  const ownerPhaseRefresh = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: ownerRefreshToken,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(ownerPhaseRefresh.response.status === 200
    && typeof ownerPhaseRefresh.body.access_token === "string"
    && ownerPhaseRefresh.body.access_token !== ownerAccessToken
    && typeof ownerPhaseRefresh.body.refresh_token === "string"
    && ownerPhaseRefresh.body.refresh_token !== ownerRefreshToken,
  "owner phase-boundary refresh did not rotate the integration credentials");
  ownerAccessToken = ownerPhaseRefresh.body.access_token;

  const activeTools = await callToolsList(base, ownerAccessToken, 26);
  assert(JSON.stringify(activeTools.map((tool) => tool.name).sort()) === JSON.stringify(stableOwnerToolNames),
    "verified daemon replacement changed the stable owner tool catalog");
  assert(activeTools.some((tool) => tool.name === "read_file"), "stable owner catalog omitted a policy-gated tool");
  assert(activeTools.find((tool) => tool.name === "list_dir")?.annotations?.readOnlyHint === true, "tool annotations were not returned");

  const reviewerTools = await callToolsList(base, reviewerToken, 27);
  assert(reviewerTools.some((tool) => tool.name === "list_dir"), "reviewer could not access a read-only daemon tool");
  assert(!reviewerTools.some((tool) => tool.name === "run_process"), "reviewer was shown a process-execution tool");

  const reviewerDeniedMessages = captureWsMessageTypes(candidateDaemon);
  const reviewerDenied = await currentMcpCall(base, reviewerToken, 271, "tools/call", {
    name: "run_process", arguments: { argv: ["true"] },
  });
  assert(!reviewerDeniedMessages.stop().includes("tool_call"), "reviewer process execution reached the daemon");
  assert(reviewerDenied.body.error?.code === -32602 && reviewerDenied.body.error?.message === "Unknown tool",
  "reviewer process execution was not rejected at the role-filtered protocol boundary");

  const reviewerRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reviewerReadPromise = currentMcpCall(base, reviewerToken, 272, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const reviewerRelay = await reviewerRelayPromise;
  assert(reviewerRelay.authorization?.role === "reviewer", "reviewer role was not forwarded to the daemon");
  assert(reviewerRelay.authorization?.account_id === reviewerAccount.body.account.account_id, "reviewer account id was not forwarded to the daemon");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: reviewerRelay.id, ok: true, result: { entries: [] } }));
  const reviewerRead = await reviewerReadPromise;
  assert(reviewerRead.body.result?.isError === false, "reviewer read-only call failed");

  const relayedImageCallPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const remoteImageCall = currentMcpCall(base, ownerAccessToken, 76, "tools/call", {
    name: "view_image", arguments: { path: "pixel.png" },
  });
  const relayedImageCall = await relayedImageCallPromise;
  assert(relayedImageCall.tool === "view_image", "Worker relayed the wrong rich-content tool");
  const imageResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack", 10_000, "rich result acknowledgement");
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
  const acknowledgedImage = await imageResultAck;
  assert(acknowledgedImage.id === relayedImageCall.id, "Worker acknowledged the wrong daemon result");
  const remoteImage = await remoteImageCall;
  assert(remoteImage.response.status === 200, "rich image tools/call failed");
  assert(remoteImage.body.result?.content?.[0]?.type === "image", "Worker flattened native MCP image content");
  assert(remoteImage.body.result?.structuredContent?.path === "pixel.png", "Worker omitted rich structuredContent");
  assert(!JSON.stringify(remoteImage.body.result).includes("$mcp"), "Worker leaked the internal rich-result envelope");

  const timedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const durableAcceptanceCall = currentMcpCall(base, ownerAccessToken, 75, "tools/call", {
    name: "run_process", arguments: { argv: ["durable-step"], timeout_seconds: 1, idempotency_key: "worker-durable-acceptance" },
  });
  const timedRelay = await Promise.race([
    timedRelayPromise,
    durableAcceptanceCall.then((result) => {
      throw new Error(`durable acceptance HTTP response settled before daemon relay: ${result.response.status}`);
    }),
  ]);
  assert(timedRelay.tool === "run_process" && timedRelay.timeout_ms === 10_000
    && timedRelay.arguments?.timeout_seconds === 1
    && timedRelay.arguments?.idempotency_key === "worker-durable-acceptance",
  "Worker coupled the durable step lifetime back into the MCP acceptance deadline");
  const durableJobId = `job_${"d".repeat(24)}`;
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: timedRelay.id,
    ok: true,
    result: {
      accepted: true,
      execution_mode: "durable_job",
      job_id: durableJobId,
      execution_timeout_seconds: 1,
      idempotency_key_accepted: true,
      recovery: { tool: "read_job", job_id: durableJobId },
    },
  }));
  const durableAcceptanceResult = await durableAcceptanceCall;
  assert(durableAcceptanceResult.response.status === 200
    && durableAcceptanceResult.body.result?.isError === false
    && durableAcceptanceResult.body.result?.structuredContent?.execution_mode === "durable_job"
    && durableAcceptanceResult.body.result?.structuredContent?.job_id === durableJobId
    && /^mcp_jr_[A-Za-z0-9_-]{43}$/.test(String(durableAcceptanceResult.body.result?.structuredContent?.recovery_key || ""))
    && /^mcp_jc_[A-Za-z0-9_-]{43}$/.test(String(durableAcceptanceResult.body.result?.structuredContent?.control_key || "")),
  "durable process acceptance did not settle independently of the detached one-second step lifetime or return hosted recovery capabilities");

  const durableRecoveryKey = durableAcceptanceResult.body.result?.structuredContent?.recovery_key;
  const monitorRenderResult = await currentMcpCall(base, ownerAccessToken, 752, "tools/call", {
    name: "render_job_monitor",
    arguments: { job_id: durableJobId, recovery_key: durableRecoveryKey },
  });
  const monitorRenderStructured = monitorRenderResult.body.result?.structuredContent;
  const monitorRenderText = String(monitorRenderResult.body.result?.content?.[0]?.text || "");
  const monitorRenderId = String(monitorRenderStructured?.ui_monitor_id || "");
  assert(monitorRenderResult.response.status === 200
    && monitorRenderResult.body.result?.isError === false
    && monitorRenderStructured?.job_id === durableJobId
    && /^mcp_jm_[a-f0-9]{32}$/.test(monitorRenderId)
    && monitorRenderStructured?.ui_monitor_claim_required === true
    && monitorRenderStructured?.follow_up_read_required === true
    && !("recovery_key" in monitorRenderStructured)
    && !("control_key" in monitorRenderStructured)
    && monitorRenderText.includes(`ui_monitor_id=${monitorRenderId}`)
    && !monitorRenderText.includes("mcp_jr_") && !monitorRenderText.includes("mcp_jc_"),
  "render_job_monitor did not mirror only its non-secret render-instance ID into model-visible text");

  const ambiguousAcceptanceKey = "worker-ambiguous-durable-acceptance";
  const ambiguousRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const ambiguousAcceptanceCall = currentMcpCall(base, ownerAccessToken, 751, "tools/call", {
    name: "run_process",
    arguments: { argv: ["durable-step-with-lost-acceptance"], timeout_seconds: 1, idempotency_key: ambiguousAcceptanceKey },
  });
  const ambiguousRelay = await ambiguousRelayPromise;
  assert(ambiguousRelay.tool === "run_process"
    && ambiguousRelay.arguments?.idempotency_key === ambiguousAcceptanceKey
    && ambiguousRelay.timeout_ms === 10_000,
  "ambiguous durable acceptance fixture lost its caller-held recovery key before daemon dispatch");
  const ambiguousCancel = await waitForWsMessage(candidateDaemon, "cancel_call", 20_000);
  assert(ambiguousCancel.id === ambiguousRelay.id,
    "durable acceptance timeout cancellation targeted the wrong daemon call");
  const ambiguousAcceptanceResult = await ambiguousAcceptanceCall;
  const ambiguousError = ambiguousAcceptanceResult.body.result?.structuredContent?.error;
  assert(ambiguousAcceptanceResult.response.status === 200
    && ambiguousAcceptanceResult.body.result?.isError === true
    && ambiguousError?.code === "timeout"
    && ambiguousError?.details?.side_effects_started === true
    && ambiguousError?.details?.recovery?.credential === "idempotency_key"
    && ambiguousError?.details?.recovery?.credential_source === "original_request_arguments"
    && ambiguousError?.details?.recovery?.idempotency_key === undefined
    && ambiguousError?.details?.recovery?.action === "retry_same_tool_arguments_with_same_idempotency_key",
  "lost durable acceptance response did not return a non-echoing idempotent recovery instruction");

  const demoteLastOwner = await stableFetch(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: ownerAccount.body.account.account_id, role: "reviewer",
  }));
  assert(demoteLastOwner.status === 409, "last active owner could be demoted");

  const reviewerRevokedSubscriptionResponse = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(reviewerToken, "subscriptions/listen"),
    body: JSON.stringify(currentMcpRequest(2729, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    })),
  });
  const reviewerRevokedSubscriptionReader = reviewerRevokedSubscriptionResponse.body.getReader();
  const reviewerRevokedSubscriptionMessages = await readSseJsonMessages(reviewerRevokedSubscriptionReader, 2);
  assert(reviewerRevokedSubscriptionResponse.status === 200
      && reviewerRevokedSubscriptionMessages[1]?.method === "notifications/tools/list_changed",
  "reviewer authority-revocation fixture did not establish a live subscription");
  const reviewerRevokedSubscriptionPending = reviewerRevokedSubscriptionReader.read();
  const reviewerRevokedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reviewerRevokedCall = currentMcpCall(base, reviewerToken, 2730, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const reviewerRevokedRelay = await reviewerRevokedRelayPromise;
  const firstAuthorityRevoke = waitForWsMessage(candidateDaemon, "authority_revoke", 10_000, "reviewer authority revocation");
  const reviewerRoleChange = await fetchJson(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: reviewerAccount.body.account.account_id, role: "editor",
  }));
  assert(reviewerRoleChange.response.status === 200, "reviewer role change failed");
  const initialRevoke = await firstAuthorityRevoke;
  assert(initialRevoke.account_id === reviewerRelay.authorization.account_id
    && initialRevoke.account_version === reviewerRevokedRelay.authorization.account_version
    && initialRevoke.client_id === undefined && initialRevoke.family_id === undefined,
  "reviewer role change did not deliver a broad revocation for the exact previous account version");
  const reviewerRevokedResult = await reviewerRevokedCall;
  assert(reviewerRevokedResult.body.result?.isError === true
    && reviewerRevokedResult.body.result?.structuredContent?.error?.code === "authorization_denied",
  "reviewer in-flight call survived its account-version revocation");
  const revokedSubscriptionSettlement = await Promise.race([
    reviewerRevokedSubscriptionPending.then((result) => ({ settled: true, done: result.done === true }), () => ({ settled: true, done: true })),
    sleep(1_000).then(() => ({ settled: false, done: false })),
  ]);
  assert(revokedSubscriptionSettlement.settled && revokedSubscriptionSettlement.done,
    "reviewer account-version revocation left its authenticated subscription stream alive");

  const replacedForRevocation = candidateDaemon;
  const replacedForRevocationClosed = waitForWsClose(replacedForRevocation);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const revocationReplayProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  const revocationReplay = await completeDaemonProbeWithRevocations(candidateDaemon, revocationReplayProbe, 1);
  assert(revocationReplay.resume.ids.length === 0, "revoked pending call was rebound during daemon handover");
  const replayedRevoke = revocationReplay.revocations[0];
  assert(replayedRevoke.revocation_id === initialRevoke.revocation_id
    && replayedRevoke.account_id === initialRevoke.account_id
    && replayedRevoke.account_version === initialRevoke.account_version,
  "unacknowledged authority revocation was not durably replayed before daemon readiness");
  assert((await replacedForRevocationClosed).code === 1012, "authority-revocation handover did not replace the previous daemon cleanly");
  candidateDaemon.send(JSON.stringify({ type: "authority_revoke_ack", revocation_id: replayedRevoke.revocation_id }));
  const revocationBarrier = waitForWsMessage(candidateDaemon, "pong", 10_000, "authority revocation acknowledgement barrier");
  candidateDaemon.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  await revocationBarrier;

  const revokedReviewer = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(reviewerToken, "tools/list"),
    body: JSON.stringify(currentMcpRequest(273, "tools/list", {})),
  });
  assert(revokedReviewer.status === 401, "role change did not revoke the changed account token");
  const postAckMessages = captureWsMessageTypes(candidateDaemon);
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
  assert(!postAckMessages.stop().includes("authority_revoke"), "acknowledged authority revocation remained in the durable replay queue");
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
    assert(extraRegistration.status === 201, `pending-registration quota rejected client ${index + 1} too early`);
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
  assert(Array.isArray(editorStatus.daemon?.tools) && editorStatus.daemon.tools.length === 0
    && editorStatus.daemon?.tools_hidden_by_authority === true
    && editorStatus.daemon?.tool_count === 6,
  "non-owner server_info leaked daemon-only tool names instead of retaining only the ceiling count");
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

  const editorOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const editorOverviewPromise = toolCallRequest(base, editorToken, 276, "project_overview", {});
  const editorOverviewRelay = await editorOverviewRelayPromise;
  assert(editorOverviewRelay.authorization?.role === "editor", "project_overview did not relay the editor role");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: editorOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "",
      policy: { profile: "custom", origin: "effective", revision: 5, allowWrite: true, allowExec: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      privateDaemonField: "/synthetic/private/daemon-state",
      topLevel: [{ name: "src", path: "/synthetic/workspace/src", type: "directory", size: 4096, private_metadata: "daemon-private" }],
    },
  }));
  const editorOverview = (await editorOverviewPromise).body.result?.structuredContent;
  assert(editorOverview?.policy?.profile === "edit", "remote project_overview exposed the daemon full policy as editor authority");
  assert(editorOverview?.daemonPolicy?.profile === "full", "remote project_overview lost the daemon capability ceiling");
  assert(editorOverview?.tools?.includes("write_file") && !editorOverview?.tools?.includes("exec_command") && !editorOverview?.tools?.includes("browser_action"), "remote project_overview did not expose editor-effective tools");
  assert(Array.isArray(editorOverview?.daemonTools) && editorOverview.daemonTools.length === 0
    && editorOverview?.daemonToolCount === 7 && editorOverview?.daemonToolsHiddenByAuthority === true,
  "remote project_overview leaked daemon-only tool names to a non-owner account");
  assert(editorOverview?.workspace === "." && editorOverview?.workspaceName === "workspace" && editorOverview?.gitRoot === ""
    && editorOverview?.capabilityRouting?.activity_hidden_by_authority === true
    && !("privateDaemonField" in editorOverview)
    && editorOverview?.topLevel?.[0]?.name === "src" && editorOverview?.topLevel?.[0]?.size === 4096
    && !("path" in editorOverview.topLevel[0]) && !("private_metadata" in editorOverview.topLevel[0]),
  "remote project_overview failed to enforce fail-closed non-owner path/activity/unknown-field privacy at the Worker boundary");
  assert(editorOverview?.policyScope === "authenticated_account_effective_authority", "remote project_overview policy scope remained ambiguous");

  const compactOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const compactOverviewPromise = toolCallRequest(base, editorToken, 2761, "project_overview", { detail: "summary" });
  const compactOverviewRelay = await compactOverviewRelayPromise;
  assert(compactOverviewRelay.authorization?.role === "editor"
    && compactOverviewRelay.arguments && Object.keys(compactOverviewRelay.arguments).length === 0,
  "remote compact project_overview failed to use the backward-compatible default/full daemon request");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: compactOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "/synthetic/workspace",
      policy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      privateDaemonField: "/synthetic/private/summary-state",
      capabilityRouting: {
        bootstrap_observed: true, bootstrap_count: 8, task_resolution_observed: true, task_resolution_count: 3,
        last_task_resolution: {
          observed_at: "2026-08-08T00:00:00.000Z", task_fingerprint: "private-fingerprint", refresh_fingerprint: "private-refresh",
          selected_skill: "review", matched_skills: 2, matched_commands: 3, matched_applications: 4,
          recommended_tools: ["read_file", "git_status"], primary_route: "files", routing_ambiguity: "low", routing_score_gap: 4,
        },
        enforcement_boundary: "long cold-path explanation",
      },
      topLevel: [
        { name: "src", path: "/synthetic/workspace/src", type: "directory", size: 4096, private_metadata: "summary-private" },
        { name: "README.md", path: "/synthetic/workspace/README.md", type: "file", size: 1234 },
      ],
      topLevelTotal: 2, topLevelTruncated: false,
    },
  }));
  const compactOverview = (await compactOverviewPromise).body.result?.structuredContent;
  const compactOverviewJson = JSON.stringify(compactOverview);
  assert(compactOverview?.detail === "summary"
    && compactOverview?.policy?.profile === "edit"
    && compactOverview?.effectiveToolCount === 5
    && compactOverview?.daemonToolCount === 7
    && compactOverview?.authorization?.account?.role === "editor"
    && !("account_id" in compactOverview.authorization.account)
    && compactOverview?.authorization?.effective_tool_count === 5
    && compactOverview?.topLevel?.[0]?.name === "src"
    && !("path" in compactOverview.topLevel[0]) && !("size" in compactOverview.topLevel[0])
    && !("private_metadata" in compactOverview.topLevel[0]) && !("privateDaemonField" in compactOverview)
    && compactOverview?.capabilityRouting?.activity_hidden_by_authority === true
    && compactOverview?.daemonToolsHiddenByAuthority === true
    && !("last_task_resolution" in compactOverview.capabilityRouting)
    && !("tools" in compactOverview) && !("daemonTools" in compactOverview),
  "remote compact project_overview leaked cold-path identity/tool/path/activity fields or lost effective authority");
  assert(compactOverviewJson.length <= 2600,
    `remote compact project_overview exceeded its hot-path output budget: ${compactOverviewJson.length} chars`);

  const explicitFullOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const explicitFullOverviewPromise = toolCallRequest(base, editorToken, 2762, "project_overview", { detail: "full" });
  const explicitFullOverviewRelay = await explicitFullOverviewRelayPromise;
  assert(explicitFullOverviewRelay.arguments && Object.keys(explicitFullOverviewRelay.arguments).length === 0,
    "explicit full project_overview was not normalized for an older default-full daemon");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: explicitFullOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "",
      policy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      topLevel: [],
    },
  }));
  const explicitFullOverview = (await explicitFullOverviewPromise).body.result?.structuredContent;
  assert(Array.isArray(explicitFullOverview?.tools)
    && explicitFullOverview?.authorization?.account?.account_id === editorAccount.body.account.account_id
    && !("detail" in explicitFullOverview),
  "explicit full project_overview lost backward-compatible full authority fields");

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
  await Promise.resolve();
  assert(activeHttpRequests.size === 0,
    `worker integration left ${activeHttpRequests.size} HTTP request(s) unsettled`);
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
  await withTimeout(Promise.allSettled([...activeHttpRequests]), 3000,
    "outstanding worker integration HTTP requests").catch(() => {});
  await rm(persistDir, { recursive: true, force: true }).catch(() => {});
}

async function registerTestClient({ base, redirectUri, name }) {
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  });
  assert(registration.response.status === 201, `test client registration failed: ${registration.response.status}`);
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
    protocol_versions: ["2026-07-28"],
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

async function completeDaemonProbeWithRevocations(socket, probe, count) {
  const ready = waitForWsMessageSequence(socket, ["resume_calls", ...Array(count).fill("authority_revoke"), "ready_ack"]);
  socket.send(JSON.stringify({ type: "relay_probe_result", id: probe.id }));
  const messages = await ready;
  const resume = messages[0];
  assert(Array.isArray(resume.ids), "Worker revocation replay omitted resume_calls or its call-id array");
  return { resume, revocations: messages.slice(1, -1) };
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


function captureWsMessageTypes(socket) {
  const types = [];
  let parseError = null;
  const onMessage = (data) => {
    try { types.push(JSON.parse(String(data)).type); }
    catch (error) { parseError = error; }
  };
  socket.on("message", onMessage);
  return {
    stop() {
      socket.off("message", onMessage);
      if (parseError) throw parseError;
      return types;
    },
  };
}

function waitForWsMessage(socket, expectedType, timeoutMs = WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS, label = expectedType) {
  const callSite = new Error().stack?.split("\n")[2]?.trim() || "unknown call site";
  const interleavedTypes = expectedType === "tool_call" || expectedType === "cancel_call"
    ? new Set(["tool_result_ack"])
    : new Set();
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (data) => {
      try {
        const value = JSON.parse(String(data));
        if (value.type === expectedType) {
          cleanup();
          resolve(value);
          return;
        }
        if (interleavedTypes.has(value.type)) return;
        cleanup();
        reject(new Error(`expected websocket message ${expectedType}, received ${value.type}`));
      } catch (error) {
        cleanup();
        reject(error);
      }
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
  }), timeoutMs, `websocket message ${label} requested at ${callSite}`);
}

function waitForWsClose(socket, timeoutMs = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    socket.once("error", reject);
  }), timeoutMs, "daemon close");
}

function currentMcpHeaders(accessToken, method, name = "", version = "2026-07-28") {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": encodeMcpHeaderValue(name) } : {}),
  };
}

function currentMcpRequest(id, method, params, version = "2026-07-28") {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "worker-current-integration", version: "1" },
      },
    },
  };
}

async function currentMcpCall(origin, accessToken, id, method, params) {
  const name = method === "tools/call" ? String(params.name || "") : "";
  const response = await stableFetch(`${origin}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(accessToken, method, name),
    body: JSON.stringify(currentMcpRequest(id, method, params)),
  });
  const text = await response.text();
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    return { response, body: messages.at(-1) ?? {}, text };
  }
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body, text };
}

function encodeMcpHeaderValue(value) {
  const text = String(value);
  const plain = text === text.trim() && /^[\x20-\x7e]*$/.test(text) && !(text.startsWith("=?base64?") && text.endsWith("?="));
  return plain ? text : `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function toolCallRequest(origin, accessToken, id, name, argumentsValue) {
  return currentMcpCall(origin, accessToken, id, "tools/call", { name, arguments: argumentsValue });
}

async function daemonHttpExchange(body) {
  const serialized = JSON.stringify(body);
  const headers = createDaemonHttpRelayHeaders(
    DAEMON_SESSION_IDENTITY, base, "machine-bridge-mcp", pkg.version, serialized,
  );
  const response = await trackHttpRequest(fetch(`${base}/daemon/http`, {
    method: "POST", headers, body: serialized, signal: AbortSignal.timeout(10_000),
  }));
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`daemon HTTP exchange returned non-JSON status=${response.status}: ${text.slice(0, 256)}`); }
  return { response, body: parsed };
}

async function callTool(origin, accessToken, id, name, argumentsValue) {
  const response = await toolCallRequest(origin, accessToken, id, name, argumentsValue);
  assert(response.response.status === 200, `${name} call failed: ${response.response.status}`);
  return response.body;
}

async function callServerInfo(origin, accessToken, id, args = {}) {
  const response = await currentMcpCall(origin, accessToken, id, "tools/call", { name: "server_info", arguments: args });
  assert(response.response.status === 200, `server_info call failed: ${response.response.status}`);
  const text = response.body.result?.content?.[0]?.text;
  const structured = response.body.result?.structuredContent;
  assert(typeof text === "string", "server_info result did not contain text");
  assert(structured && typeof structured === "object", "server_info result omitted structuredContent");
  assert(JSON.stringify(structured) === JSON.stringify(JSON.parse(text)), "server_info text and structuredContent diverged");
  return structured;
}

async function callToolsList(origin, accessToken, id) {
  const response = await currentMcpCall(origin, accessToken, id, "tools/list", {});
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

function stableFetch(url, options = {}, attempts = 3) {
  return trackHttpRequest(stableFetchAttempt(url, options, attempts));
}

async function stableFetchAttempt(url, options = {}, attempts = 3) {
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
  return parseSseJsonRpcResponse(text);
}

function parseSseJsonRpcResponse(text) {
  const eventIds = text.split(/\r?\n/)
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice(4));
  const messages = parseSseJsonMessages(text);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && typeof messages[index] === "object") return { message: messages[index], eventIds, text };
  }
  throw new Error(`SSE response omitted a JSON-RPC message: ${text.slice(0, 512)}`);
}

function parseSseJsonMessages(text) {
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try { messages.push(JSON.parse(line.slice(6))); } catch {}
  }
  return messages;
}

async function readSseJsonMessages(reader, count) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const messages = parseSseJsonMessages(text);
    if (messages.length >= count) return messages.slice(0, count);
    const chunk = await reader.read();
    if (chunk.done) return messages;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function fetchJson(url, options) {
  return trackHttpRequest(fetchJsonResponse(url, options));
}

async function fetchJsonResponse(url, options) {
  const response = await stableFetchAttempt(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body };
}

function trackHttpRequest(promise) {
  const request = Promise.resolve(promise);
  activeHttpRequests.add(request);
  const release = () => { activeHttpRequests.delete(request); };
  request.then(release, release);
  return request;
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
