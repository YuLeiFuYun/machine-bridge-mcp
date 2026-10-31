// @ts-check

import { BridgeError } from "./errors.mjs";
import { intersectPolicies, normalizePolicy, policyProfile } from "./policy.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;
const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;
const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

/** @typedef {"reviewer" | "editor" | "operator" | "owner"} AccountRole */
/** @typedef {{account_id?: unknown, account_version?: unknown, client_id?: unknown, family_id?: unknown, role?: unknown}} RelayAuthorization */
/** @typedef {{kind: "local", role: "owner"} | {kind: "account", accountId: string, accountVersion: number, clientId: string, familyId: string, role: AccountRole}} AuthorityPrincipal */
/** @typedef {ReturnType<typeof normalizePolicy>} NormalizedPolicy */
/** @typedef {{origin: "local" | "relay", principal: AuthorityPrincipal, daemonPolicy: NormalizedPolicy, accountPolicy: NormalizedPolicy, effectivePolicy: NormalizedPolicy, owner: boolean}} AuthorityContext */
/** @typedef {{authorization?: RelayAuthorization, daemonPolicy?: unknown, origin?: "local" | "relay"}} BuildAuthorityOptions */
/** @typedef {{origin?: string, authority?: {principal?: AuthorityPrincipal, effectivePolicy?: NormalizedPolicy}}} OperationContext */
/** @typedef {{owner_kind?: unknown, owner_account_id?: unknown, owner_account_version?: unknown, owner_client_id?: unknown, owner_family_id?: unknown}} OwnedRecord */

/** @param {BuildAuthorityOptions} [options] */
export function buildAuthorityContext({ authorization = {}, daemonPolicy, origin = "local" } = {}) {
  if (origin !== "relay") {
    const policy = normalizePolicy(daemonPolicy || {});
    return Object.freeze({
      origin: "local",
      principal: Object.freeze({ kind: "local", role: "owner" }),
      daemonPolicy: policy,
      accountPolicy: policy,
      effectivePolicy: policy,
      owner: true,
    });
  }

  const accountId = authorization.account_id;
  const clientId = authorization.client_id;
  const familyId = authorization.family_id;
  const role = authorization.role;
  const accountVersion = authorization.account_version;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)
      || typeof clientId !== "string" || !CLIENT_ID.test(clientId)
      || typeof familyId !== "string" || !FAMILY_ID.test(familyId)
      || !isAccountRole(role)
      || typeof accountVersion !== "number" || !Number.isSafeInteger(accountVersion) || accountVersion <= 0) {
    throw new BridgeError("authorization_denied", "relay operation is missing authenticated principal identity");
  }
  const accountPolicy = policyProfile(roleProfile(role), "explicit");
  const normalizedDaemonPolicy = normalizePolicy(daemonPolicy || {});
  const effectivePolicy = intersectPolicies(normalizedDaemonPolicy, accountPolicy, { origin: "effective" });
  const principal = Object.freeze({
    kind: "account",
    accountId,
    accountVersion,
    clientId,
    familyId,
    role,
  });
  return Object.freeze({
    origin: "relay",
    principal,
    daemonPolicy: normalizedDaemonPolicy,
    accountPolicy,
    effectivePolicy,
    owner: role === "owner",
  });
}

/**
 * A relay operation is delegated when it acts for a non-owner account. Local owner operations
 * and owner-role relay operations retain the full local authority boundary. This predicate is
 * shared by every path that must hide sensitive files from delegated remote callers.
 * @param {unknown} context
 */
export function isDelegatedRelayContext(context) {
  const record = /** @type {Record<string, unknown>} */ (context !== null && typeof context === "object" ? context : {});
  const authority = /** @type {Record<string, unknown>} */ (record.authority !== null && typeof record.authority === "object" ? record.authority : {});
  const principal = /** @type {Record<string, unknown>} */ (authority.principal !== null && typeof authority.principal === "object" ? authority.principal : {});
  return record.origin === "relay" && principal.kind === "account"
    && principal.role !== "owner" && authority.owner !== true;
}

/** @param {OperationContext | null | undefined} context @param {NormalizedPolicy | undefined} fallbackPolicy */
export function policyForContext(context, fallbackPolicy) {
  return normalizePolicy(context?.authority?.effectivePolicy || fallbackPolicy || {});
}

const LOCAL_OWNER_PRINCIPAL = Object.freeze({ kind: "local", role: "owner" });

/**
 * Resolve the principal that owns an operation. A context that carries an authority
 * object must carry an authenticated principal; only a context with no authority
 * object at all is treated as the local owner (the default for internal local APIs).
 * A relay-marked context without a principal is always denied, never upgraded to
 * local-owner authority.
 * @param {OperationContext | null | undefined} context
 */
export function principalForContext(context) {
  const authority = context?.authority;
  const principal = authority?.principal;
  if (principal?.kind === "account") return principal;
  if (principal?.kind === "local" && principal.role === "owner") return principal;
  if (authority !== undefined || context?.origin === "relay") {
    throw new BridgeError("authorization_denied", "operation is missing explicit authenticated authority context");
  }
  return LOCAL_OWNER_PRINCIPAL;
}

/** @param {OperationContext | null | undefined} context */
export function principalBinding(context) {
  const principal = principalForContext(context);
  if (principal.kind !== "account") return { owner_kind: "local" };
  return {
    owner_kind: "account",
    owner_account_id: principal.accountId,
    owner_account_version: principal.accountVersion,
    owner_client_id: principal.clientId,
    owner_family_id: principal.familyId,
    owner_role: principal.role,
  };
}

/** @param {OwnedRecord | null | undefined} record @param {OperationContext | null | undefined} context @param {string} [label] */
export function assertOwnedByContext(record, context, label = "object") {
  const principal = principalForContext(context);
  if (principal.kind !== "account" || principal.role === "owner") return;
  if (
    record?.owner_kind !== "account"
    || record.owner_account_id !== principal.accountId
    || record.owner_account_version !== principal.accountVersion
    || record.owner_client_id !== principal.clientId
    || record.owner_family_id !== principal.familyId
  ) {
    throw new BridgeError("authorization_denied", `${label} belongs to another account or an obsolete account session`);
  }
}

/** @param {OwnedRecord | null | undefined} record @param {OperationContext | null | undefined} context */
export function visibleToContext(record, context) {
  try {
    assertOwnedByContext(record, context);
    return true;
  } catch {
    return false;
  }
}

/** @param {AccountRole} role */
function roleProfile(role) {
  const mapping = {
    reviewer: "review",
    editor: "edit",
    operator: "agent",
    owner: "full",
  };
  return mapping[role];
}

/** @param {unknown} value @returns {value is AccountRole} */
function isAccountRole(value) {
  return value === "reviewer" || value === "editor" || value === "operator" || value === "owner";
}
