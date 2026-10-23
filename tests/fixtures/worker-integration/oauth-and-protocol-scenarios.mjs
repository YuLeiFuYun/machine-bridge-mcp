import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { runOfficialMcpConformance } from "../../../scripts/official-mcp-conformance.mjs";
import serverMetadata from "../../../src/shared/server-metadata.json" with { type: "json" };
import { workerToolsForRole } from "../../../src/worker/worker-tool-authority.ts";
import {
  registerTestClient, issueAccountToken, waitForWorker, fetchJson, stableFetch,
  adminRequest, currentMcpHeaders, currentMcpRequest, currentMcpCall, callToolsList,
  callTool, assert, appendBounded, cspDirectiveSources
} from "./common.mjs";

export async function runOAuthAndProtocolScenarios(context) {
  const {
    base, child, closed, pkg, packageRoot, TOOL_SCHEMA_GENERATION,
    OWNER_PASSWORD, REVIEWER_PASSWORD, EDITOR_PASSWORD, OPERATOR_PASSWORD,
  } = context;
  let { logs } = context;

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
  assert(!Object.hasOwn(publicMetadata.body.transport ?? {}, "initializationCompatibility"),
    "public MCP metadata advertised removed initialization compatibility");
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
  const operatorAccount = await fetchJson(`${base}/admin/accounts`, adminRequest("POST", "/admin/accounts", {
    name: "operator", role: "operator", password: OPERATOR_PASSWORD,
  }));
  assert(operatorAccount.response.status === 201, `operator account creation failed: ${operatorAccount.response.status}`);

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
      console.log(`official MCP conformance ${scenario}: exit ${conformance.code}`);
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
    && currentDiscovery.body.result?.instructions === serverMetadata.instructions.join("\n")
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
  const operatorRegistration = await registerTestClient({ base, redirectUri, name: "Operator Integration Client" });
  const operatorCredentials = await issueAccountToken({
    base,
    clientId: operatorRegistration.client_id,
    redirectUri,
    accountName: "operator",
    password: OPERATOR_PASSWORD,
    state: "operator-state",
  });
  const operatorToken = operatorCredentials.accessToken;

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
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "outdated-client", version: "1" } },
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


  return {
    ownerAccessToken,
    ownerRefreshToken,
    reviewerToken,
    reviewerRefreshToken,
    reviewerRegistration,
    reviewerAccount,
    editorToken,
    editorAccount,
    operatorToken,
    operatorAccount,
    ownerAccount,
    redirectUri,
    registration,
    authorization,
    stableOwnerToolNames,
  };
}
