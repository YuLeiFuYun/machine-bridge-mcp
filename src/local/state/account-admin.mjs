import accessContract from "../../shared/access-contract.json" with { type: "json" };
import { BridgeError } from "../core/errors.mjs";
import { buildAuthorityContext } from "../core/authority.mjs";
import { policyProfile, toolNamesForPolicy, assertToolAllowed } from "../core/policy.mjs";
import { createHash, randomBytes } from "node:crypto";
import { ADMIN_AUTH_SCHEME, adminAuthTranscript } from "../../shared/admin-auth.mjs";
import { encodeDeviceSessionCertificate, signWithDeviceSessionIdentity, validateDeviceSessionIdentity } from "./device-identity.mjs";

const OWNER_ONLY_TOOLS = new Set((accessContract.ownerOnlyTools || []).map(String));

const ACCOUNT_ROLE_ENTRIES = Object.entries(accessContract.roles)
  .map(([name, value]) => [name, Object.freeze({ ...value })]);

const ACCOUNT_ROLE_BY_NAME = new Map(ACCOUNT_ROLE_ENTRIES);

export const ACCOUNT_ROLES = Object.freeze(Object.fromEntries(ACCOUNT_ROLE_ENTRIES));

export const OWNER_ACCOUNT_ROLE = String(accessContract.ownerRole);

export function normalizeAccountRole(value) {
  if (typeof value !== "string") throw new BridgeError("invalid_request", "unknown account role");
  const role = value.trim().toLowerCase();
  if (!ACCOUNT_ROLE_BY_NAME.has(role)) throw new BridgeError("invalid_request", `unknown account role: ${role}`);
  return role;
}

export function accountRolePolicy(role) {
  const normalized = normalizeAccountRole(role);
  return policyProfile(ACCOUNT_ROLE_BY_NAME.get(normalized).profile, "explicit");
}

export function accountRoleToolNames(role) {
  const normalized = normalizeAccountRole(role);
  const names = toolNamesForPolicy(accountRolePolicy(normalized));
  return normalized === OWNER_ACCOUNT_ROLE ? names : names.filter((name) => !OWNER_ONLY_TOOLS.has(name));
}

export class AccountAccessGate {
  assert(role, tool) {
    const normalized = normalizeAccountRole(role);
    if (normalized !== OWNER_ACCOUNT_ROLE && OWNER_ONLY_TOOLS.has(String(tool || ""))) {
      throw new BridgeError("authorization_denied", `tool is reserved for the owner account: ${String(tool || "")}`);
    }
    assertToolAllowed(accountRolePolicy(normalized), tool);
    return normalized;
  }

  authority(authorization, daemonPolicy, origin = "relay") {
    const role = origin === "relay" ? normalizeAccountRole(authorization?.role) : "owner";
    return buildAuthorityContext({ authorization: { ...authorization, role }, daemonPolicy, origin });
  }

  names(role) {
    return accountRoleToolNames(role);
  }
}
const MAX_ADMIN_RESPONSE_BYTES = 1024 * 1024;

const MAX_ADMIN_ERROR_CHARS = 2_000;

export function isReadOnlyAdminMethod(method) { return method === "GET" || method === "HEAD"; }

export async function validateAdminResponseStatus(response, method, pathname) {
  const expectedStatus = method === "DELETE" && pathname === "/admin/accounts" ? 204
    : method === "POST" && pathname === "/admin/accounts" ? 201 : 200;
  if (!response.ok || response.status === expectedStatus) return;
  await cancelResponseBody(response.body);
  throw adminResponseProtocolError(response, method, "account administration response used an unexpected success status");
}

export function boundedRemoteAdminMessage(payload, status) {
  const fallback = `account administration failed (${status})`;
  const candidate = typeof payload?.message === "string" ? payload.message : typeof payload?.error === "string" ? payload.error : fallback;
  const normalized = candidate.replace(/[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, MAX_ADMIN_ERROR_CHARS);
}

export async function readAdminJsonResponse(response, method) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_ADMIN_RESPONSE_BYTES) {
    await cancelResponseBody(response.body);
    throw adminResponseProtocolError(response, method, "account administration response exceeded the size limit");
  }
  if (!response.body) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was empty");
    return {};
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_ADMIN_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw adminResponseProtocolError(response, method, "account administration response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let payload;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks, bytes));
    payload = JSON.parse(text);
  } catch (cause) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was not valid JSON", cause);
    return {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was not a JSON object");
    return {};
  }
  return payload;
}

function adminResponseProtocolError(response, method, message, cause) {
  const mutation = response.ok && !isReadOnlyAdminMethod(method);
  return new BridgeError("protocol_error", message, {
    ...(cause ? { cause } : {}),
    ...(mutation ? { retryable: false, details: { request_delivery: "sent", effect_settlement: "unknown" } } : {}),
  });
}

async function cancelResponseBody(body) {
  if (!body) return;
  const reader = body.getReader();
  try { await cancelReader(reader); } finally { reader.releaseLock(); }
}

async function cancelReader(reader) {
  try { await reader.cancel("response size limit reached"); } catch { /* cleanup only */ }
}

function concatBytes(chunks, bytes) {
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
const REQUEST_TIMEOUT_MS = 15_000;

export function generateAccountPassword() {
  return `account_password_${randomBytes(32).toString("base64url")}`;
}

export class AccountAdminClient {
  constructor({ workerUrl, sessionIdentity, fetchImpl = fetch }) {
    this.workerUrl = normalizeWorkerUrl(workerUrl);
    this.sessionIdentity = validateDeviceSessionIdentity(sessionIdentity);
    this.fetchImpl = fetchImpl;
  }

  list() { return this.request("GET", "/admin/accounts"); }
  listClients() { return this.request("GET", "/admin/clients"); }

  removeClient({ clientId }) {
    if (typeof clientId !== "string" || !/^mcp_client_[A-Za-z0-9_-]{43}$/.test(clientId)) throw new BridgeError("invalid_request", "OAuth client id is invalid");
    return this.request("DELETE", "/admin/clients", { client_id: clientId });
  }

  create({ name, role, password, displayName = "" }) {
    if (typeof password !== "string") throw new BridgeError("invalid_request", "account password is invalid");
    if (typeof displayName !== "string") throw new BridgeError("invalid_request", "account display name is invalid");
    return this.request("POST", "/admin/accounts", {
      name: normalizeAccountName(name),
      role: normalizeAccountRole(role),
      password,
      ...(displayName ? { display_name: displayName } : {}),
    });
  }

  update({ accountId, role, active, displayName }) {
    if (active !== undefined && typeof active !== "boolean") throw new BridgeError("invalid_request", "account active flag must be a boolean");
    if (displayName !== undefined && typeof displayName !== "string") throw new BridgeError("invalid_request", "account display name is invalid");
    return this.request("PATCH", "/admin/accounts", {
      account_id: requiredAccountId(accountId),
      ...(role === undefined ? {} : { role: normalizeAccountRole(role) }),
      ...(active === undefined ? {} : { active }),
      ...(displayName === undefined ? {} : { display_name: displayName }),
    });
  }

  rotatePassword({ accountId, password }) {
    if (typeof password !== "string") throw new BridgeError("invalid_request", "account password is invalid");
    return this.request("POST", "/admin/accounts/rotate-password", {
      account_id: requiredAccountId(accountId),
      password,
    });
  }

  remove({ accountId }) {
    return this.request("DELETE", "/admin/accounts", { account_id: requiredAccountId(accountId) });
  }

  async find(target) {
    if (typeof target !== "string") throw new BridgeError("invalid_request", "account target must be a string");
    const result = await this.list();
    const value = target.trim().toLowerCase();
    const matches = result.accounts.filter((account) => account.account_id === target || account.name === value);
    if (matches.length !== 1) throw new BridgeError(matches.length ? "conflict" : "not_found", matches.length ? "account target is ambiguous" : "account was not found");
    return matches[0];
  }

  async request(method, pathname, body) {
    const serializedBody = body === undefined ? "" : JSON.stringify(body);
    const headers = accountAdminRequestHeaders({
      sessionIdentity: this.sessionIdentity,
      origin: this.workerUrl,
      method,
      pathname,
      body: serializedBody,
    });
    const response = await this.fetchImpl(`${this.workerUrl}${pathname}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : serializedBody,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    }).catch((error) => {
      const retryable = isReadOnlyAdminMethod(method);
      throw new BridgeError("network_error", "account administration request failed", {
        cause: error,
        retryable,
        ...(retryable ? {} : { details: { request_delivery: "unknown", effect_settlement: "unknown" } }),
      });
    });
    await validateAdminResponseStatus(response, method, pathname);
    if (response.status === 204) return { removed: true };
    const payload = await readAdminJsonResponse(response, method);
    if (!response.ok) {
      const message = boundedRemoteAdminMessage(payload, response.status);
      if (response.status >= 500) {
        const retryable = isReadOnlyAdminMethod(method);
        throw new BridgeError("unavailable", message, {
          retryable,
          ...(retryable ? {} : { details: { request_delivery: "sent", effect_settlement: "unknown" } }),
        });
      }
      throw new BridgeError(response.status === 404 ? "not_found" : response.status === 409 ? "conflict" : response.status === 401 ? "authentication_failed" : "invalid_request", message);
    }
    return payload;
  }
}

export function accountAdminRequestHeaders({
  sessionIdentity,
  origin,
  method,
  pathname,
  body = "",
  now = Date.now(),
  nonce = randomBytes(24).toString("base64url"),
}) {
  validateDeviceSessionIdentity(sessionIdentity, now);
  if (typeof method !== "string" || typeof body !== "string") throw new Error("account admin signing input is invalid");
  const issuedAt = Math.floor(now / 1000);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const transcript = adminAuthTranscript({
    origin,
    method: String(method).toUpperCase(),
    pathname,
    bodyHash,
    keyId: sessionIdentity.keyId,
    issuedAt,
    nonce,
  });
  return {
    "X-Bridge-Admin-Scheme": ADMIN_AUTH_SCHEME,
    "X-Bridge-Admin-Time": String(issuedAt),
    "X-Bridge-Admin-Nonce": nonce,
    "X-Bridge-Admin-Body-SHA256": bodyHash,
    "X-Bridge-Admin-Key": sessionIdentity.keyId,
    "X-Bridge-Admin-Signature": signWithDeviceSessionIdentity(sessionIdentity, transcript, now),
    "X-Bridge-Device-Certificate": encodeDeviceSessionCertificate(sessionIdentity, now),
  };
}

export function accountRoleNames() { return Object.keys(ACCOUNT_ROLES); }

function normalizeWorkerUrl(value) {
  if (typeof value !== "string") throw new BridgeError("invalid_request", "Worker URL must be a credential-free HTTPS origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BridgeError("invalid_request", "Worker URL must be a credential-free HTTPS origin");
  }
  return url.origin;
}

function normalizeAccountName(value) {
  if (typeof value !== "string") throw new BridgeError("invalid_request", "account name must contain 3-64 lowercase letters, digits, dots, underscores, or hyphens");
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(name)) throw new BridgeError("invalid_request", "account name must contain 3-64 lowercase letters, digits, dots, underscores, or hyphens");
  return name;
}

function requiredAccountId(value) {
  if (typeof value !== "string") throw new BridgeError("invalid_request", "account id is invalid");
  const id = value;
  if (!/^acct_[A-Za-z0-9_-]{20,96}$/.test(id)) throw new BridgeError("invalid_request", "account id is invalid");
  return id;
}
