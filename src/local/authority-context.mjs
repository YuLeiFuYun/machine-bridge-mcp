import { BridgeError } from "./errors.mjs";
import { intersectPolicies, normalizePolicy, policyProfile } from "./policy.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;
const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;
const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

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

  const accountId = String(authorization.account_id || "");
  const clientId = String(authorization.client_id || "");
  const familyId = String(authorization.family_id || "");
  const role = String(authorization.role || "").trim().toLowerCase();
  const accountVersion = Number(authorization.account_version);
  if (!ACCOUNT_ID.test(accountId) || !CLIENT_ID.test(clientId) || !FAMILY_ID.test(familyId) || !Number.isSafeInteger(accountVersion) || accountVersion <= 0) {
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

export function policyForContext(context, fallbackPolicy) {
  return normalizePolicy(context?.authority?.effectivePolicy || fallbackPolicy || {});
}

export function principalForContext(context) {
  const principal = context?.authority?.principal;
  if (principal?.kind === "account") return principal;
  return Object.freeze({ kind: "local", role: "owner" });
}

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

export function visibleToContext(record, context) {
  try {
    assertOwnedByContext(record, context);
    return true;
  } catch {
    return false;
  }
}

function roleProfile(role) {
  const mapping = {
    reviewer: "review",
    editor: "edit",
    operator: "agent",
    owner: "full",
  };
  const profile = mapping[role];
  if (!profile) throw new BridgeError("authorization_denied", `unknown account role: ${role}`);
  return profile;
}
