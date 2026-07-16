// @ts-check

import catalog from "../shared/tool-catalog.json" with { type: "json" };
import contract from "../shared/policy-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";

/** @typedef {"off" | "direct" | "shell"} ExecMode */
/**
 * @typedef {{
 *   profile: string,
 *   allowWrite: boolean,
 *   execMode: ExecMode,
 *   unrestrictedPaths: boolean,
 *   minimalEnv: boolean,
 *   exposeAbsolutePaths: boolean,
 * }} PolicyCapabilities
 */
/**
 * @typedef {PolicyCapabilities & {
 *   origin: string,
 *   revision: number,
 *   allowExec: boolean,
 * }} NormalizedPolicy
 */
/**
 * @typedef {{
 *   profile?: string,
 *   allowWrite?: boolean,
 *   execModes?: ExecMode[],
 *   unrestrictedPaths?: boolean,
 *   minimalEnv?: boolean,
 *   exposeAbsolutePaths?: boolean,
 * }} AvailabilityRequirements
 */
/** @typedef {{name: string, availability: string} & Record<string, unknown>} ToolDefinition */
/**
 * @typedef {{
 *   profile?: unknown,
 *   origin?: unknown,
 *   revision?: unknown,
 *   allowWrite?: unknown,
 *   allowExec?: unknown,
 *   execMode?: unknown,
 *   unrestrictedPaths?: unknown,
 *   minimalEnv?: unknown,
 *   exposeAbsolutePaths?: unknown,
 * }} PolicyInput
 */

export const DEFAULT_POLICY_PROFILE = String(contract.defaultProfile);
export const DEFAULT_POLICY_REVISION = Number(contract.revision);
/** @type {Readonly<Record<string, Readonly<PolicyCapabilities>>>} */
export const POLICY_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(contract.profiles).map(([name, value]) => [name, Object.freeze(/** @type {PolicyCapabilities} */ ({ ...value }))]),
));
const POLICY_PROFILE_NAMES = Object.freeze(new Set(Object.keys(POLICY_PROFILES)));
export const POLICY_ORIGINS = Object.freeze(new Set(contract.origins.map(String)));
/** @type {Readonly<Record<string, Readonly<AvailabilityRequirements>>>} */
export const POLICY_AVAILABILITY = Object.freeze(Object.fromEntries(
  Object.entries(contract.availability).map(([name, value]) => [
    name,
    Object.freeze(/** @type {AvailabilityRequirements} */ ({ ...value })),
  ]),
));

/** @type {ReadonlyArray<Readonly<ToolDefinition>>} */
const TOOLS = Object.freeze(catalog.map((tool) => Object.freeze(/** @type {ToolDefinition} */ ({ ...tool }))));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** @param {unknown} name @param {unknown} [origin] */
export function policyProfile(name, origin = "explicit") {
  const profile = String(name || "").trim().toLowerCase();
  if (!POLICY_PROFILE_NAMES.has(profile)) throw new BridgeError("invalid_request", `unknown policy profile: ${profile}`);
  const canonical = POLICY_PROFILES[profile];
  return normalizePolicy({ ...canonical, origin, revision: DEFAULT_POLICY_REVISION });
}

/** @param {PolicyInput} [policy] @returns {Readonly<NormalizedPolicy>} */
export function normalizePolicy(policy = {}) {
  const requestedExecMode = policy.execMode;
  /** @type {ExecMode} */
  const execMode = requestedExecMode === "off" || requestedExecMode === "direct" || requestedExecMode === "shell"
    ? requestedExecMode
    : policy.allowExec === true
      ? "shell"
      : "off";
  const requestedOrigin = typeof policy.origin === "string" ? policy.origin : "";
  const origin = POLICY_ORIGINS.has(requestedOrigin) ? requestedOrigin : "custom";
  const requestedRevision = typeof policy.revision === "number" ? policy.revision : Number.NaN;
  const revision = Number.isInteger(requestedRevision) && requestedRevision > 0
    ? requestedRevision
    : DEFAULT_POLICY_REVISION;
  const rawProfile = typeof policy.profile === "string" && policy.profile ? policy.profile : "custom";
  const requestedProfile = POLICY_PROFILE_NAMES.has(rawProfile) ? rawProfile : "custom";
  /** @type {NormalizedPolicy} */
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
  if (POLICY_PROFILE_NAMES.has(requestedProfile)) {
    const canonical = POLICY_PROFILES[requestedProfile];
    Object.assign(normalized, canonical, { allowExec: canonical.execMode !== "off" });
  }
  return Object.freeze(normalized);
}

/** @param {PolicyCapabilities} left @param {PolicyCapabilities} right */
export function policyCapabilitiesEqual(left, right) {
  return left.allowWrite === right.allowWrite
    && left.execMode === right.execMode
    && left.unrestrictedPaths === right.unrestrictedPaths
    && left.minimalEnv === right.minimalEnv
    && left.exposeAbsolutePaths === right.exposeAbsolutePaths;
}

/** @param {PolicyInput} [policy] */
export function isCanonicalFullPolicy(policy = {}) {
  return policyCapabilitiesEqual(normalizePolicy(policy), POLICY_PROFILES.full);
}

/** @param {PolicyInput} [policy] */
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

/** @param {PolicyInput} policy @param {unknown} availability */
export function policyAllowsAvailability(policy, availability) {
  const normalized = normalizePolicy(policy);
  const availabilityName = String(availability || "");
  if (!Object.hasOwn(POLICY_AVAILABILITY, availabilityName)) return false;
  const requirements = POLICY_AVAILABILITY[availabilityName];
  if (requirements.profile && normalized.profile !== requirements.profile) return false;
  if (requirements.allowWrite === true && normalized.allowWrite !== true) return false;
  if (Array.isArray(requirements.execModes) && !requirements.execModes.includes(normalized.execMode)) return false;
  if (typeof requirements.unrestrictedPaths === "boolean" && normalized.unrestrictedPaths !== requirements.unrestrictedPaths) return false;
  if (typeof requirements.minimalEnv === "boolean" && normalized.minimalEnv !== requirements.minimalEnv) return false;
  if (typeof requirements.exposeAbsolutePaths === "boolean" && normalized.exposeAbsolutePaths !== requirements.exposeAbsolutePaths) return false;
  return true;
}

/** @param {unknown} name */
export function toolDefinition(name) {
  return TOOL_BY_NAME.get(String(name || "")) || null;
}

/** @param {PolicyInput} policy @param {unknown} name */
export function policyAllowsTool(policy, name) {
  const tool = toolDefinition(name);
  return Boolean(tool && policyAllowsAvailability(policy, tool.availability));
}

/** @param {PolicyInput} policy @param {unknown} name */
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

/** @param {PolicyInput} [policy] */
export function toolsForPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  return TOOLS.filter((tool) => policyAllowsAvailability(normalized, tool.availability))
    .map(({ availability, ...tool }) => structuredClone(tool));
}

/** @param {PolicyInput} [policy] */
export function toolNamesForPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  return TOOLS.filter((tool) => policyAllowsAvailability(normalized, tool.availability)).map((tool) => tool.name);
}

export function allToolNames() {
  return TOOLS.map((tool) => tool.name);
}

/**
 * @param {PolicyInput} policy
 * @param {((tool: string) => unknown) | null | undefined} provided
 */
export function createToolAuthorizer(policy, provided) {
  if (typeof provided === "function") return provided;
  const gate = new PolicyGate(policy);
  return (/** @type {string} */ tool) => gate.assert(tool);
}

export class PolicyGate {
  /** @param {PolicyInput} policy */
  constructor(policy) {
    this.policy = normalizePolicy(policy);
    this.allowedNames = new Set(toolNamesForPolicy(this.policy));
  }

  /** @param {unknown} name */
  allows(name) {
    return this.allowedNames.has(String(name || ""));
  }

  /** @param {unknown} name */
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
