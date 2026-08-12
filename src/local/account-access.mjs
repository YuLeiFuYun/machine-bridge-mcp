import accessContract from "../shared/access-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";
import { buildAuthorityContext } from "./authority-context.mjs";
import { policyProfile, toolNamesForPolicy, assertToolAllowed } from "./policy.mjs";

export const ACCOUNT_ACCESS_REVISION = Number(accessContract.revision);
const OWNER_ONLY_TOOLS = new Set((accessContract.ownerOnlyTools || []).map(String));
const ACCOUNT_ROLE_ENTRIES = Object.entries(accessContract.roles)
  .map(([name, value]) => [name, Object.freeze({ ...value })]);
const ACCOUNT_ROLE_BY_NAME = new Map(ACCOUNT_ROLE_ENTRIES);
export const ACCOUNT_ROLES = Object.freeze(Object.fromEntries(ACCOUNT_ROLE_ENTRIES));
export const DEFAULT_ACCOUNT_ROLE = String(accessContract.defaultRole);
export const OWNER_ACCOUNT_ROLE = String(accessContract.ownerRole);

export function normalizeAccountRole(value) {
  const role = String(value || "").trim().toLowerCase();
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
