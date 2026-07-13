import catalog from "../shared/tool-catalog.json" with { type: "json" };
import contract from "../shared/policy-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";

export const DEFAULT_POLICY_PROFILE = String(contract.defaultProfile);
export const DEFAULT_POLICY_REVISION = Number(contract.revision);
export const POLICY_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(contract.profiles).map(([name, value]) => [name, Object.freeze({ ...value })]),
));
export const POLICY_ORIGINS = Object.freeze(new Set(contract.origins.map(String)));
export const POLICY_AVAILABILITY = Object.freeze(Object.fromEntries(
  Object.entries(contract.availability).map(([name, value]) => [name, Object.freeze({ ...value })]),
));

const TOOLS = Object.freeze(catalog.map((tool) => Object.freeze({ ...tool })));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function policyProfile(name, origin = "explicit") {
  const profile = String(name || "").trim().toLowerCase();
  if (!POLICY_PROFILES[profile]) throw new BridgeError("invalid_request", `unknown policy profile: ${profile}`);
  return normalizePolicy({ ...POLICY_PROFILES[profile], origin, revision: DEFAULT_POLICY_REVISION });
}

export function normalizePolicy(policy = {}) {
  const execMode = ["off", "direct", "shell"].includes(policy.execMode)
    ? policy.execMode
    : policy.allowExec === true
      ? "shell"
      : "off";
  const origin = POLICY_ORIGINS.has(policy.origin) ? policy.origin : "custom";
  const revision = Number.isInteger(policy.revision) && policy.revision > 0 ? policy.revision : DEFAULT_POLICY_REVISION;
  const requestedProfile = typeof policy.profile === "string" && policy.profile ? policy.profile : "custom";
  const normalized = {
    profile: requestedProfile,
    origin,
    revision,
    allowWrite: policy.allowWrite === true,
    allowExec: execMode !== "off",
    execMode,
    unrestrictedPaths: policy.unrestrictedPaths === true,
    minimalEnv: policy.minimalEnv !== false,
    exposeAbsolutePaths: policy.exposeAbsolutePaths === true,
  };
  const canonical = POLICY_PROFILES[requestedProfile];
  if (canonical) Object.assign(normalized, canonical, { allowExec: canonical.execMode !== "off" });
  return Object.freeze(normalized);
}

export function policyCapabilitiesEqual(left, right) {
  return left.allowWrite === right.allowWrite
    && left.execMode === right.execMode
    && left.unrestrictedPaths === right.unrestrictedPaths
    && left.minimalEnv === right.minimalEnv
    && left.exposeAbsolutePaths === right.exposeAbsolutePaths;
}

export function isCanonicalFullPolicy(policy = {}) {
  return policyCapabilitiesEqual(normalizePolicy(policy), POLICY_PROFILES.full);
}

export function assertCanonicalFullPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  if (normalized.profile !== "full" || !isCanonicalFullPolicy(normalized)) {
    throw new BridgeError("policy_denied", "full profile invariant failed: full must enable writes, shell execution, unrestricted paths, full parent environment, and absolute paths");
  }
  if (toolNamesForPolicy(normalized).length !== TOOLS.length) {
    throw new BridgeError("integrity_error", "full profile invariant failed: complete tool catalog is not exposed");
  }
  return normalized;
}

export function policyAllowsAvailability(policy, availability) {
  const normalized = normalizePolicy(policy);
  const requirements = POLICY_AVAILABILITY[availability];
  if (!requirements) return false;
  if (requirements.profile && normalized.profile !== requirements.profile) return false;
  if (requirements.allowWrite === true && normalized.allowWrite !== true) return false;
  if (Array.isArray(requirements.execModes) && !requirements.execModes.includes(normalized.execMode)) return false;
  if (typeof requirements.unrestrictedPaths === "boolean" && normalized.unrestrictedPaths !== requirements.unrestrictedPaths) return false;
  if (typeof requirements.minimalEnv === "boolean" && normalized.minimalEnv !== requirements.minimalEnv) return false;
  if (typeof requirements.exposeAbsolutePaths === "boolean" && normalized.exposeAbsolutePaths !== requirements.exposeAbsolutePaths) return false;
  return true;
}

export function toolDefinition(name) {
  return TOOL_BY_NAME.get(String(name || "")) || null;
}

export function policyAllowsTool(policy, name) {
  const tool = toolDefinition(name);
  return Boolean(tool && policyAllowsAvailability(policy, tool.availability));
}

export function assertToolAllowed(policy, name) {
  const tool = toolDefinition(name);
  if (!tool) throw new BridgeError("not_found", `unknown tool: ${String(name || "")}`);
  if (!policyAllowsAvailability(policy, tool.availability)) {
    throw new BridgeError("policy_denied", `tool is disabled by the active policy: ${tool.name}`, {
      details: { tool: tool.name, availability: tool.availability },
    });
  }
  return tool;
}

export function toolsForPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  return TOOLS.filter((tool) => policyAllowsAvailability(normalized, tool.availability))
    .map(({ availability, ...tool }) => structuredClone(tool));
}

export function toolNamesForPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  return TOOLS.filter((tool) => policyAllowsAvailability(normalized, tool.availability)).map((tool) => tool.name);
}

export function allToolNames() {
  return TOOLS.map((tool) => tool.name);
}


export function createToolAuthorizer(policy, provided) {
  if (typeof provided === "function") return provided;
  const gate = new PolicyGate(policy);
  return (tool) => gate.assert(tool);
}

export class PolicyGate {
  constructor(policy) {
    this.policy = normalizePolicy(policy);
    this.allowedNames = new Set(toolNamesForPolicy(this.policy));
  }

  allows(name) {
    return this.allowedNames.has(String(name || ""));
  }

  assert(name) {
    return assertToolAllowed(this.policy, name);
  }

  names() {
    return [...this.allowedNames];
  }

  definitions() {
    return toolsForPolicy(this.policy);
  }
}
