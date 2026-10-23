// @ts-check
export const CORE_CORNERSTONE_TOOL_NAMES = Object.freeze(new Set([
  "server_info",
  "agent_context",
  "resolve_task_capabilities",
  "read_file",
  "search_text",
  "edit_file",
  "write_file",
  "run_local_command",
  "git_status",
]));

export const PROGRESSIVE_TOOL_GROUPS = Object.freeze({
  browser: Object.freeze([
    "browser_status", "pair_browser_extension", "browser_list_tabs",
    "browser_manage_tabs", "browser_get_source", "browser_inspect_page",
    "browser_wait", "browser_action", "browser_fill_form",
    "browser_screenshot", "browser_upload_files",
  ]),
  app: Object.freeze([
    "list_local_applications", "open_local_application",
    "inspect_local_application", "operate_local_application",
    "computer_observe", "computer_act",
  ]),
  jobs: Object.freeze([
    "stage_job", "start_job", "list_jobs", "read_job", "cancel_job",
  ]),
  git: Object.freeze([
    "git_diff", "git_log", "git_show", "git_commit",
  ]),
  process: Object.freeze([
    "run_process", "start_process", "read_process", "write_process", "kill_process", "exec_command",
  ]),
  diagnostics: Object.freeze([
    "diagnose_runtime", "list_local_resources", "generate_ssh_key_resource",
  ]),
  skills: Object.freeze([
    "list_local_skills", "load_local_skill", "list_local_commands", "session_bootstrap", "resolve_task_capabilities",
  ]),
  files: Object.freeze([
    "list_roots", "list_dir", "list_files", "view_image", "apply_patch", "project_overview",
  ]),
});

/** @type {Map<string, string>} */
const TOOL_TO_GROUP = new Map();
for (const [group, tools] of Object.entries(PROGRESSIVE_TOOL_GROUPS)) {
  for (const tool of tools) {
    TOOL_TO_GROUP.set(tool, group);
  }
}

/** @param {unknown} toolName */
export function findToolGroup(toolName) {
  return TOOL_TO_GROUP.get(String(toolName || "")) || null;
}

/** @typedef {{ name?: string, description?: string, inputSchema?: Record<string, any> }} ToolDefinition */

/**
 * Project MCP tool definitions into compact Code Mode TypeScript SDK declarations.
 * @param {ReadonlyArray<ToolDefinition> | { tools?: ReadonlyArray<ToolDefinition> }} toolsOrCatalog
 * @param {{ toolNames?: Iterable<string>, namespace?: string }} [options]
 * @returns {string}
 */
export function projectToolTypeScriptDeclarations(toolsOrCatalog, options = {}) {
  const allowed = options.toolNames ? new Set(options.toolNames) : null;
  const rawNamespace = String(options.namespace || "mbm").replace(/[^A-Za-z0-9_$]/g, "");
  const namespace = /^[A-Za-z_$]/.test(rawNamespace) ? rawNamespace : "mbm";
  /** @type {ReadonlyArray<ToolDefinition>} */
  const list = Array.isArray(toolsOrCatalog)
    ? toolsOrCatalog
    : (toolsOrCatalog && typeof toolsOrCatalog === "object" && "tools" in toolsOrCatalog && Array.isArray(toolsOrCatalog.tools) ? toolsOrCatalog.tools : []);
  const entries = list
    .filter((/** @type {ToolDefinition} */ tool) => Boolean(tool && typeof tool.name === "string" && (!allowed || allowed.has(tool.name))));
  const lines = [`declare namespace ${namespace} {`];
  for (const tool of entries) {
    const fnName = String(tool.name).replace(/[^A-Za-z0-9_$]/g, "_");
    const summary = String(tool.description || "").replace(/\s+/g, " ").trim().split(/(?<=\.)\s+/)[0];
    if (summary) lines.push(`  /** ${summary.replace(/\*\//g, "* /")} */`);
    const paramType = schemaObjectToTypeScript(tool.inputSchema);
    const optionalArgs = !hasRequiredProperties(tool.inputSchema);
    lines.push(`  function ${fnName}(args${optionalArgs ? "?" : ""}: ${paramType}): Promise<Record<string, unknown>>;`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** @param {Record<string, any> | undefined} schema */
function hasRequiredProperties(schema) {
  return Boolean(schema && Array.isArray(schema.required) && schema.required.length > 0);
}

/** @param {Record<string, any> | undefined} schema @returns {string} */
function schemaObjectToTypeScript(schema) {
  if (!schema || typeof schema !== "object") return "Record<string, unknown>";
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
  if (!props || !Object.keys(props).length) return "Record<string, unknown>";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(props).map(([key, propSchema]) => {
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    const opt = required.has(key) ? "" : "?";
    return `${safeKey}${opt}: ${schemaPropertyToTypeScript(propSchema)}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** @param {any} prop @returns {string} */
function schemaPropertyToTypeScript(prop) {
  if (!prop || typeof prop !== "object") return "unknown";
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.map((/** @type {unknown} */ val) => JSON.stringify(val)).join(" | ");
  }
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") {
    const itemType = schemaPropertyToTypeScript(prop.items);
    return `Array<${itemType}>`;
  }
  if (type === "object") return schemaObjectToTypeScript(prop);
  return "unknown";
}
