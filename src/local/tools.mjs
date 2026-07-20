import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { projectMcpResult } from "../shared/result-projection.mjs";
export {
  DEFAULT_POLICY_PROFILE,
  DEFAULT_POLICY_REVISION,
  POLICY_AVAILABILITY,
  POLICY_ORIGINS,
  POLICY_PROFILES,
  PolicyGate,
  allToolNames,
  assertCanonicalFullPolicy,
  assertToolAllowed,
  isCanonicalFullPolicy,
  normalizePolicy,
  policyAllowsAvailability,
  policyAllowsTool,
  policyCapabilitiesEqual,
  policyProfile,
  toolDefinition,
  toolNamesForPolicy,
  toolsForPolicy,
} from "./policy.mjs";

export const SERVER_NAME = String(serverMetadata.name);
export const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(serverMetadata.supportedProtocolVersions.map((value) => String(value)));
export const MCP_INSTRUCTIONS = Object.freeze(serverMetadata.instructions.map((value) => String(value))).join("\n");

export function toolResult(value, isError = false) {
  const special = specialMcpResult(value);
  if (special) return { ...special, isError };
  const projection = projectMcpResult(value);
  const result = { content: [{ type: "text", text: projection.text }], isError };
  if (projection.structuredContent) result.structuredContent = projection.structuredContent;
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

function specialMcpResult(value) {
  const special = value && typeof value === "object" && !Array.isArray(value) ? value.$mcp : null;
  if (!special || typeof special !== "object" || !Array.isArray(special.content)) return null;
  const result = { content: structuredClone(special.content) };
  if (special.structuredContent && typeof special.structuredContent === "object" && !Array.isArray(special.structuredContent)) {
    result.structuredContent = structuredClone(special.structuredContent);
  }
  return result;
}
