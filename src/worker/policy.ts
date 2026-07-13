import contract from "../shared/policy-contract.json" with { type: "json" };
import toolCatalog from "../shared/tool-catalog.json" with { type: "json" };

export type DaemonPolicy = {
  profile: string;
  origin: string;
  revision: number;
  allowWrite: boolean;
  allowExec: boolean;
  execMode: "off" | "direct" | "shell";
  unrestrictedPaths: boolean;
  minimalEnv: boolean;
  exposeAbsolutePaths: boolean;
};

type ToolDefinition = Record<string, unknown> & { name: string; availability?: string };
type AvailabilityRequirement = {
  profile?: string;
  allowWrite?: boolean;
  execModes?: string[];
  unrestrictedPaths?: boolean;
  minimalEnv?: boolean;
  exposeAbsolutePaths?: boolean;
};

const tools = toolCatalog as ToolDefinition[];
const definitions = new Map(tools.map((tool) => [tool.name, tool]));
const origins = new Set(contract.origins.map(String));
const availability = contract.availability as Record<string, AvailabilityRequirement>;

export function sanitizeDaemonPolicy(value: unknown): DaemonPolicy {
  const policy = asObject(value);
  const execMode: DaemonPolicy["execMode"] = policy.execMode === "shell" || policy.execMode === "direct" ? policy.execMode : "off";
  const origin = sanitizeMetadataText(policy.origin, 32);
  return {
    profile: sanitizeMetadataText(policy.profile, 32) ?? "custom",
    origin: origins.has(origin ?? "") ? origin! : "custom",
    revision: Number.isInteger(policy.revision) && Number(policy.revision) > 0
      ? Math.min(Number(policy.revision), 1_000_000)
      : Number(contract.revision),
    allowWrite: policy.allowWrite === true,
    allowExec: execMode !== "off",
    execMode,
    unrestrictedPaths: policy.unrestrictedPaths === true,
    minimalEnv: policy.minimalEnv !== false,
    exposeAbsolutePaths: policy.exposeAbsolutePaths === true,
  };
}

export function policyAllowsAvailability(policy: DaemonPolicy, name: unknown): boolean {
  const requirement = availability[String(name || "")];
  if (!requirement) return false;
  if (requirement.profile && policy.profile !== requirement.profile) return false;
  if (requirement.allowWrite === true && policy.allowWrite !== true) return false;
  if (Array.isArray(requirement.execModes) && !requirement.execModes.includes(policy.execMode)) return false;
  if (typeof requirement.unrestrictedPaths === "boolean" && policy.unrestrictedPaths !== requirement.unrestrictedPaths) return false;
  if (typeof requirement.minimalEnv === "boolean" && policy.minimalEnv !== requirement.minimalEnv) return false;
  if (typeof requirement.exposeAbsolutePaths === "boolean" && policy.exposeAbsolutePaths !== requirement.exposeAbsolutePaths) return false;
  return true;
}

export function sanitizeDaemonTools(value: unknown, policy: DaemonPolicy): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => {
    if (typeof item !== "string" || item === "server_info") return false;
    const definition = definitions.get(item);
    return Boolean(definition && policyAllowsAvailability(policy, definition.availability));
  }))];
}

function sanitizeMetadataText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
