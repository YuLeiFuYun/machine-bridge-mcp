import { ADMIN_AUTH_SCHEME, ADMIN_AUTH_TTL_SECONDS, adminAuthTranscript } from "../shared/admin-auth.mjs";
import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { decodeBase64Url, verifyDeviceSessionCertificate, verifyP256Signature } from "./device-session-verifier.ts";
import { json, methodNotAllowed, parseRequestBody, readBoundedBytes } from "./http.ts";
import { consumeBoundedNonce } from "./nonce-store.ts";
import {
  accountByName, createAccount, publicAccount, replaceAccountPassword, revokeAccountCredentials,
  updateAccount, type AccountRecord, type OAuthStore,
} from "./oauth-state.ts";

const BODY_LIMIT_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 64;

export interface AccountAdminAuthorization {
  nonce: string;
  expiresAt: number;
  request: Request;
}

export async function accountAdminAuthorized(
  request: Request,
  rootPublicKeyJson: string,
  workerOrigin: string,
  server: string,
  version: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AccountAdminAuthorization | null> {
  if (!rootPublicKeyJson) return null;
  const scheme = request.headers.get("X-Bridge-Admin-Scheme") || "";
  const issuedAt = Number(request.headers.get("X-Bridge-Admin-Time"));
  const nonce = request.headers.get("X-Bridge-Admin-Nonce") || "";
  const bodyHash = request.headers.get("X-Bridge-Admin-Body-SHA256") || "";
  const keyId = request.headers.get("X-Bridge-Admin-Key") || "";
  const suppliedSignature = decodeBase64Url(request.headers.get("X-Bridge-Admin-Signature") || "", 64);
  if (scheme !== ADMIN_AUTH_SCHEME || !suppliedSignature) return null;
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > ADMIN_AUTH_TTL_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodyHash) || !/^device_[A-Za-z0-9_-]{32}$/.test(keyId)) return null;
  const certificate = await verifyDeviceSessionCertificate({
    encodedCertificate: request.headers.get("X-Bridge-Device-Certificate") || "",
    rootPublicKeyJson,
    workerOrigin,
    server,
    version,
    now,
  });
  if (!certificate || certificate.sessionKeyId !== keyId) return null;
  let transcript: string;
  try {
    transcript = adminAuthTranscript({
      origin: new URL(request.url).origin,
      method: request.method.toUpperCase(),
      pathname: new URL(request.url).pathname,
      bodyHash,
      keyId,
      issuedAt,
      nonce,
    });
  } catch {
    return null;
  }
  if (!(await verifyP256Signature(certificate.sessionPublicJwk, transcript, suppliedSignature))) return null;
  const body = await readBoundedBytes(request, BODY_LIMIT_BYTES);
  const actualBodyHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  if (bodyHash !== actualBodyHash) return null;
  return {
    nonce,
    expiresAt: Math.max(now, issuedAt) + ADMIN_AUTH_TTL_SECONDS,
    request: rebuildBoundedAdminRequest(request, body),
  };
}

function rebuildBoundedAdminRequest(request: Request, body: Uint8Array<ArrayBuffer>): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const method = request.method.toUpperCase();
  return new Request(request.url, {
    method, headers,
    body: method === "GET" || method === "HEAD" || body.byteLength === 0 ? undefined : body.buffer,
  });
}

export async function consumeAccountAdminNonce(
  storage: DurableObjectStorage,
  authorization: AccountAdminAuthorization,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return consumeBoundedNonce(storage, {
    key: "account-admin-nonces",
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
    now,
    noncePattern: /^[A-Za-z0-9_-]{32,128}$/,
    maximum: 256,
    maxFutureSeconds: ADMIN_AUTH_TTL_SECONDS * 2,
  });
}

export async function handleAccountAdminOperation(options: {
  request: Request;
  operation: "accounts" | "rotate-password";
  store: OAuthStore;
  save: (revocation?: AuthorityRevocation) => Promise<void>;
  now: number;
}): Promise<Response> {
  const { request, operation, store, save, now } = options;
  if (operation === "rotate-password") return rotatePassword(request, store, save, now);
  if (request.method === "GET") {
    const accounts = Object.values(store.accounts)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(publicAccount);
    return json({ accounts, maximum: MAX_ACCOUNTS });
  }
  const body = await parseRequestBody(request, BODY_LIMIT_BYTES);
  if (request.method === "POST") return create(request, body, store, save, now);
  if (request.method === "PATCH") return update(body, store, save, now);
  if (request.method === "DELETE") return remove(body, store, save);
  return methodNotAllowed("GET, POST, PATCH, DELETE");
}

async function create(
  _request: Request,
  body: Record<string, unknown>,
  store: OAuthStore,
  save: () => Promise<void>,
  now: number,
): Promise<Response> {
  if (Object.keys(store.accounts).length >= MAX_ACCOUNTS) return json({ error: "account_limit_reached" }, 409);
  if (accountByName(store, body.name)) return json({ error: "account_name_exists" }, 409);
  if (Object.keys(store.accounts).length === 0 && body.role !== "owner") return json({ error: "first_account_must_be_owner" }, 409);
  let account: AccountRecord;
  try {
    account = await createAccount({ name: body.name, displayName: body.display_name, role: body.role, password: body.password, now });
  } catch {
    return json({ error: "invalid_account", message: "account name, display name, role, or password is invalid" }, 400);
  }
  store.accounts[account.account_id] = account;
  await save();
  return json({ account: publicAccount(account) }, 201);
}

async function update(body: Record<string, unknown>, store: OAuthStore, save: (revocation?: AuthorityRevocation) => Promise<void>, now: number): Promise<Response> {
  const account = store.accounts[String(body.account_id ?? "")];
  if (!account) return json({ error: "account_not_found" }, 404);
  const previousVersion = account.version;
  const removesLastOwner = account.active && account.role === "owner" && activeOwnerCount(store) === 1
    && (body.active === false || (body.role !== undefined && body.role !== "owner"));
  if (removesLastOwner) return json({ error: "last_owner_required" }, 409);
  try {
    updateAccount(account, { displayName: body.display_name, role: body.role, active: body.active }, now);
  } catch {
    return json({ error: "invalid_account", message: "account display name, role, or active state is invalid" }, 400);
  }
  revokeAccountCredentials(store, account.account_id);
  await save(account.version !== previousVersion ? {
    accountId: account.account_id,
    accountVersion: previousVersion,
  } : undefined);
  return json({ account: publicAccount(account) });
}

async function remove(body: Record<string, unknown>, store: OAuthStore, save: (revocation?: AuthorityRevocation) => Promise<void>): Promise<Response> {
  const accountId = String(body.account_id ?? "");
  const account = store.accounts[accountId];
  if (!account) return json({ error: "account_not_found" }, 404);
  if (account.active && account.role === "owner" && activeOwnerCount(store) === 1) return json({ error: "last_owner_required" }, 409);
  revokeAccountCredentials(store, accountId);
  delete store.accounts[accountId];
  await save({ accountId, accountVersion: account.version });
  return new Response(null, { status: 204 });
}

async function rotatePassword(request: Request, store: OAuthStore, save: (revocation?: AuthorityRevocation) => Promise<void>, now: number): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseRequestBody(request, BODY_LIMIT_BYTES);
  const account = store.accounts[String(body.account_id ?? "")];
  if (!account) return json({ error: "account_not_found" }, 404);
  const previousVersion = account.version;
  try {
    await replaceAccountPassword(account, body.password, now);
  } catch {
    return json({ error: "invalid_password", message: "account password must be a generated 256-bit token" }, 400);
  }
  revokeAccountCredentials(store, account.account_id);
  await save({ accountId: account.account_id, accountVersion: previousVersion });
  return json({ account: publicAccount(account) });
}

function activeOwnerCount(store: OAuthStore): number {
  return Object.values(store.accounts).filter((account) => account.active && account.role === "owner").length;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
