// @ts-check
import { toolCallAdmission, toolCallCapacityConfig, toolCallCapacityUsage } from "../../shared/tool-call-capacity.mjs";
import { BridgeError } from "../core/errors.mjs";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { positiveInteger } from "../../shared/numbers.mjs";
import { bindCallPrincipal, callIdsForAuthority, assertCallRegistryOpen, cancelAllCallsAndWait, notifyCallRegistryChanged, buildContinuationContract, compoundExecutionIntent, durableExecutionIntent, existingManagedJobContinuationIntent, interactiveProcessIntent, interruptionContinuityIntent, keepWorkingIntent, managedJobCommandExecutionIntent, managedJobCreationIntent, nonExecutionIntent, readOnlyDiagnosticIntent } from "./call-helpers.mjs";
import { relevanceScore } from "../core/authority.mjs";
import { findToolGroup } from "../../shared/tool-groups.mjs";
import { toolDefinition, toolNamesForPolicy } from "../core/policy.mjs";
import { Buffer } from "node:buffer";

/** @param {unknown} maximumValue @param {unknown} reservedValue @param {Iterable<string>} [reservedTools] */
export function callCapacityConfig(maximumValue, reservedValue, reservedTools = []) {
  const maximum = Number(maximumValue);
  return toolCallCapacityConfig(
    Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : 16,
    reservedValue,
    reservedTools,
  );
}

/** @param {Map<string, any>} calls @param {ReturnType<typeof callCapacityConfig>} config @param {string} toolName */
export function assertCallCapacity(calls, config, toolName) {
  const decision = toolCallAdmission(callSnapshot(calls), config, toolName);
  if (decision.allowed) return;
  if (decision.reason === "total_capacity") {
    throw new BridgeError("limit_exceeded", `too many concurrent tool calls (${config.maximum})`, { retryable: true });
  }
  throw new BridgeError(
    "limit_exceeded",
    `ordinary tool-call capacity reached (${config.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`,
    { retryable: true },
  );
}

/** @param {Map<string, any>} calls @param {ReturnType<typeof callCapacityConfig>} config */
export function callCapacitySnapshot(calls, config) {
  const usage = toolCallCapacityUsage(callSnapshot(calls), config);
  return {
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_capacity: usage.reserved,
    active_reserved: usage.activeReserved,
    active_ordinary: usage.activeOrdinary,
  };
}

/** @param {Map<string, any>} calls */
function callSnapshot(calls) {
  const byTool = Object.create(null);
  for (const call of calls.values()) byTool[call.tool] = (byTool[call.tool] || 0) + 1;
  return { active: calls.size, byTool };
}
/** @typedef {ReturnType<typeof setTimeout>} TimerHandle */
/**
 * @typedef {{
 *   id: string,
 *   tool: string,
 *   origin: string,
 *   startedAt: number,
 *   deadlineAt: number | null,
 *   controller: AbortController,
 *   cancelReason: string,
 *   timer: TimerHandle | null,
 *   owner_kind?: string, owner_account_id?: string, owner_account_version?: number,
 *   owner_client_id?: string, owner_family_id?: string,
 * }} CallRecord
 */
/**
 * @typedef {{
 *   maximum?: unknown,
 *   reserved?: unknown,
 *   reservedTools?: Iterable<string>,
 *   now?: () => number,
 *   scheduler?: {setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout},
 *   onCancel?: (record: CallRecord) => void,
 *   onFinish?: (record: CallRecord) => void,
 * }} CallRegistryOptions
 */
/**
 * @typedef {{callId?: unknown, tool?: unknown, origin?: unknown, timeoutMs?: unknown}} OpenCallInput
 */
/** @typedef {{signal?: AbortSignal, callId?: unknown}} CancellationContext */

export class CallRegistry {
  /** @param {CallRegistryOptions} [options] */
  constructor(options = {}) {
    this.capacity = callCapacityConfig(options.maximum, options.reserved, options.reservedTools);
    this.maximum = this.capacity.maximum;
    this.now = typeof options.now === "function" ? options.now : () => performance.now();
    this.scheduler = options.scheduler || { setTimeout, clearTimeout };
    this.onCancel = typeof options.onCancel === "function" ? options.onCancel : () => {};
    this.onFinish = typeof options.onFinish === "function" ? options.onFinish : () => {};
    /** @type {Map<string, CallRecord>} */
    this.calls = new Map();
  }

  /** @param {OpenCallInput} [input] */
  open({ callId = "", tool = "", origin = "local", timeoutMs = 0 } = {}) {
    assertCallRegistryOpen(this);
    const id = String(callId || `call_${randomBytes(16).toString("hex")}`);
    const toolName = String(tool || "");
    if (this.calls.has(id)) throw new BridgeError("conflict", "duplicate in-flight call id");
    assertCallCapacity(this.calls, this.capacity, toolName);
    const controller = new AbortController();
    const startedAt = this.now();
    const timeout = positiveInteger(timeoutMs, 0);
    /** @type {CallRecord} */
    const record = {
      id,
      tool: toolName,
      origin: String(origin || "local"),
      startedAt,
      deadlineAt: timeout ? startedAt + timeout : null,
      controller,
      cancelReason: "",
      timer: null,
    };
    if (timeout) {
      record.timer = this.scheduler.setTimeout(() => this.cancel(id, "deadline exceeded", "timeout"), timeout);
      record.timer?.unref?.();
    }
    this.calls.set(id, record);
    return Object.freeze({
      callId: id,
      tool: record.tool,
      origin: record.origin,
      startedAt,
      deadlineAt: record.deadlineAt,
      signal: controller.signal,
    });
  }

  /** @param {unknown} callId @param {unknown} [reason] @param {string} [code] */
  cancel(callId, reason = "cancelled", code = "cancelled") {
    const record = this.calls.get(String(callId || ""));
    if (!record || record.controller.signal.aborted) return false;
    record.cancelReason = String(reason || "cancelled").slice(0, 256);
    record.controller.abort(new BridgeError(code, code === "timeout" ? "tool call timed out" : "tool call cancelled"));
    this.onCancel(record);
    return true;
  }

  /** @param {unknown} callId */
  finish(callId) {
    const id = String(callId || "");
    const record = this.calls.get(id);
    if (!record) return false;
    if (record.timer) this.scheduler.clearTimeout(record.timer);
    this.calls.delete(id);
    try { this.onFinish(record); } finally { notifyCallRegistryChanged(this); }
    return true;
  }

  /** @param {unknown} origin */
  idsByOrigin(origin) {
    const expected = String(origin || "");
    return [...this.calls.values()]
      .filter((record) => record.origin === expected)
      .map((record) => record.id);
  }

  /** @param {unknown} origin @param {unknown} [reason] */
  cancelOrigin(origin, reason = "transport disconnected") {
    let cancelled = 0;
    for (const id of this.idsByOrigin(origin)) {
      if (this.cancel(id, reason)) cancelled += 1;
    }
    return cancelled;
  }

  /** @param {unknown} callId @param {unknown} principal */ bindPrincipal(callId, principal) {
    return bindCallPrincipal(this.calls.get(String(callId || "")), principal);
  }

  /** @param {unknown} revocation */ cancelAuthority(revocation) {
    let cancelled = 0;
    for (const id of callIdsForAuthority(this.calls.values(), revocation))
      if (this.cancel(id, "authority revoked", "authorization_denied")) cancelled += 1;
    return cancelled;
  }

  /** @param {unknown} [reason] @param {number} [waitMs] */
  async cancelAllAndWait(reason = "runtime stopped", waitMs = 5_000) {
    await cancelAllCallsAndWait(this, reason, waitMs);
  }

  /** @param {unknown} callId */
  context(callId) {
    const record = this.calls.get(String(callId || ""));
    if (!record) return null;
    return {
      callId: record.id,
      tool: record.tool,
      origin: record.origin,
      startedAt: record.startedAt,
      deadlineAt: record.deadlineAt,
      signal: record.controller.signal,
    };
  }

  /** @param {CancellationContext} [context] */
  throwIfCancelled(context = {}) {
    const signal = context.signal || this.calls.get(String(context.callId || ""))?.controller.signal;
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new BridgeError("cancelled", "tool call cancelled");
  }

  snapshot() {
    const now = this.now();
    /** @type {Record<string, number>} */
    const byOrigin = Object.create(null);
    let oldestMs = 0;
    for (const call of this.calls.values()) {
      byOrigin[call.origin] = (byOrigin[call.origin] || 0) + 1;
      oldestMs = Math.max(oldestMs, now - call.startedAt);
    }
    return {
      active: this.calls.size,
      ...callCapacitySnapshot(this.calls, this.capacity),
      by_origin: byOrigin,
      oldest_ms: oldestMs,
    };
  }
}
export const MAX_TOOL_SELECTION_TEXT_CHARACTERS = 160;

/**
 * Stable bounded ranking text. Operational descriptions are excluded so safety/settlement prose
 * can evolve without silently changing deterministic tool selection.
 * @param {{name?: string, title?: string} | null | undefined} tool
 */
export function toolSelectionText(tool) {
  const name = String(tool?.name || "").trim();
  const title = String(tool?.title || "").replace(/\s+/g, " ").trim();
  const group = findToolGroup(name) || "";
  return [name, title, group].filter(Boolean).join(" ").slice(0, MAX_TOOL_SELECTION_TEXT_CHARACTERS);
}

const MAX_ROUTES = 6;

const MAX_RANKED_TOOLS = 12;

const MAX_RECOMMENDED_TOOLS = 18;

/** @typedef {{id: string, title: string, tools: readonly string[], guidance: string, keywords: readonly string[]}} RouteDefinition */
/** @typedef {{id: string, title: string, score: number, tools: string[], guidance: string, reasons: string[]}} ScoredRoute */
/** @typedef {Record<string, unknown> & {availableTools?: Iterable<unknown> | null, policy?: Record<string, unknown>, seedTools?: unknown[], skillRelevant?: boolean, commandRelevant?: boolean, applicationMatches?: unknown[], browserAvailable?: boolean}} ExecutionRoutingOptions */

const ROUTES = Object.freeze([
  route("guided-workflow", "Guided workflow", [
    "load_local_skill", "agent_context", "list_local_skills",
  ], "Use a project or user skill when a repeatable domain workflow already exists.", [
    "skill", "workflow", "instructions", "playbook", "guide", "技能", "工作流", "规范", "流程",
  ]),
  route("registered-command", "Registered command", [
    "run_local_command", "list_local_commands",
  ], "Use a fixed argv/cwd command when the repository already defines the operation.", [
    "package script", "registered command", "repeatable command", "npm script", "构建脚本", "项目命令", "重复执行",
  ]),
  route("shell", "Direct shell", [
    "exec_command", "run_process",
  ], "Use Bash or direct argv for efficient ad hoc composition, investigation, and ordinary CLI work when the effective authority exposes those tools. This is the general unsandboxed escape hatch inside that authority, not a way around it.", [
    "bash", "shell", "terminal", "cli", "command", "script", "debug", "diagnose", "benchmark", "audit", "probe",
    "命令", "终端", "脚本", "排查", "调试", "基准", "审查", "测试", "构建",
  ]),
  route("process-session", "Interactive process", [
    "start_process", "read_process", "write_process", "kill_process",
  ], "Use a retained process session for interactive stdin, incremental output, servers, watchers, and REPL-style work.", [
    "interactive", "stdin", "repl", "watch", "tail", "stream output", "dev server", "long output", "交互", "实时日志", "输入", "常驻进程",
  ]),
  route("managed-job", "Durable managed job", [
    "stage_job", "start_job", "read_job", "list_jobs", "cancel_job",
  ], "Use a durable job for non-interactive process execution that must survive relay interruption. Do not wrap read-only server_info, diagnose_runtime, read_file, search_text, or git_status inspection in a managed job.", [
    "background", "detached", "durable", "long running", "resume", "cleanup", "finally", "overnight", "continuous", "retry",
    "interruption", "disconnect", "reconnect", "multi-project", "multi-repository", "multiple projects", "batch",
    "后台", "持久", "断线", "中断", "掉线", "断开", "重连", "恢复", "续跑", "清理", "长时间", "持续", "重试", "多步骤",
    "多个项目", "多个仓库", "跨项目", "批量",
  ]),
  route("workspace-edit", "Workspace files", [
    "search_text", "read_file", "list_files", "list_dir", "edit_file", "apply_patch", "write_file", "view_image",
  ], "Use bounded structured file operations for inspection and precise repository edits; combine with shell when a CLI is more efficient.", [
    "file", "source", "code", "edit", "write", "patch", "refactor", "search", "inspect", "repository",
    "文件", "源码", "代码", "修改", "写入", "补丁", "重构", "搜索", "仓库",
  ]),
  route("git-review", "Git repository", [
    "git_status", "git_diff", "git_log", "git_show", "git_commit",
  ], "Use Git-specific structured surfaces for bounded inspection and local commits from an already-staged index; prefer git_commit over generic process execution when creating a commit.", [
    "git", "commit", "diff", "branch", "history", "revision", "提交", "分支", "差异", "历史", "版本",
  ]),
  route("computer-use", "Verified computer use", [
    "computer_observe", "computer_act",
  ], "Use snapshot-bound observe-act-verify for GUI work. Prefer this over separate low-level browser/application calls when the task needs state validation or recovery from ambiguous outcomes.", [
    "computer use", "gui agent", "screen grounding", "verify action", "电脑操作", "界面操作", "视觉定位", "验证结果",
  ]),
  route("browser", "Existing browser profile", [
    "browser_status", "browser_list_tabs", "browser_manage_tabs", "browser_get_source", "browser_inspect_page",
    "browser_wait", "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
  ], "Use the paired daily browser for authenticated websites, complex forms, DOM inspection, and actions that depend on the user's existing session.", [
    "browser", "website", "web page", "tab", "dom", "form", "login", "authenticated", "chrome", "网页", "浏览器", "网站", "标签页", "表单", "登录",
  ]),
  route("application-discovery", "Installed application inventory", [
    "list_local_applications",
  ], "Use read-only local application discovery to identify installed apps and launchers without implying authority to open, inspect, or operate them.", [
    "installed app", "application inventory", "application discovery", "launcher", "已安装应用", "应用清单", "应用发现", "启动器",
  ]),
  route("application", "Desktop application", [
    "open_local_application", "inspect_local_application", "operate_local_application",
  ], "Use structured desktop automation for installed applications and macOS Accessibility surfaces.", [
    "application", "desktop", "gui", "window", "accessibility", "mac app", "应用", "桌面", "界面", "窗口", "软件",
  ]),
  route("protected-resource", "Protected local resource", [
    "list_local_resources", "generate_ssh_key_resource",
  ], "Use registered resource aliases for secrets or files that should not be copied into MCP arguments.", [
    "credential", "secret", "token", "private key", "ssh key", "password", "resource alias", "凭据", "密钥", "令牌", "密码", "资源别名",
  ]),
  route("diagnostics", "Runtime diagnostics", [
    "server_info", "project_overview", "diagnose_runtime",
  ], "Call structured diagnostics directly for read-only authorization, relay, filesystem, process, shell, and runtime inspection; do not create a managed process job merely to call server_info or diagnose_runtime.", [
    "status", "health", "diagnose", "runtime", "relay", "policy", "authorization", "状态", "健康", "诊断", "运行时", "权限", "连接",
  ]),
]);

const ROUTE_FALLBACKS = Object.freeze({
  "guided-workflow": ["registered-command", "shell"],
  "registered-command": ["shell", "process-session"],
  shell: ["process-session", "managed-job"],
  "process-session": ["shell", "managed-job"],
  "managed-job": ["process-session", "shell"],
  "workspace-edit": ["shell", "git-review"],
  "git-review": ["workspace-edit", "shell"],
  "computer-use": ["browser", "application", "diagnostics"],
  browser: ["computer-use", "diagnostics", "shell"],
  "application-discovery": ["application", "diagnostics"],
  application: ["computer-use", "diagnostics", "shell"],
  "protected-resource": ["diagnostics"],
  diagnostics: ["shell"],
});

/** Build bounded advisory routing without changing effective authority. */
/** @param {string} task @param {ExecutionRoutingOptions} [options] */
export function buildExecutionRouting(task, options = {}) {
  const text = String(task || "");
  const availableNames = options.availableTools === null || options.availableTools === undefined
    ? new Set(toolNamesForPolicy(options.policy || {}))
    : new Set([...options.availableTools].map((tool) => String(tool || "")).filter(Boolean));
  const toolScores = [...availableNames]
    .map((name) => toolDefinition(name))
    .filter((tool) => tool !== null)
    .map((tool) => ({
      tool: String(tool.name),
      score: relevanceScore(text, toolSelectionText(tool), tool.name),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.localeCompare(right.tool));
  const scoreByTool = new Map(toolScores.map((item) => [item.tool, item.score]));

  const scoredRoutes = ROUTES
    .map((definition) => scoreRoute(definition, text, availableNames, scoreByTool, options))
    .filter((routeValue) => routeValue !== null)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (!scoredRoutes.length) {
    const fallback = ROUTES.find((item) => item.id === "shell" && item.tools.some((tool) => availableNames.has(tool)))
      || ROUTES.find((item) => item.id === "diagnostics" && item.tools.some((tool) => availableNames.has(tool)));
    if (fallback) {
      const fallbackRoute = scoreRoute(fallback, text, availableNames, scoreByTool, options, 1);
      if (fallbackRoute) scoredRoutes.push(fallbackRoute);
    }
  }

  const availableRouteIds = new Set(ROUTES
    .filter((definition) => routeUsable(definition, text, availableNames, options))
    .map((definition) => definition.id));
  const continuation = buildContinuationContract(text, availableNames, options);
  const selectedRoutes = selectRoutes(scoredRoutes, availableRouteIds);
  const managedPrimary = continuation.task_supervisor ? scoredRoutes.find((routeValue) => routeValue.id === "managed-job") : null;
  const routes = managedPrimary ? [managedPrimary, ...selectedRoutes.filter((routeValue) => routeValue.id !== "managed-job")].slice(0, MAX_ROUTES) : selectedRoutes;
  const primary = routes[0] || null;
  const second = routes[1] || null;
  const scoreGap = primary && second ? primary.score - second.score : primary ? primary.score : 0;
  const ambiguity = !primary
    ? "none"
    : second && scoreGap <= 2
      ? "high"
      : second && scoreGap <= 5
        ? "medium"
        : "low";

  const recommendedTools = unique([
    ...(continuation.task_supervisor ? ["start_job", "read_job"] : []), ...routes.slice(0, 3).flatMap((item) => rankedRouteTools(item, scoreByTool, 5)),
    ...(Array.isArray(options.seedTools) ? options.seedTools : []), ...toolScores.slice(0, MAX_RANKED_TOOLS).map((item) => item.tool),
  ]).filter((tool) => availableNames.has(tool)).slice(0, MAX_RECOMMENDED_TOOLS);

  return {
    schema_version: 1,
    strategy: "set-level advisory routing; direct shell is an escape hatch only inside the effective authority",
    score_semantics: "deterministic relative ranking within this response; scores are not probabilities and are not comparable across versions",
    effective_tool_count: availableNames.size,
    policy_effective_tool_count: toolNamesForPolicy(options.policy || {}).length,
    primary_route: primary ? publicRoute(primary, availableRouteIds) : null,
    routes: routes.map((routeValue) => publicRoute(routeValue, availableRouteIds)),
    ranked_tools: toolScores.slice(0, MAX_RANKED_TOOLS),
    ambiguity: {
      level: ambiguity,
      score_gap: scoreGap,
      competing_routes: ambiguity === "none" ? [] : routes.slice(0, ambiguity === "high" ? 3 : 2).map((item) => item.id),
    },
    recommended_tools: recommendedTools,
    continuation,
    recovery_guidance: [
      "Diagnose policy, relay, or runtime failures before changing execution surfaces.",
      "For coherent compound work that must survive relay interruption, put the non-interactive sequence in one managed job and resume the same durable job after reconnect instead of replaying one-step side effects.",
      "After an ambiguous mutation failure, inspect stable state before retrying; do not assume the side effect did not occur.",
      "A fallback route is an alternative execution surface, not permission to bypass host or effective-authority denial.",
    ],
    enforcement: "advisory_only; the MCP host may choose only tools allowed by the effective authority",
  };
}

/** @param {ScoredRoute[]} scoredRoutes @param {Set<string>} availableRouteIds */
function selectRoutes(scoredRoutes, availableRouteIds) {
  const routes = scoredRoutes.slice(0, MAX_ROUTES);
  if (!availableRouteIds.has("shell") || routes.some((routeValue) => routeValue.id === "shell")) return routes;
  const shell = scoredRoutes.find((routeValue) => routeValue.id === "shell");
  if (!shell) return routes;
  if (routes.length < MAX_ROUTES) return [...routes, shell];
  return [...routes.slice(0, MAX_ROUTES - 1), shell];
}

/** @param {ScoredRoute} routeValue @param {Map<string, number>} scoreByTool @param {number} maximum */
function rankedRouteTools(routeValue, scoreByTool, maximum) {
  return routeValue.tools
    .map((tool, index) => ({ tool, index, score: scoreByTool.get(tool) || 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map((item) => item.tool);
}

/** @param {string} id @param {string} title @param {string[]} tools @param {string} guidance @param {string[]} keywords @returns {RouteDefinition} */
function route(id, title, tools, guidance, keywords) {
  return Object.freeze({ id, title, tools: Object.freeze(tools), guidance, keywords: Object.freeze(keywords) });
}

/** @param {RouteDefinition} definition @param {string} task @param {Set<string>} availableNames @param {ExecutionRoutingOptions} [options] */
function routeUsable(definition, task, availableNames, options = {}) {
  if (!definition.tools.some((tool) => availableNames.has(tool))) return false;
  return definition.id !== "managed-job" || !managedJobCreationIntent(task, options)
    || availableNames.has("start_job") || availableNames.has("stage_job");
}

/** @param {RouteDefinition} definition @param {string} task @param {Set<string>} availableNames @param {Map<string, number>} scoreByTool @param {ExecutionRoutingOptions} options @param {number} [fallbackScore] @returns {ScoredRoute | null} */
function scoreRoute(definition, task, availableNames, scoreByTool, options, fallbackScore = 0) {
  if (!routeUsable(definition, task, availableNames, options)) return null;
  const tools = definition.tools.filter((tool) => availableNames.has(tool));
  let score = relevanceScore(task, `${definition.title} ${definition.guidance} ${definition.keywords.join(" ")}`, definition.id);
  const reasons = [];
  const boost = dynamicBoost(definition.id, task, options);
  score += boost.score;
  reasons.push(...boost.reasons);
  const memberScores = tools.map((tool) => scoreByTool.get(tool) || 0).sort((left, right) => right - left);
  score += Math.min(6, (memberScores[0] || 0) + Math.floor((memberScores[1] || 0) / 2));
  if (definition.id === "shell") {
    score += 2;
    reasons.push("general_escape_hatch_available");
  }
  score = Math.max(score, fallbackScore);
  if (score <= 0) return null;
  return {
    id: definition.id,
    title: definition.title,
    score,
    tools,
    guidance: definition.guidance,
    reasons: unique(reasons),
  };
}

/** @param {string} id @param {string} task @param {ExecutionRoutingOptions} options */
function dynamicBoost(id, task, options) {
  const lower = String(task || "").toLowerCase();
  /** @type {string[]} */
  const reasons = [];
  let score = 0;
  /** @param {number} amount @param {string} reason */
  const add = (amount, reason) => { score += amount; reasons.push(reason); };
  if (id === "guided-workflow" && options.skillRelevant === true) add(18, "relevant_skill_found");
  if (id === "registered-command" && options.commandRelevant === true) add(20, "relevant_registered_command_found");
  if (id === "application" && Array.isArray(options.applicationMatches) && options.applicationMatches.length > 0) add(20, "installed_application_match");
  if (id === "computer-use" && /computer use|gui agent|screen grounding|电脑操作|界面操作|视觉定位/.test(lower)) add(18, "computer_use_intent");
  if (id === "browser" && options.browserAvailable === true && /browser|chrome|edge|brave|网页|浏览器|表单|网站|登录/.test(lower)) add(14, "browser_intent");
  if (id === "application-discovery" && Array.isArray(options.applicationMatches) && options.applicationMatches.length > 0) add(8, "installed_application_inventory_match");
  if (id === "managed-job") {
    if (interactiveProcessIntent(task)) add(-20, "interactive_process_preferred");
    else if (!nonExecutionIntent(task) && !existingManagedJobContinuationIntent(task)) { if (managedJobCommandExecutionIntent(task, options)) add(30, "managed_command_execution_intent"); if (durableExecutionIntent(task) || /resume|continuous|断线|持续|重试/.test(lower)) add(14, "durability_or_cleanup_intent"); if (keepWorkingIntent(task)) add(24, "explicit_keep_working_intent"); if (interruptionContinuityIntent(task)) add(12, "interruption_continuity_intent"); if (compoundExecutionIntent(task)) add(12, "compound_execution_intent"); }
  }
  if (id === "process-session" && interactiveProcessIntent(task)) add(18, "interactive_process_intent");
  if (id === "shell" && /bash|shell|terminal|cli|command|script|debug|diagnos|benchmark|audit|probe|命令|终端|脚本|排查|调试|基准|审查|测试|构建/.test(lower)) add(10, "shell_or_cli_intent");
  if (id === "workspace-edit" && /file|source|code|edit|write|patch|refactor|repository|文件|源码|代码|修改|写入|补丁|重构|仓库/.test(lower)) add(10, "workspace_change_intent");
  if (id === "git-review" && /git|commit|diff|branch|history|revision|提交|分支|差异|历史|版本/.test(lower)) add(12, "git_intent");
  if (id === "protected-resource" && /credential|secret|token|private key|ssh key|password|凭据|密钥|令牌|密码/.test(lower)) add(14, "protected_data_intent");
  if (id === "diagnostics" && /status|health|diagnos|runtime|relay|policy|authorization|root cause|failure|error|incident|why|状态|健康|诊断|运行时|权限|连接|查明|原因|故障|异常/.test(lower)) add(10, "runtime_diagnostic_intent");
  if (id === "diagnostics" && readOnlyDiagnosticIntent(task)) add(18, "direct_read_only_diagnostic_intent");
  return { score, reasons };
}

/** @param {ScoredRoute} routeValue @param {Set<string>} availableRouteIds */
function publicRoute(routeValue, availableRouteIds) {
  const fallbackRoutes = ROUTE_FALLBACKS[/** @type {keyof typeof ROUTE_FALLBACKS} */ (routeValue.id)] || [];
  return { id: routeValue.id, title: routeValue.title, score: routeValue.score, tools: [...routeValue.tools], guidance: routeValue.guidance, reasons: [...routeValue.reasons], fallback_routes: fallbackRoutes.filter((id) => availableRouteIds.has(id)) };
}

/** @param {unknown[]} values */
function unique(values) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}
export const MAX_TOOL_RESULT_BYTES = 7 * 1024 * 1024;

/**
 * @param {unknown} value
 * @param {{ maximumBytes?: number }} [options]
 */
export function normalizeToolResult(value, options = {}) {
  const maximumBytes = positiveInteger(options.maximumBytes, MAX_TOOL_RESULT_BYTES);
  let serialized;
  try {
    serialized = JSON.stringify(value, rejectUnsupportedJsonValue);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("internal_error", "tool returned a result that could not be serialized", {
      cause: error instanceof Error ? error : undefined,
      expose: false,
    });
  }
  if (typeof serialized !== "string") {
    throw new BridgeError("internal_error", "tool returned an unsupported result", { expose: false });
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumBytes) {
    throw new BridgeError("limit_exceeded", "tool result exceeded the relay response limit", {
      retryable: false,
      details: { maximum_bytes: maximumBytes, actual_bytes: bytes },
    });
  }
  try {
    return Object.freeze({ value: JSON.parse(serialized), bytes });
  } catch (error) {
    throw new BridgeError("internal_error", "tool result normalization failed", {
      cause: error instanceof Error ? error : undefined,
      expose: false,
    });
  }
}

/**
 * @param {string} _key
 * @param {unknown} current
 */
function rejectUnsupportedJsonValue(_key, current) {
  if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol" || typeof current === "undefined") {
    throw new BridgeError("internal_error", "tool returned a non-JSON value", { expose: false });
  }
  if (typeof current === "number" && !Number.isFinite(current)) {
    throw new BridgeError("internal_error", "tool returned a non-finite number", { expose: false });
  }
  return current;
}
