import { json, methodNotAllowed, parseRequestBody } from "./http";
import {
  accountByName, createAccount, publicAccount, replaceAccountPassword, revokeAccountCredentials,
  safeEqual, updateAccount, type AccountRecord, type OAuthStore,
} from "./oauth-state";

const BODY_LIMIT_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 64;

export async function accountAdminAuthorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const supplied = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? "";
  return Boolean(expected && await safeEqual(supplied, expected));
}

export async function handleAccountAdminOperation(options: {
  request: Request;
  operation: "accounts" | "rotate-password";
  store: OAuthStore;
  save: () => Promise<void>;
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

async function update(body: Record<string, unknown>, store: OAuthStore, save: () => Promise<void>, now: number): Promise<Response> {
  const account = store.accounts[String(body.account_id ?? "")];
  if (!account) return json({ error: "account_not_found" }, 404);
  const removesLastOwner = account.active && account.role === "owner" && activeOwnerCount(store) === 1
    && (body.active === false || (body.role !== undefined && body.role !== "owner"));
  if (removesLastOwner) return json({ error: "last_owner_required" }, 409);
  try {
    updateAccount(account, { displayName: body.display_name, role: body.role, active: body.active }, now);
  } catch {
    return json({ error: "invalid_account", message: "account display name, role, or active state is invalid" }, 400);
  }
  revokeAccountCredentials(store, account.account_id);
  await save();
  return json({ account: publicAccount(account) });
}

async function remove(body: Record<string, unknown>, store: OAuthStore, save: () => Promise<void>): Promise<Response> {
  const accountId = String(body.account_id ?? "");
  const account = store.accounts[accountId];
  if (!account) return json({ error: "account_not_found" }, 404);
  if (account.active && account.role === "owner" && activeOwnerCount(store) === 1) return json({ error: "last_owner_required" }, 409);
  revokeAccountCredentials(store, accountId);
  delete store.accounts[accountId];
  await save();
  return new Response(null, { status: 204 });
}

async function rotatePassword(request: Request, store: OAuthStore, save: () => Promise<void>, now: number): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseRequestBody(request, BODY_LIMIT_BYTES);
  const account = store.accounts[String(body.account_id ?? "")];
  if (!account) return json({ error: "account_not_found" }, 404);
  try {
    await replaceAccountPassword(account, body.password, now);
  } catch {
    return json({ error: "invalid_password", message: "account password must be a generated 256-bit token" }, 400);
  }
  revokeAccountCredentials(store, account.account_id);
  await save();
  return json({ account: publicAccount(account) });
}

function activeOwnerCount(store: OAuthStore): number {
  return Object.values(store.accounts).filter((account) => account.active && account.role === "owner").length;
}
