import catalog from "../shared/tool-catalog.json" with { type: "json" };
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };

export const SERVER_NAME = String(serverMetadata.name);
export const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(serverMetadata.supportedProtocolVersions.map((value) => String(value)));

export const MCP_INSTRUCTIONS = Object.freeze(serverMetadata.instructions.map((value) => String(value))).join("\n");


export const DEFAULT_POLICY_PROFILE = "full";
export const DEFAULT_POLICY_REVISION = 3;

export const POLICY_PROFILES = Object.freeze({
  review: Object.freeze({ profile: "review", allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false }),
  edit: Object.freeze({ profile: "edit", allowWrite: true, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false }),
  agent: Object.freeze({ profile: "agent", allowWrite: true, execMode: "direct", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false }),
  full: Object.freeze({ profile: "full", allowWrite: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true }),
});

const POLICY_ORIGINS = new Set(["default", "explicit", "custom", "migrated", "legacy-preserved"]);

export function policyProfile(name, origin = "explicit") {
  const profile = String(name || "").trim().toLowerCase();
  if (!POLICY_PROFILES[profile]) throw new Error(`unknown policy profile: ${profile}`);
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
  if (POLICY_PROFILES[requestedProfile]) {
    const canonical = POLICY_PROFILES[requestedProfile];
    normalized.allowWrite = canonical.allowWrite;
    normalized.allowExec = canonical.execMode !== "off";
    normalized.execMode = canonical.execMode;
    normalized.unrestrictedPaths = canonical.unrestrictedPaths;
    normalized.minimalEnv = canonical.minimalEnv;
    normalized.exposeAbsolutePaths = canonical.exposeAbsolutePaths;
  }
  return normalized;
}

export function isCanonicalFullPolicy(policy = {}) {
  return policyCapabilitiesEqual(normalizePolicy(policy), POLICY_PROFILES.full);
}

export function assertCanonicalFullPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  if (!isCanonicalFullPolicy(normalized) || normalized.profile !== "full") {
    throw new Error("full profile invariant failed: full must enable writes, shell execution, unrestricted paths, full parent environment, and absolute paths");
  }
  const exposed = toolsForPolicy(normalized);
  if (exposed.length !== catalog.length) throw new Error("full profile invariant failed: complete tool catalog is not exposed");
  return normalized;
}

function policyCapabilitiesEqual(left, right) {
  return left.allowWrite === right.allowWrite
    && left.execMode === right.execMode
    && left.unrestrictedPaths === right.unrestrictedPaths
    && left.minimalEnv === right.minimalEnv
    && left.exposeAbsolutePaths === right.exposeAbsolutePaths;
}

export function toolsForPolicy(policy = {}) {
  const normalized = normalizePolicy(policy);
  return catalog
    .filter((tool) => isAvailable(tool.availability, normalized))
    .map(({ availability, ...tool }) => structuredClone(tool));
}

export function toolNamesForPolicy(policy = {}) {
  return toolsForPolicy(policy).map((tool) => tool.name);
}

export function allToolNames() {
  return catalog.map((tool) => tool.name);
}


export function toolResult(value, isError = false) {
  const special = specialMcpResult(value);
  if (special) return { ...special, isError };
  const structuredContent = toStructuredContent(value);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = {
    content: [{ type: "text", text }],
    isError,
  };
  if (structuredContent) result.structuredContent = structuredContent;
  return result;
}

export function rpcResult(id, result) {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function isAvailable(availability, policy) {
  if (availability === "always") return true;
  if (availability === "write") return policy.allowWrite;
  if (availability === "direct-exec") return policy.execMode === "direct" || policy.execMode === "shell";
  if (availability === "shell-exec") return policy.execMode === "shell";
  if (availability === "full") return policy.profile === "full" && isCanonicalFullPolicy(policy);
  return false;
}

function specialMcpResult(value) {
  const special = value && typeof value === "object" && !Array.isArray(value) ? value.$mcp : null;
  if (!special || typeof special !== "object" || !Array.isArray(special.content)) return null;
  const result = { content: structuredClone(special.content) };
  if (special.structuredContent && typeof special.structuredContent === "object" && !Array.isArray(special.structuredContent)) {
    result.structuredContent = structuredClone(special.structuredContent);
  }
  return result;
}

function toStructuredContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
