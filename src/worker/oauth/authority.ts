import policyContract from "../../shared/policy-contract.json" with { type: "json" };
import toolSecurityContract from "../../shared/tool-security-contract.json" with { type: "json" };
import accessContract from "../../shared/access-contract.json" with { type: "json" };
import toolCatalog from "../../shared/tool-catalog.json" with { type: "json" };
import { policyAllowsAvailability, type DaemonPolicy } from "../room/policy.ts";

type EffectivePolicy = {
  scope: "authenticated_account_effective_authority";
  derived_from: ["account_role_policy", "daemon_capability_ceiling"];
  profile: string;
  revision: number;
  allowWrite: boolean;
  allowExec: boolean;
  execMode: DaemonPolicy["execMode"];
  unrestrictedPaths: boolean;
  minimalEnv: boolean;
  exposeAbsolutePaths: boolean;
};

type AccountIdentity = { accountId: string; accountVersion: number; role: AccountRole };

type AccountAuthority = {
  account: { account_id: string; role: AccountRole; version: number };
  account_policy: DaemonPolicy & { scope: "account_role_capability_ceiling" };
  daemon_policy_ceiling: DaemonPolicy | null;
  effective_policy: EffectivePolicy | null;
  effective_tools: string[];
  effective_tool_count: number;
  account_role_is_owner: boolean;
  effective_profile_is_full: boolean;
  interpretation: {
    authoritative_permission_fields: ["effective_policy", "effective_tools"];
    daemon_policy: string;
    host_filtering: string;
  };
  execution_model: {
    within_effective_authority: "automatic_without_per_operation_prompt";
    owner_ambient_authority: "daemon_os_user" | "not_owner";
    generic_control_plane_paths: "denied_even_for_owner";
    mutually_untrusted_execution_requires: "external_os_isolation";
  };
  summary: string;
};

export type DaemonCeilingStatus = Record<string, unknown> & {
  policy: DaemonPolicy | null;
  tools: string[];
  policy_scope: "daemon_capability_ceiling_not_account_authority";
  tools_scope: "daemon_advertised_before_account_role_filtering";
};

const profileFields = ["allowWrite", "execMode", "unrestrictedPaths", "minimalEnv", "exposeAbsolutePaths"] as const;

const profiles = policyContract.profiles as Record<string, Pick<DaemonPolicy, typeof profileFields[number]> & { profile: string }>;

const execRank: Record<DaemonPolicy["execMode"], number> = { off: 0, direct: 1, shell: 2 };

const execCapableTools = new Set(
  Object.entries(toolSecurityContract.tools as Record<string, { family?: string }>)
    .filter(([name, spec]) => spec.family === "shell" || name === "stage_job" || name === "start_job")
    .map(([name]) => name),
);

export function describeDaemonCeiling(value: Record<string, unknown>): DaemonCeilingStatus {
  return {
    ...value,
    policy: isDaemonPolicy(value.policy) ? value.policy : null,
    tools: Array.isArray(value.tools) ? value.tools.filter((item): item is string => typeof item === "string") : [],
    policy_scope: "daemon_capability_ceiling_not_account_authority",
    tools_scope: "daemon_advertised_before_account_role_filtering",
  };
}

export function accountAuthoritySnapshot(input: AccountIdentity & {
  daemonPolicy: DaemonPolicy | null;
  effectiveTools: string[];
}): AccountAuthority {
  const accountPolicy = accountRolePolicy(input.role);
  const effectiveTools = [...new Set(input.effectiveTools)];
  const effectivePolicy = input.daemonPolicy ? intersectPolicies(accountPolicy, input.daemonPolicy, effectiveTools) : null;
  const daemonProfile = input.daemonPolicy?.profile ?? "disconnected";
  const effectiveProfile = effectivePolicy?.profile ?? "unavailable";
  return {
    account: { account_id: input.accountId, role: input.role, version: input.accountVersion },
    account_policy: { ...accountPolicy, scope: "account_role_capability_ceiling" },
    daemon_policy_ceiling: input.daemonPolicy,
    effective_policy: effectivePolicy,
    effective_tools: effectiveTools,
    effective_tool_count: effectiveTools.length,
    account_role_is_owner: input.role === "owner",
    effective_profile_is_full: effectivePolicy?.profile === "full",
    interpretation: {
      authoritative_permission_fields: ["effective_policy", "effective_tools"],
      daemon_policy: "daemon.policy is only the local daemon capability ceiling; it is not the authenticated account permission",
      host_filtering: "the MCP host may expose a smaller subset than effective_tools, and Machine Bridge cannot observe that post-relay subset",
    },
    execution_model: {
      within_effective_authority: "automatic_without_per_operation_prompt",
      owner_ambient_authority: input.role === "owner" ? "daemon_os_user" : "not_owner",
      generic_control_plane_paths: "denied_even_for_owner",
      mutually_untrusted_execution_requires: "external_os_isolation",
    },
    summary: input.daemonPolicy
      ? `Authenticated account role ${input.role} has effective profile ${effectiveProfile}. daemon.policy.profile=${daemonProfile} is only the daemon capability ceiling, not this account's permission. Operations within effective authority execute automatically without a per-operation prompt${input.role === "owner" ? "; owner shell, browser, and application automation can act with the daemon OS user's ambient authority" : ""}.`
      : `Authenticated account role ${input.role} is configured for profile ${accountPolicy.profile}, but no daemon is connected; only Worker-local tools are currently available. Operations within effective authority execute automatically without a per-operation prompt.`,
  };
}

export function decorateProjectOverview(
  value: unknown,
  account: AccountIdentity,
  options: { includeJobMonitor?: boolean; effectiveTools?: string[] } = {},
): unknown {
  if (!isRecord(value)) return value;
  const daemonPolicy = isDaemonPolicy(value.daemonPolicy)
    ? value.daemonPolicy
    : isDaemonPolicy(value.policy)
      ? value.policy
      : null;
  const daemonToolSource = Array.isArray(value.daemonTools) ? value.daemonTools : value.tools;
  const daemonTools = Array.isArray(daemonToolSource)
    ? daemonToolSource.filter((item): item is string => typeof item === "string")
    : [];
  const includeJobMonitor = options.includeJobMonitor !== false;
  const monitorTools = includeJobMonitor && accountRoleAllowsTool(account.role, "start_job")
    ? ["render_job_monitor", "claim_job_monitor", "read_job_monitor"]
    : [];
  const effectiveTools = options.effectiveTools
    ? [...options.effectiveTools]
    : ["server_info", ...monitorTools, ...accountRoleToolNames(account.role, daemonTools)];
  const authority = accountAuthoritySnapshot({ ...account, daemonPolicy, effectiveTools });
  const projected = account.role === "owner" ? value : redactNonOwnerProjectOverview(value);
  return {
    ...projected,
    daemonPolicy,
    daemonToolCount: daemonTools.length,
    daemonTools: account.role === "owner" ? daemonTools : [],
    ...(account.role === "owner" ? {} : { daemonToolsHiddenByAuthority: true }),
    policy: authority.effective_policy,
    tools: authority.effective_tools,
    policyScope: "authenticated_account_effective_authority",
    toolsScope: "authenticated_account_effective_tools_before_host_filtering",
    authorization: authority,
  };
}

function redactNonOwnerProjectOverview(value: Record<string, unknown>): Record<string, unknown> {
  const topLevel = Array.isArray(value.topLevel)
    ? value.topLevel.map((item) => projectTopLevelEntry(item))
    : [];
  return {
    workspace: ".",
    workspaceName: "workspace",
    gitRoot: typeof value.gitRoot === "string" && value.gitRoot ? "." : "",
    capabilityRouting: { activity_hidden_by_authority: true },
    topLevel,
    topLevelTotal: Number.isFinite(Number(value.topLevelTotal)) ? Number(value.topLevelTotal) : topLevel.length,
    topLevelTruncated: value.topLevelTruncated === true,
  };
}

function projectTopLevelEntry(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { name: "", type: "other" };
  return {
    name: typeof value.name === "string" ? value.name : "",
    type: typeof value.type === "string" ? value.type : "other",
    ...(Number.isFinite(Number(value.size)) ? { size: Number(value.size) } : {}),
  };
}

function intersectPolicies(
  accountPolicy: DaemonPolicy,
  daemonPolicy: DaemonPolicy,
  effectiveTools: readonly string[] = [],
): EffectivePolicy {
  const rankedExecMode = execRank[accountPolicy.execMode] <= execRank[daemonPolicy.execMode]
    ? accountPolicy.execMode
    : daemonPolicy.execMode;
  const hasExecTool = effectiveTools.some((name) => execCapableTools.has(name));
  const execMode: DaemonPolicy["execMode"] = hasExecTool ? rankedExecMode : "off";
  const capabilities = {
    allowWrite: accountPolicy.allowWrite && daemonPolicy.allowWrite,
    execMode,
    unrestrictedPaths: accountPolicy.unrestrictedPaths && daemonPolicy.unrestrictedPaths,
    minimalEnv: accountPolicy.minimalEnv || daemonPolicy.minimalEnv,
    exposeAbsolutePaths: accountPolicy.exposeAbsolutePaths && daemonPolicy.exposeAbsolutePaths,
  };
  return {
    scope: "authenticated_account_effective_authority",
    derived_from: ["account_role_policy", "daemon_capability_ceiling"],
    profile: matchingProfile(capabilities),
    revision: Math.max(accountPolicy.revision, daemonPolicy.revision),
    ...capabilities,
    allowExec: execMode !== "off",
  };
}

function matchingProfile(capabilities: Pick<EffectivePolicy, typeof profileFields[number]>): string {
  for (const [name, profile] of Object.entries(profiles)) {
    if (profileFields.every((field) => profile[field] === capabilities[field])) return name;
  }
  return "custom";
}

function isDaemonPolicy(value: unknown): value is DaemonPolicy {
  if (!isRecord(value)) return false;
  return typeof value.profile === "string"
    && typeof value.origin === "string"
    && Number.isInteger(value.revision)
    && typeof value.allowWrite === "boolean"
    && typeof value.allowExec === "boolean"
    && (value.execMode === "off" || value.execMode === "direct" || value.execMode === "shell")
    && typeof value.unrestrictedPaths === "boolean"
    && typeof value.minimalEnv === "boolean"
    && typeof value.exposeAbsolutePaths === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
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

const accessPolicyProfiles = policyContract.profiles as unknown as Record<string, DaemonPolicy>;

const ownerOnlyTools = new Set((accessContract.ownerOnlyTools as string[] | undefined)?.map(String) ?? []);

const toolAvailability = new Map((toolCatalog as Array<{ name: string; availability: string }>).map((tool) => [tool.name, tool.availability]));

export const ACCOUNT_ROLES = Object.freeze(Object.keys(roles));

export const OWNER_ACCOUNT_ROLE = String(accessContract.ownerRole) as AccountRole;

export function normalizeAccountRole(value: unknown): AccountRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return Object.hasOwn(roles, role) ? role as AccountRole : null;
}

export function accountRolePolicy(role: AccountRole): DaemonPolicy {
  const roleEntry = Object.hasOwn(roles, role) ? roles[role] : undefined;
  const profileName = roleEntry?.profile;
  const profile = profileName && Object.hasOwn(accessPolicyProfiles, profileName) ? accessPolicyProfiles[profileName] : undefined;
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
