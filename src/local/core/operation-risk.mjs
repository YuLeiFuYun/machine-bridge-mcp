import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import toolSecurityContract from "../../shared/tool-security-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";
import { createToolSecurityIndex } from "../../shared/tool-security.mjs";
import { parsePatchEnvelope } from "./patch.mjs";
import { Buffer } from "node:buffer";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };

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

const STATIC_TOOL_SECURITY = createToolSecurityIndex(toolSecurityContract);

const SHELL_TOOLS = toolNamesForFamily("shell");

const PERSISTENT_TOOLS = toolNamesForFamily("persistent-job");

const APPLICATION_CONTROL_TOOLS = toolNamesForFamily("application-control");

const COMPUTER_USE_TOOLS = toolNamesForFamily("computer-use");

const CREDENTIAL_TOOLS = toolNamesForFamily("credential-operation");

const BROWSER_PROFILE_TOOLS = toolNamesForFamily("browser-session");

const BROWSER_UPLOAD_TOOLS = toolNamesForFamily("browser-upload");

const PROTECTED_RESOURCE_INVENTORY_TOOLS = toolNamesForFamily("protected-resource-inventory");

const FILE_WRITE_TOOLS = toolNamesForFamily("file-write");

const FILE_READ_TOOLS = toolNamesForFamily("file-read");

const PATCH_TOOLS = toolNamesForFamily("patch");

const SENSITIVE_SEGMENTS = new Set([
  ".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".npmrc", ".pypirc",
  "keychains", "cookies", "login data", "credentials", "secrets",
]);

const SENSITIVE_CONFIG_SEGMENTS = new Set(["gh", "gcloud", "azure", "1password"]);

const PRIVATE_KEY_BASENAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|identity)(?:\.(?:pem|key))?$/i;

const PRIVATE_KEY_EXTENSION = /\.(?:pem|key|p12|pfx|p8|jks|keystore)$/i;

const SENSITIVE_STATE_BASENAME = /^(?:terraform\.tfstate(?:\.backup)?|.*\.tfstate(?:\.backup)?)$/i;

const SENSITIVE_CREDENTIAL_BASENAME = /^(?:\.?netrc|_netrc|\.curlrc|(?:access|refresh|auth|oauth|api|client)[-_]?(?:token|key|secret)s?|service[-_]?account|(?:token|tokens|secret|secrets|credential|credentials))(?:\.(?:json|ya?ml|toml|ini|conf|cfg|txt|db|sqlite))?$/i;

const RESOURCE_TOKEN = /\{\{resource:[a-z][a-z0-9._-]{0,63}\}\}/;

const denylistCache = new Map();

const MAX_PRIVACY_DENYLIST_BYTES = 1024 * 1024;

const MAX_DENYLIST_CACHE_ENTRIES = 64;

const IRREVERSIBLE_TOOLS = new Set([
  "run_process", "start_process", "write_process", "kill_process", "exec_command",
  "run_local_command", "start_job", "generate_ssh_key_resource", "browser_fill_form",
  "browser_upload_files", "operate_local_application", "computer_act",
]);

const PARTIALLY_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file", "apply_patch", "git_commit",
  "cancel_job", "open_local_application", "pair_browser_extension",
]);

const HARMLESS_BROWSER_ACTIONS = new Set(["hover", "focus", "scroll_into_view"]);

export function classifyReversibility(tool, args = {}) {
  const name = String(tool || "");
  if (!name) return "irreversible";
  if (name === "browser_manage_tabs") {
    return args?.action === "close" ? "irreversible" : "partially_reversible";
  }
  if (name === "browser_action") {
    if (args?.value_resource) return "irreversible";
    const action = typeof args?.action === "string" ? args.action : "";
    return HARMLESS_BROWSER_ACTIONS.has(action) ? "partially_reversible" : "irreversible";
  }
  if (IRREVERSIBLE_TOOLS.has(name)) return "irreversible";
  if (PARTIALLY_REVERSIBLE_TOOLS.has(name)) return "partially_reversible";
  if (STATIC_TOOL_SECURITY.has(name) && STATIC_TOOL_SECURITY.get(name)?.effect === "read-only") return "reversible";
  if (name === "computer_observe" || name === "browser_status" || name === "browser_screenshot" || name === "stage_job") {
    return "reversible";
  }
  return "partially_reversible";
}

export function loadPrivacyDenylistCached(filePath, { allowMissing = false } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("privacy denylist path must be a non-empty string");
  }
  const resolved = path.resolve(filePath);
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let fd = null;
  let stats;
  let rawBytes;
  try {
    try {
      fd = openSync(resolved, openFlags);
    } catch (error) {
      denylistCache.delete(resolved);
      if (error?.code === "ENOENT") {
        if (allowMissing) return [];
        throw new Error("local privacy denylist does not exist");
      }
      if (error?.code === "EISDIR") {
        throw new Error("local privacy denylist exists but could not be read: path is not a regular file");
      }
      if (error?.code === "ELOOP") {
        throw new Error("local privacy denylist exists but could not be read: symbolic links are not allowed");
      }
      throw new Error("local privacy denylist exists but could not be read");
    }
    try {
      stats = fstatSync(fd, { bigint: true });
    } catch {
      denylistCache.delete(resolved);
      throw new Error("local privacy denylist exists but could not be stat'ed");
    }
    if (!stats.isFile()) {
      denylistCache.delete(resolved);
      throw new Error("local privacy denylist exists but could not be read: path is not a regular file");
    }
    if (stats.size > BigInt(MAX_PRIVACY_DENYLIST_BYTES)) {
      denylistCache.delete(resolved);
      throw new Error("local privacy denylist exists but could not be read: exceeds maximum size");
    }
    const cached = denylistCache.get(resolved);
    if (
      cached
      && cached.dev === stats.dev
      && cached.ino === stats.ino
      && cached.size === stats.size
      && cached.mtimeNs === stats.mtimeNs
      && cached.ctimeNs === stats.ctimeNs
    ) {
      return [...cached.entries];
    }
    const byteLength = Number(stats.size);
    rawBytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const n = readSync(fd, rawBytes, offset, byteLength - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    rawBytes = rawBytes.subarray(0, offset);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close errors after read */ }
    }
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    denylistCache.delete(resolved);
    throw new Error("local privacy denylist exists but could not be read: invalid UTF-8");
  }
  const entries = [...new Set(text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.length >= 3)
    .map((line) => line.toLocaleLowerCase("en-US")))];
  if (!denylistCache.has(resolved) && denylistCache.size >= MAX_DENYLIST_CACHE_ENTRIES) {
    const oldestKey = denylistCache.keys().next().value;
    if (oldestKey !== undefined) denylistCache.delete(oldestKey);
  }
  denylistCache.set(resolved, {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    entries,
  });
  return [...entries];
}

export function operationMayHaveSideEffects(tool) {
  const entry = typeof tool === "string" ? STATIC_TOOL_SECURITY.get(tool) : null;
  return entry?.effect !== "read-only";
}

export async function classifyOperation(tool, args = {}, options = {}) {
  const name = String(tool || "");
  const decision = await classifyOperationDecision(name, args, options);
  if (decision) decision.reversibility = classifyReversibility(name, args);
  return decision;
}

async function classifyOperationDecision(name, args = {}, options = {}) {
  // Fail closed: an unclassified tool has no reviewed scope requirement, and treating that
  // as "no approval needed" would silently widen remote authority. Catalog/contract parity is
  // enforced by tests, but the runtime must not depend on a test to stay safe.
  if (!STATIC_TOOL_SECURITY.has(name)) {
    throw new BridgeError("invalid_request", `tool ${name || "(empty)"} has no static security classification`, {
      details: { reason: "unclassified_tool" },
    });
  }
  if (PROTECTED_RESOURCE_INVENTORY_TOOLS.has(name)) return requirement("sensitive-read", "protected local resource inventory", name, {});
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
  if (BROWSER_UPLOAD_TOOLS.has(name)) {
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
  if (PATCH_TOOLS.has(name)) {
    // Use the same strict envelope parser as execution. A regex approximation can
    // classify hunk text as a path and disagree with the operation that actually runs.
    const paths = parsePatchEnvelope(args.patch)
      .flatMap((operation) => [operation.path, operation.moveTo].filter(Boolean));
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

export function isSensitivePath(target) {
  const lower = path.resolve(target).toLowerCase();
  const segments = lower.split(/[\\/]+/);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (segments.some((segment, index) => segment === ".config" && SENSITIVE_CONFIG_SEGMENTS.has(segments[index + 1]))) return true;
  const base = path.basename(lower);
  if (isSensitiveEnvironmentFile(base)) return true;
  if (PRIVATE_KEY_BASENAME.test(base) || PRIVATE_KEY_EXTENSION.test(base) || SENSITIVE_STATE_BASENAME.test(base)) return true;
  return SENSITIVE_CREDENTIAL_BASENAME.test(base) || ["authorized_keys", "known_hosts.old", "id_ecdsa_sk", "id_ed25519_sk"].includes(base);
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

function toolNamesForFamily(family) {
  return new Set([...STATIC_TOOL_SECURITY.entries()]
    .filter(([, entry]) => entry?.family === family)
    .map(([name]) => name));
}
const MAX_HOSTED_RESULT_BYTES = Number(relayContract.maximumHostedReadFileResultBytes);

export function hostedFileReadLimits(context) {
  if (context?.authority?.origin !== "relay") return null;
  return { defaultContentBytes: MAX_HOSTED_RESULT_BYTES, maximumContentBytes: MAX_HOSTED_RESULT_BYTES };
}

export function formatNumberedSlice(selected, startLine, endLine) {
  const lines = selected.split(/\r?\n/);
  const maxDigits = Math.max(4, String(endLine).length);
  return lines.map((line, idx) => `${String(startLine + idx).padStart(maxDigits, " ")} | ${line}`).join("\n");
}

export function hostedFileReadResult({
  context, base, content, lineStarts, startLine, selectedEnd, totalLines, maxContentBytes, automatic, withLineNumbers = false,
}) {
  if (context?.authority?.origin !== "relay") return null;
  const candidate = (endLine, continuation) => {
    const startOffset = lineStarts[startLine - 1];
    const endOffset = endLine < totalLines ? lineStarts[endLine] : content.length;
    const rawSelected = content.slice(startOffset, endOffset);
    const selected = withLineNumbers ? formatNumberedSlice(rawSelected, startLine, endLine) : rawSelected;
    const value = {
      ...base, content: selected, start_line: startLine, end_line: endLine, total_lines: totalLines,
      complete: startLine === 1 && endLine === totalLines,
      truncated: Boolean(continuation),
      ...(continuation ? { next_start_line: endLine + 1 } : {}),
    };
    return { value, contentBytes: Buffer.byteLength(selected), resultBytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  const fits = (entry) => entry.contentBytes <= maxContentBytes && entry.resultBytes <= MAX_HOSTED_RESULT_BYTES;
  const final = candidate(selectedEnd, false);
  if (fits(final)) return final.value;
  if (!automatic) throw hostedReadLimitError(final, maxContentBytes);
  const first = candidate(startLine, startLine < selectedEnd);
  if (!fits(first)) throw hostedReadLimitError(first, maxContentBytes);
  let low = startLine;
  let high = selectedEnd - 1;
  let best = first;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = candidate(middle, true);
    if (fits(current)) { best = current; low = middle + 1; }
    else high = middle - 1;
  }
  return best.value;
}

function hostedReadLimitError(entry, maximumContentBytes) {
  return new BridgeError("limit_exceeded", `hosted read_file result exceeds the ${MAX_HOSTED_RESULT_BYTES}-byte serialized result budget`, {
    retryable: false,
    details: {
      reason: "hosted_read_result_limit", maximum_result_bytes: MAX_HOSTED_RESULT_BYTES, actual_result_bytes: entry.resultBytes,
      maximum_content_bytes: maximumContentBytes, selected_content_bytes: entry.contentBytes,
    },
  });
}
export class CapabilityObserver {
  constructor(now = () => Date.now(), taskFingerprintKey = randomBytes(32)) {
    this.now = now;
    this.taskFingerprintKey = Buffer.from(taskFingerprintKey);
    this.bootstrapCount = 0;
    this.resolutionCount = 0;
    this.lastBootstrap = null;
    this.lastResolution = null;
  }

  recordBootstrap(result) {
    this.bootstrapCount += 1;
    this.lastBootstrap = {
      observed_at: timestamp(this.now()),
      target: result?.target || ".",
      instruction_bytes: Buffer.byteLength(String(result?.instructions || "")),
      builtin_loaded: Boolean(result?.builtin_instructions),
      automatic_project_context_loaded: Boolean(result?.automatic_project_context),
      global_model_instructions_loaded: Boolean(result?.model_instructions_file),
      refresh_fingerprint: String(result?.capability_refresh?.instruction_and_command_fingerprint || ""),
    };
  }

  recordResolution(task, result) {
    this.resolutionCount += 1;
    this.lastResolution = {
      observed_at: timestamp(this.now()),
      task_fingerprint: createHmac("sha256", this.taskFingerprintKey).update(String(task || "")).digest("hex"),
      target: result?.target || ".",
      selected_skill: result?.selected_skill?.name || null,
      matched_skills: Array.isArray(result?.skill_matches) ? result.skill_matches.length : 0,
      matched_commands: Array.isArray(result?.command_matches) ? result.command_matches.length : 0,
      matched_applications: Array.isArray(result?.application_matches) ? result.application_matches.length : 0,
      recommended_tools: Array.isArray(result?.recommended_tools) ? [...result.recommended_tools] : [],
      primary_route: result?.execution_routing?.primary_route?.id || null,
      routing_ambiguity: result?.execution_routing?.ambiguity?.level || "none",
      routing_score_gap: Number.isFinite(Number(result?.execution_routing?.ambiguity?.score_gap))
        ? Number(result.execution_routing.ambiguity.score_gap)
        : 0,
      refresh_fingerprint: String(result?.refresh?.fingerprint || ""),
    };
  }

  snapshot() {
    return {
      bootstrap_observed: this.bootstrapCount > 0,
      bootstrap_count: this.bootstrapCount,
      task_resolution_observed: this.resolutionCount > 0,
      task_resolution_count: this.resolutionCount,
      last_bootstrap: this.lastBootstrap ? structuredClone(this.lastBootstrap) : null,
      last_task_resolution: this.lastResolution ? structuredClone(this.lastResolution) : null,
      enforcement_boundary: "The server can discover, rank, load, and report capabilities; the MCP host decides whether to call the resolver or recommended tools.",
    };
  }
}

function timestamp(milliseconds) {
  return new Date(Number(milliseconds)).toISOString();
}
