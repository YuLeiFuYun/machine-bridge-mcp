import { createHash } from "node:crypto";
import path from "node:path";

export const OPERATION_APPROVAL_SCOPES = Object.freeze([
  "shell",
  "external-write",
  "sensitive-write",
  "external-read",
  "sensitive-read",
  "browser-session",
  "data-export",
  "persistent-job",
  "application-control",
  "credential-operation",
  "full",
]);

const SHELL_TOOLS = new Set(["exec_command", "run_process", "start_process", "run_local_command", "read_process", "write_process", "kill_process"]);
const PERSISTENT_TOOLS = new Set(["stage_job", "start_job", "list_jobs", "read_job", "cancel_job"]);
const APPLICATION_CONTROL_TOOLS = new Set(["open_local_application", "inspect_local_application", "operate_local_application"]);
const COMPUTER_USE_TOOLS = new Set(["computer_observe", "computer_act"]);
const CREDENTIAL_TOOLS = new Set(["generate_ssh_key_resource"]);
const BROWSER_PROFILE_TOOLS = new Set([
  "pair_browser_extension", "browser_list_tabs", "browser_manage_tabs", "browser_get_source",
  "browser_inspect_page", "browser_wait", "browser_action", "browser_fill_form", "browser_screenshot",
]);
const AUTOMATIC_TOOLS = new Set([
  "server_info", "project_overview", "list_local_applications", "browser_status", "list_roots",
  "diagnose_runtime", "list_local_resources",
]);
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "git_commit"]);
const FILE_READ_TOOLS = new Set([
  "session_bootstrap", "resolve_task_capabilities", "agent_context", "list_local_skills", "load_local_skill", "list_local_commands",
  "list_dir", "list_files", "read_file", "view_image", "search_text",
  "git_status", "git_diff", "git_log", "git_show",
]);
const SENSITIVE_SEGMENTS = new Set([
  ".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".npmrc", ".pypirc",
  "keychains", "cookies", "login data", "credentials", "secrets",
]);
const RESOURCE_TOKEN = /\{\{resource:[a-z][a-z0-9._-]{0,63}\}\}/;

export function reviewedOperationToolNames() {
  return new Set([
    ...AUTOMATIC_TOOLS,
    ...SHELL_TOOLS,
    ...PERSISTENT_TOOLS,
    ...APPLICATION_CONTROL_TOOLS,
    ...COMPUTER_USE_TOOLS,
    ...CREDENTIAL_TOOLS,
    ...BROWSER_PROFILE_TOOLS,
    ...FILE_WRITE_TOOLS,
    ...FILE_READ_TOOLS,
    "browser_upload_files",
    "apply_patch",
  ]);
}

export async function classifyOperation(tool, args = {}, options = {}) {
  const name = String(tool || "");
  if (name === "list_local_resources") return requirement("sensitive-read", "protected local resource inventory", name, {});
  if (SHELL_TOOLS.has(name)) return requirement("shell", "remote shell or process control", name, args);
  if ((name === "stage_job" || name === "start_job") && jobUsesProtectedResources(args)) {
    return requirement(["persistent-job", "sensitive-read"], "managed job using protected local resources", name, protectedJobProjection(args));
  }
  if (PERSISTENT_TOOLS.has(name)) return requirement("persistent-job", "persistent managed job", name, args);
  if (COMPUTER_USE_TOOLS.has(name)) {
    const surface = String(args.surface || "");
    const scopes = surface === "browser" ? ["browser-session"] : surface === "application" ? ["application-control"] : [];
    if (!scopes.length) return null;
    if (name === "computer_act" && args.value_resource) scopes.push("data-export");
    return requirement(scopes, surface === "browser" ? "verified computer use in the existing browser profile" : "verified desktop computer use", name, {
      surface,
      snapshot_id: args.snapshot_id,
      action: args.action,
      value_resource: args.value_resource,
    });
  }
  if (name === "operate_local_application" && args.value_resource) {
    return requirement(["application-control", "data-export"], "desktop application control using protected local data", name, {
      application: args.application,
      action: args.action,
      value_resource: args.value_resource,
    });
  }
  if (APPLICATION_CONTROL_TOOLS.has(name)) return requirement("application-control", "desktop application control", name, args);
  if (CREDENTIAL_TOOLS.has(name)) return requirement("credential-operation", "credential or key operation", name, args);
  if (name === "browser_upload_files") {
    return requirement(["browser-session", "data-export"], "existing browser profile file upload", name, args);
  }
  if (name === "browser_action" && args.value_resource) {
    return requirement(["browser-session", "data-export"], "existing browser profile input from protected local data", name, {
      action: args.action,
      tab_id: args.tab_id,
      value_resource: args.value_resource,
    });
  }
  if (name === "browser_fill_form" && Array.isArray(args.fields) && args.fields.some((field) => field?.value_resource || field?.sensitive === true)) {
    return requirement(["browser-session", "data-export"], "existing browser profile form containing protected local data", name, {
      tab_id: args.tab_id,
      resource_fields: args.fields.filter((field) => field?.value_resource || field?.sensitive === true).length,
      submit: args.submit === true,
    });
  }
  if (BROWSER_PROFILE_TOOLS.has(name)) {
    return requirement("browser-session", "access to the existing browser profile", name, {
      action: args.action,
      tab_id: args.tab_id,
      frame_id: args.frame_id,
      submit: args.submit === true,
    });
  }
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = await canonicalWritePath(args.path, options);
    const scopes = pathWriteScopes(options.workspace, target);
    if (scopes.length) return requirement(scopes, pathWriteCategory(scopes), name, { path: target });
  }
  if (name === "apply_patch") {
    const paths = patchPaths(args.patch);
    const targets = [];
    for (const candidate of paths) targets.push(await canonicalWritePath(candidate, options));
    const scopes = normalizeScopes(targets.flatMap((target) => pathWriteScopes(options.workspace, target)));
    if (scopes.length) return requirement(scopes, pathWriteCategory(scopes, "patch"), name, { paths: targets });
  }
  if (FILE_READ_TOOLS.has(name) && args.path !== undefined) {
    const target = await canonicalExistingPath(args.path, options);
    const scopes = [];
    if (!isWithin(options.workspace, target)) scopes.push("external-read");
    if (isSensitivePath(target)) scopes.push("sensitive-read");
    if (scopes.length) return requirement(scopes, pathReadCategory(scopes), name, { path: target });
  }
  return null;
}

function jobUsesProtectedResources(args) {
  const steps = [...(Array.isArray(args?.steps) ? args.steps : []), ...(Array.isArray(args?.finally_steps) ? args.finally_steps : [])];
  return steps.some((step) => Boolean(step?.stdin_resource)
    || (step?.env_resources && Object.keys(step.env_resources).length > 0)
    || (Array.isArray(step?.argv) && step.argv.some((value) => RESOURCE_TOKEN.test(String(value)))));
}

function protectedJobProjection(args) {
  const steps = [...(Array.isArray(args?.steps) ? args.steps : []), ...(Array.isArray(args?.finally_steps) ? args.finally_steps : [])];
  return {
    step_count: steps.length,
    resource_reference_count: steps.reduce((count, step) => count + (step?.stdin_resource ? 1 : 0)
      + Object.keys(step?.env_resources || {}).length
      + (Array.isArray(step?.argv) ? step.argv.reduce((total, value) => total + (String(value).match(/\{\{resource:[a-z][a-z0-9._-]{0,63}\}\}/g)?.length || 0), 0) : 0), 0),
  };
}

function requirement(scopes, category, tool, target) {
  const normalized = normalizeScopes(Array.isArray(scopes) ? scopes : [scopes]);
  if (!normalized.length) throw new Error("operation authorization requirement is missing a scope");
  return {
    scope: normalized[0],
    scopes: normalized,
    category,
    targetHash: createHash("sha256").update(JSON.stringify({ tool, target: redactTarget(target) })).digest("hex"),
    canonicalTargets: canonicalTargetPaths(target),
  };
}

function canonicalTargetPaths(target) {
  if (!target || typeof target !== "object") return [];
  const values = [];
  if (typeof target.path === "string" && path.isAbsolute(target.path)) values.push(path.resolve(target.path));
  if (Array.isArray(target.paths)) {
    for (const value of target.paths) if (typeof value === "string" && path.isAbsolute(value)) values.push(path.resolve(value));
  }
  return [...new Set(values)];
}

function normalizeScopes(scopes) {
  const requested = new Set(scopes.map((scope) => String(scope || "")));
  return OPERATION_APPROVAL_SCOPES.filter((scope) => requested.has(scope));
}

function pathWriteScopes(workspace, target) {
  const scopes = [];
  if (!isWithin(workspace, target)) scopes.push("external-write");
  if (isSensitiveWritePath(target)) scopes.push("sensitive-write");
  return scopes;
}

function pathWriteCategory(scopes, subject = "write") {
  const external = scopes.includes("external-write");
  const sensitive = scopes.includes("sensitive-write");
  if (external && sensitive) return `${subject} outside the selected workspace to a credential or persistence-sensitive path`;
  if (sensitive) return `${subject} to a credential or persistence-sensitive path`;
  return `${subject} outside the selected workspace`;
}

function pathReadCategory(scopes) {
  const external = scopes.includes("external-read");
  const sensitive = scopes.includes("sensitive-read");
  if (external && sensitive) return "read outside the selected workspace from a credential-sensitive location";
  if (sensitive) return "read from a credential-sensitive location";
  return "read outside the selected workspace";
}

function redactTarget(value) {
  if (!value || typeof value !== "object") return String(value || "");
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (["content", "command", "stdin", "value", "old_text", "new_text", "patch"].includes(key)) {
      out[key] = `<sha256:${createHash("sha256").update(String(item || "")).digest("hex")}>`;
    } else out[key] = item;
  }
  return out;
}

async function canonicalExistingPath(value, options) {
  if (typeof options.resolveExistingPath === "function") return options.resolveExistingPath(value);
  return path.resolve(options.workspace, String(value || "."));
}

async function canonicalWritePath(value, options) {
  if (typeof options.resolveWritePath === "function") return options.resolveWritePath(value);
  return path.resolve(options.workspace, String(value || "."));
}

function isWithin(workspace, target) {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSensitivePath(target) {
  const lower = path.resolve(target).toLowerCase();
  const segments = lower.split(/[\\/]+/);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  const base = path.basename(lower);
  return isSensitiveEnvironmentFile(base) || /(?:token|secret|credential|private[-_]?key)/.test(base);
}

function isSensitiveWritePath(target) {
  const lower = path.resolve(target).toLowerCase();
  const normalized = lower.split(path.sep).join("/");
  const base = path.basename(lower);
  if (isSensitivePath(lower)) return true;
  if ([".zshrc", ".bashrc", ".bash_profile", ".profile", ".gitconfig", ".netrc", ".curlrc", "authorized_keys", "sshd_config", "sudoers"].includes(base)) return true;
  return normalized.includes("/.git/hooks/")
    || normalized.endsWith("/.git/config")
    || normalized.endsWith("/.config/git/config")
    || normalized.includes("/library/launchagents/")
    || normalized.includes("/library/launchdaemons/")
    || normalized.includes("/.config/autostart/")
    || normalized.includes("/.config/systemd/user/")
    || normalized.includes("/start menu/programs/startup/")
    || normalized.endsWith("/.config/fish/config.fish");
}

function isSensitiveEnvironmentFile(base) {
  if (base === ".env") return true;
  if (!base.startsWith(".env.")) return false;
  return ![".env.example", ".env.sample", ".env.template", ".env.defaults"].includes(base);
}

function patchPaths(patch) {
  const paths = [];
  for (const line of String(patch || "").split(/\r?\n/)) {
    const match = /^(?:\*\*\* (?:Add|Update|Delete) File:|\*\*\* Move to:|\+\+\+|---)\s+(.+)$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^[ab]\//, "").trim();
    if (value && value !== "/dev/null") paths.push(value);
  }
  return paths;
}
