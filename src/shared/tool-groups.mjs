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
