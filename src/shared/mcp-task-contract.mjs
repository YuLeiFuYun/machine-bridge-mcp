export const MCP_TASK_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_TASK_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_TASK_POLL_INTERVAL_MS = 2000;
export const MCP_TASK_JOB_ID_PATTERN = "^job_[A-Za-z0-9_-]{24,}$";
const MCP_TASK_JOB_ID = new RegExp(MCP_TASK_JOB_ID_PATTERN);

export function isMcpTaskJobId(value) {
  return typeof value === "string" && MCP_TASK_JOB_ID.test(value);
}

const TASK_AUGMENTED_TOOLS = new Set(["exec_command", "run_process", "run_local_command", "start_job"]);

export function supportsMcpTasks(clientCapabilities) {
  if (!clientCapabilities || typeof clientCapabilities !== "object" || Array.isArray(clientCapabilities)) return false;
  const extensions = clientCapabilities.extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return false;
  const capability = extensions[MCP_TASK_EXTENSION_ID];
  return Boolean(capability) && typeof capability === "object" && !Array.isArray(capability);
}

export function isMcpTaskAugmentedTool(name) {
  return TASK_AUGMENTED_TOOLS.has(name);
}

export function taskClientCapabilities(request) {
  const params = asObject(request?.params);
  const meta = asObject(params._meta);
  return asObject(meta["io.modelcontextprotocol/clientCapabilities"]);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
