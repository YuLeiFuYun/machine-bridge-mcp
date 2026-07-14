import { randomBytes } from "node:crypto";
import { ACCOUNT_ROLES, normalizeAccountRole } from "./account-access.mjs";
import { BridgeError } from "./errors.mjs";

const REQUEST_TIMEOUT_MS = 15_000;

export function generateAccountPassword() {
  return `account_password_${randomBytes(32).toString("base64url")}`;
}

export class AccountAdminClient {
  constructor({ workerUrl, adminSecret, fetchImpl = fetch }) {
    this.workerUrl = normalizeWorkerUrl(workerUrl);
    if (typeof adminSecret !== "string" || adminSecret.length < 24) throw new BridgeError("invalid_request", "account administration secret is missing");
    this.adminSecret = adminSecret;
    this.fetchImpl = fetchImpl;
  }

  list() {
    return this.request("GET", "/admin/accounts");
  }

  create({ name, role, password, displayName = "" }) {
    return this.request("POST", "/admin/accounts", {
      name: normalizeAccountName(name),
      role: normalizeAccountRole(role),
      password: String(password || ""),
      ...(displayName ? { display_name: String(displayName) } : {}),
    });
  }

  update({ accountId, role, active, displayName }) {
    return this.request("PATCH", "/admin/accounts", {
      account_id: requiredAccountId(accountId),
      ...(role === undefined ? {} : { role: normalizeAccountRole(role) }),
      ...(active === undefined ? {} : { active: Boolean(active) }),
      ...(displayName === undefined ? {} : { display_name: String(displayName) }),
    });
  }

  rotatePassword({ accountId, password }) {
    return this.request("POST", "/admin/accounts/rotate-password", {
      account_id: requiredAccountId(accountId),
      password: String(password || ""),
    });
  }

  remove({ accountId }) {
    return this.request("DELETE", "/admin/accounts", { account_id: requiredAccountId(accountId) });
  }

  async find(target) {
    const result = await this.list();
    const value = String(target || "").trim().toLowerCase();
    const matches = result.accounts.filter((account) => account.account_id === target || account.name === value);
    if (matches.length !== 1) throw new BridgeError(matches.length ? "conflict" : "not_found", matches.length ? "account target is ambiguous" : "account was not found");
    return matches[0];
  }

  async request(method, pathname, body) {
    const response = await this.fetchImpl(`${this.workerUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.adminSecret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    }).catch((error) => {
      throw new BridgeError("network_error", "account administration request failed", { cause: error, retryable: true });
    });
    if (response.status === 204) return { removed: true };
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : `account administration failed (${response.status})`;
      throw new BridgeError(response.status === 404 ? "not_found" : response.status === 409 ? "conflict" : response.status === 401 ? "authentication_failed" : "invalid_request", message);
    }
    return payload;
  }
}

export function accountRoleNames() {
  return Object.keys(ACCOUNT_ROLES);
}

function normalizeWorkerUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BridgeError("invalid_request", "Worker URL must be a credential-free HTTPS origin");
  }
  return url.origin;
}

function normalizeAccountName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/.test(name)) throw new BridgeError("invalid_request", "account name must contain 3-64 lowercase letters, digits, dots, underscores, or hyphens");
  return name;
}

function requiredAccountId(value) {
  const id = String(value || "");
  if (!/^acct_[A-Za-z0-9_-]{20,96}$/.test(id)) throw new BridgeError("invalid_request", "account id is invalid");
  return id;
}
