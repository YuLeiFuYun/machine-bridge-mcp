import { createHash, randomBytes } from "node:crypto";
import { MCP_PROTOCOL_VERSION } from "../src/shared/mcp-protocol.mjs";
import { generateAccountPassword } from "../src/local/account-admin.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const SMALL_JSON_LIMIT = 64 * 1024;
const MCP_RESPONSE_LIMIT = 1024 * 1024;
const CANARY_ACCOUNT_DISPLAY_NAME = "Machine Bridge Release OAuth Canary";
export const RELEASE_OAUTH_CANARY_CALLBACK = "https://oauth-canary.invalid/callback";

export async function runReleaseOAuthCanaryFlow({
  admin,
  workerUrl,
  packageName,
  packageVersion,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
}) {
  if (!admin || typeof admin.create !== "function" || typeof admin.remove !== "function" || typeof admin.removeClient !== "function"
      || typeof admin.list !== "function" || typeof admin.listClients !== "function") {
    throw new TypeError("release OAuth canary requires an account-admin client");
  }
  await cleanupStaleCanaryState(admin);
  const origin = normalizeCanaryWorkerUrl(workerUrl);
  const name = requiredPackageName(packageName);
  const version = requiredPackageVersion(packageVersion);
  const accountName = `release-canary-${randomBytesImpl(8).toString("hex")}`;
  const password = generateAccountPassword();
  const verifier = randomBytesImpl(32).toString("base64url");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("release OAuth canary generated an invalid PKCE verifier");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateValue = randomBytesImpl(24).toString("base64url");
  const scope = `${name} offline_access`;
  const resource = `${origin}/mcp`;
  let accountId = "";
  let clientId = "";
  let primaryError = null;
  let workerVersion = "";

  try {
    const created = await canaryAdmin("temporary account creation", () => admin.create({
      name: accountName, displayName: CANARY_ACCOUNT_DISPLAY_NAME, role: "reviewer", password,
    }));
    accountId = String(created?.account?.account_id || "");
    if (!/^acct_[A-Za-z0-9_-]{20,96}$/.test(accountId)) throw new Error("release OAuth canary account creation returned an invalid account identity");

    const registration = await fetchBoundedJson(fetchImpl, "dynamic registration", `${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "machine-bridge-mcp-release-canary" },
      body: JSON.stringify({
        client_name: "Machine Bridge release OAuth canary",
        redirect_uris: [RELEASE_OAUTH_CANARY_CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }, SMALL_JSON_LIMIT, 201);
    clientId = String(registration.client_id || "");
    if (!/^mcp_client_[A-Za-z0-9_-]{43}$/.test(clientId)) throw new Error("release OAuth canary registration returned an invalid client identity");

    const authorizeResponse = await fetchBounded(fetchImpl, "authorization", `${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "machine-bridge-mcp-release-canary" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: RELEASE_OAUTH_CANARY_CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope,
        resource,
        state: stateValue,
        account_name: accountName,
        account_password: password,
      }),
      redirect: "manual",
    });
    if (authorizeResponse.status !== 303) throw new Error(`release OAuth canary authorization failed with HTTP ${authorizeResponse.status}`);
    const location = authorizeResponse.headers.get("location");
    if (!location) throw new Error("release OAuth canary authorization omitted the redirect location");
    const redirect = new URL(location);
    const code = redirect.searchParams.get("code") || "";
    if (redirect.origin + redirect.pathname !== RELEASE_OAUTH_CANARY_CALLBACK || redirect.searchParams.get("state") !== stateValue
        || redirect.searchParams.get("iss") !== origin || !/^mcp_code_[A-Za-z0-9_-]{43}$/.test(code)) {
      throw new Error("release OAuth canary authorization redirect failed validation");
    }

    const token = await fetchBoundedJson(fetchImpl, "authorization-code token exchange", `${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "machine-bridge-mcp-release-canary" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: RELEASE_OAUTH_CANARY_CALLBACK,
        code_verifier: verifier,
        resource,
      }),
    }, SMALL_JSON_LIMIT, 200);
    const accessToken = requiredToken(token.access_token, "access");
    const refreshToken = requiredToken(token.refresh_token, "refresh");
    if (token.token_type !== "Bearer" || token.scope !== scope) throw new Error("release OAuth canary token response changed the expected public-client contract");

    const firstInfo = await callServerInfo(fetchImpl, origin, accessToken, 1);
    workerVersion = String(firstInfo?.version || "");
    if (workerVersion !== version) throw new Error("release OAuth canary authenticated MCP reached the wrong Worker version");

    const refreshed = await fetchBoundedJson(fetchImpl, "refresh-token exchange", `${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "machine-bridge-mcp-release-canary" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource,
        scope,
      }),
    }, SMALL_JSON_LIMIT, 200);
    const refreshedAccess = requiredToken(refreshed.access_token, "refreshed access");
    const refreshedToken = requiredToken(refreshed.refresh_token, "refreshed refresh");
    if (refreshedAccess === accessToken || refreshedToken === refreshToken) {
      throw new Error("release OAuth canary refresh did not rotate both credentials");
    }
    const refreshedInfo = await callServerInfo(fetchImpl, origin, refreshedAccess, 2);
    if (String(refreshedInfo?.version || "") !== version) {
      throw new Error("release OAuth canary refreshed credential reached the wrong Worker version");
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (clientId) {
    try { await admin.removeClient({ clientId }); }
    catch (error) { cleanupErrors.push(new Error("release OAuth canary temporary client cleanup failed", { cause: error })); }
  }
  if (accountId) {
    try { await admin.remove({ accountId }); }
    catch (error) { cleanupErrors.push(new Error("release OAuth canary temporary account cleanup failed", { cause: error })); }
  }
  if (primaryError && cleanupErrors.length) {
    throw new AggregateError([primaryError, ...cleanupErrors], "release OAuth canary failed and temporary state cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "release OAuth canary temporary state cleanup was incomplete");

  return Object.freeze({
    workerVersion,
    authorizationCodeExchange: true,
    authenticatedMcp: true,
    refreshRotation: true,
    refreshedMcp: true,
    cleanupCompleted: true,
  });
}

async function cleanupStaleCanaryState(admin) {
  const accounts = await canaryAdmin("stale account discovery", () => admin.list());
  const accountList = Array.isArray(accounts?.accounts) ? accounts.accounts : [];
  if (!accountList.some((account) => account?.active === true && account?.role === "owner")) {
    throw new Error("release OAuth canary requires an existing active owner so synthetic reviewer state remains fully removable");
  }
  const staleAccounts = [];
  for (const account of Array.isArray(accounts?.accounts) ? accounts.accounts : []) {
    if (!/^release-canary-[0-9a-f]{16}$/.test(String(account?.name || ""))) continue;
    if (account?.role !== "reviewer" || account?.display_name !== CANARY_ACCOUNT_DISPLAY_NAME) {
      throw new Error("release OAuth canary refused to remove a synthetic-name account without the synthetic reviewer marker");
    }
    const accountId = String(account.account_id || "");
    if (!/^acct_[A-Za-z0-9_-]{20,96}$/.test(accountId)) {
      throw new Error("release OAuth canary found malformed stale synthetic account state");
    }
    staleAccounts.push(accountId);
  }
  if (staleAccounts.length === 0) return;
  const staleAccountIds = new Set(staleAccounts);
  const clients = await canaryAdmin("stale client discovery", () => admin.listClients());
  for (const client of Array.isArray(clients?.clients) ? clients.clients : []) {
    if (client?.client_name !== "Machine Bridge release OAuth canary"
        || !staleAccountIds.has(String(client?.trusted_account_id || ""))) continue;
    const clientId = String(client.client_id || "");
    if (!/^mcp_client_[A-Za-z0-9_-]{43}$/.test(clientId)) {
      throw new Error("release OAuth canary found malformed stale synthetic client state");
    }
    await canaryAdmin("stale client cleanup", () => admin.removeClient({ clientId }));
  }
  for (const accountId of staleAccounts) {
    await canaryAdmin("stale account cleanup", () => admin.remove({ accountId }));
  }
}

async function canaryAdmin(stage, callback) {
  try { return await callback(); }
  catch (error) { throw new Error(`release OAuth canary ${stage} failed`, { cause: error }); }
}

export function normalizeCanaryWorkerUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("release OAuth canary requires a credential-free HTTPS Worker origin");
  }
  return url.origin;
}

async function callServerInfo(fetchImpl, workerUrl, accessToken, id) {
  const response = await fetchBounded(fetchImpl, "authenticated MCP", `${workerUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "server_info",
      "user-agent": "machine-bridge-mcp-release-canary",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "server_info",
        arguments: { detail: "summary" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "machine-bridge-mcp-release-canary", version: "1" },
        },
      },
    }),
  });
  if (response.status !== 200) throw new Error(`release OAuth canary authenticated MCP failed with HTTP ${response.status}`);
  const payload = await readMcpPayload(response);
  if (payload?.error || !payload?.result?.structuredContent) throw new Error("release OAuth canary authenticated MCP returned an invalid result");
  return payload.result.structuredContent;
}

async function readMcpPayload(response) {
  const text = await readBoundedText(response, MCP_RESPONSE_LIMIT, "authenticated MCP response");
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try { last = JSON.parse(line.slice(6)); }
      catch { throw new Error("release OAuth canary MCP event stream contained invalid JSON"); }
    }
    if (!last) throw new Error("release OAuth canary MCP event stream contained no result");
    return last;
  }
  try { return JSON.parse(text); }
  catch { throw new Error("release OAuth canary MCP response was not valid JSON"); }
}

async function fetchBoundedJson(fetchImpl, stage, url, init, maximumBytes, expectedStatus) {
  const response = await fetchBounded(fetchImpl, stage, url, init);
  if (response.status !== expectedStatus) throw new Error(`release OAuth canary ${stage} failed with HTTP ${response.status}`);
  const text = await readBoundedText(response, maximumBytes, `${stage} response`);
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`release OAuth canary ${stage} response was not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`release OAuth canary ${stage} response was not a JSON object`);
  }
  return value;
}

async function fetchBounded(fetchImpl, stage, url, init) {
  try {
    return await fetchImpl(url, { redirect: "error", ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
  } catch (error) {
    throw new Error(`release OAuth canary ${stage} request failed`, { cause: error });
  }
}

async function readBoundedText(response, maximumBytes, label) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    try { await response.body?.cancel(); } catch { /* cleanup only */ }
    throw new Error(`release OAuth canary ${label} exceeded the size limit`);
  }
  if (!response.body) throw new Error(`release OAuth canary ${label} was empty`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        try { await reader.cancel("response size limit reached"); } catch { /* cleanup only */ }
        throw new Error(`release OAuth canary ${label} exceeded the size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(output); }
  catch { throw new Error(`release OAuth canary ${label} was not valid UTF-8`); }
}

function requiredToken(value, label) {
  const token = String(value || "");
  if (!/^mcp_(?:at|rt)_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`release OAuth canary ${label} token was invalid`);
  return token;
}

function requiredPackageName(value) {
  const name = String(value || "");
  if (name !== "machine-bridge-mcp") throw new Error("release OAuth canary package name is invalid");
  return name;
}

function requiredPackageVersion(value) {
  const version = String(value || "");
  if (!version || version.length > 128 || /[\r\n\t\u0000-\u001f\u007f]/.test(version)) {
    throw new Error("release OAuth canary package version is invalid");
  }
  return version;
}
