import accessContract from "../shared/access-contract.json" with { type: "json" };
import policyContract from "../shared/policy-contract.json" with { type: "json" };
import toolCatalog from "../shared/tool-catalog.json" with { type: "json" };
import { policyAllowsAvailability, type DaemonPolicy } from "./policy.ts";

export type AccountRole = keyof typeof accessContract.roles;

export interface AuthorizedToken {
  tokenKey: string;
  accountId: string;
  accountVersion: number;
  clientId: string;
  familyId: string;
  dpopJkt: string;
  role: AccountRole;
}

const roles = accessContract.roles as Record<string, { profile: string }>;
const profiles = policyContract.profiles as unknown as Record<string, DaemonPolicy>;
const ownerOnlyTools = new Set((accessContract.ownerOnlyTools as string[] | undefined)?.map(String) ?? []);
const toolAvailability = new Map((toolCatalog as Array<{ name: string; availability: string }>).map((tool) => [tool.name, tool.availability]));

export const ACCOUNT_ACCESS_REVISION = Number(accessContract.revision);
export const ACCOUNT_ROLES = Object.freeze(Object.keys(roles));
export const DEFAULT_ACCOUNT_ROLE = String(accessContract.defaultRole) as AccountRole;
export const OWNER_ACCOUNT_ROLE = String(accessContract.ownerRole) as AccountRole;

export function normalizeAccountRole(value: unknown): AccountRole | null {
  const role = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(roles, role) ? role as AccountRole : null;
}

export function accountRolePolicy(role: AccountRole): DaemonPolicy {
  const profileName = Object.hasOwn(roles, role) ? roles[role].profile : undefined;
  const profile = profileName && Object.hasOwn(profiles, profileName) ? profiles[profileName] : undefined;
  if (!profile) throw new Error(`account role references an unknown policy profile: ${role}`);
  return {
    profile: String(profile.profile),
    origin: "explicit",
    revision: Number(policyContract.revision),
    allowWrite: profile.allowWrite === true,
    allowExec: String(profile.execMode) !== "off",
    execMode: String(profile.execMode) as DaemonPolicy["execMode"],
    unrestrictedPaths: profile.unrestrictedPaths === true,
    minimalEnv: profile.minimalEnv !== false,
    exposeAbsolutePaths: profile.exposeAbsolutePaths === true,
  };
}

export function accountRoleAllowsTool(role: AccountRole, toolName: string): boolean {
  if (toolName === "server_info") return true;
  if (role !== OWNER_ACCOUNT_ROLE && ownerOnlyTools.has(toolName)) return false;
  const availability = toolAvailability.get(toolName);
  return Boolean(availability && policyAllowsAvailability(accountRolePolicy(role), availability));
}

export function accountRoleToolNames(role: AccountRole, daemonTools: Iterable<string>): Set<string> {
  return new Set([...daemonTools].filter((name) => accountRoleAllowsTool(role, name)));
}
