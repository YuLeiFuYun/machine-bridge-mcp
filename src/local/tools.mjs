import catalog from "../shared/tool-catalog.json" with { type: "json" };

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const MCP_INSTRUCTIONS = [
  "You are connected to a local workspace through machine-bridge-mcp.",
  "Remote mode uses a Cloudflare relay; stdio mode runs entirely on the local machine.",
  "File and command operations execute on the user's local runtime, not in the Worker.",
  "Relative paths use the configured workspace. Direct filesystem tools are workspace-scoped unless unrestricted paths are explicitly enabled.",
  "run_process avoids shell parsing but is not an OS sandbox. exec_command is only exposed in shell execution mode and has the local user's authority.",
  "Inspect before editing, prefer edit_file or apply_patch over whole-file replacement, and report commands that were run.",
].join("\n");

export function normalizePolicy(policy = {}) {
  const execMode = ["off", "direct", "shell"].includes(policy.execMode)
    ? policy.execMode
    : policy.allowExec === true
      ? "shell"
      : "off";
  return {
    profile: typeof policy.profile === "string" && policy.profile ? policy.profile : "custom",
    allowWrite: policy.allowWrite === true,
    allowExec: execMode !== "off",
    execMode,
    unrestrictedPaths: policy.unrestrictedPaths === true,
    minimalEnv: policy.minimalEnv !== false,
    exposeAbsolutePaths: policy.exposeAbsolutePaths === true,
  };
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

export function findTool(name) {
  return catalog.find((tool) => tool.name === name) || null;
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
