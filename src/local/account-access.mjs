import accessContract from "../shared/access-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";
import { policyProfile, toolNamesForPolicy, assertToolAllowed } from "./policy.mjs";

export const ACCOUNT_ACCESS_REVISION = Number(accessContract.revision);
export const ACCOUNT_ROLES = Object.freeze(Object.fromEntries(
  Object.entries(accessContract.roles).map(([name, value]) => [name, Object.freeze({ ...value })]),
));
export const OWNER_ACCOUNT_ROLE = String(accessContract.ownerRole);

export function normalizeAccountRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!ACCOUNT_ROLES[role]) throw new BridgeError("invalid_request", `unknown account role: ${role}`);
  return role;
}

export function accountRolePolicy(role) {
  const normalized = normalizeAccountRole(role);
  return policyProfile(ACCOUNT_ROLES[normalized].profile, "explicit");
}

export function accountRoleToolNames(role) {
  return toolNamesForPolicy(accountRolePolicy(role));
}

export class AccountAccessGate {
  assert(role, tool) {
    const normalized = normalizeAccountRole(role);
    assertToolAllowed(accountRolePolicy(normalized), tool);
    return normalized;
  }

  names(role) {
    return accountRoleToolNames(role);
  }
}
