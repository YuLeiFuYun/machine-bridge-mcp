// @ts-check

import { relevanceScore } from "./capability-ranking.mjs";
import { toolDefinition, toolNamesForPolicy } from "./policy.mjs";

const MAX_ROUTES = 6;
const MAX_RANKED_TOOLS = 12;
const MAX_RECOMMENDED_TOOLS = 18;

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
  ], "Use Bash or direct argv for efficient ad hoc composition, investigation, and ordinary CLI work. This remains the general escape hatch and is not sandboxed.", [
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
  ], "Use a durable job for long-running or multi-step work that must survive relay interruption and still attempt cleanup.", [
    "background", "detached", "durable", "long running", "resume", "cleanup", "finally", "overnight", "continuous", "retry",
    "后台", "持久", "断线", "恢复", "清理", "长时间", "持续", "重试", "多步骤",
  ]),
  route("workspace-edit", "Workspace files", [
    "search_text", "read_file", "list_files", "list_dir", "edit_file", "apply_patch", "write_file", "view_image",
  ], "Use bounded structured file operations for inspection and precise repository edits; combine with shell when a CLI is more efficient.", [
    "file", "source", "code", "edit", "write", "patch", "refactor", "search", "inspect", "repository",
    "文件", "源码", "代码", "修改", "写入", "补丁", "重构", "搜索", "仓库",
  ]),
  route("git-review", "Git inspection", [
    "git_status", "git_diff", "git_log", "git_show",
  ], "Use Git-specific read surfaces for bounded status, diffs, history, and revision inspection.", [
    "git", "commit", "diff", "branch", "history", "revision", "提交", "分支", "差异", "历史", "版本",
  ]),
  route("browser", "Existing browser profile", [
    "browser_status", "browser_list_tabs", "browser_manage_tabs", "browser_get_source", "browser_inspect_page",
    "browser_wait", "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
  ], "Use the paired daily browser for authenticated websites, complex forms, DOM inspection, and actions that depend on the user's existing session.", [
    "browser", "website", "web page", "tab", "dom", "form", "login", "authenticated", "chrome", "网页", "浏览器", "网站", "标签页", "表单", "登录",
  ]),
  route("application", "Desktop application", [
    "list_local_applications", "open_local_application", "inspect_local_application", "operate_local_application",
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
  ], "Use fixed diagnostics to distinguish authorization, relay, filesystem, process, shell, and runtime failures.", [
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
  browser: ["diagnostics", "shell"],
  application: ["diagnostics", "shell"],
  "protected-resource": ["diagnostics"],
  diagnostics: ["shell"],
});

/**
 * Build advisory, set-level routing for the current task. It never hides tools,
 * changes policy, or makes shell execution conditional on the recommendation.
 * @param {unknown} task
 * @param {{
 *   policy?: Record<string, unknown>,
 *   seedTools?: unknown[],
 *   commandRelevant?: boolean,
 *   skillRelevant?: boolean,
 *   applicationMatches?: unknown[],
 *   browserAvailable?: boolean,
 * }} [options]
 */
export function buildExecutionRouting(task, options = {}) {
  const text = String(task || "");
  const availableNames = new Set(toolNamesForPolicy(options.policy || {}));
  const toolScores = [...availableNames]
    .map((name) => toolDefinition(name))
    .filter(Boolean)
    .map((tool) => ({
      tool: String(tool.name),
      score: relevanceScore(text, `${tool.title || ""} ${tool.description || ""}`, tool.name),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.localeCompare(right.tool));
  const scoreByTool = new Map(toolScores.map((item) => [item.tool, item.score]));

  const scoredRoutes = ROUTES
    .map((definition) => scoreRoute(definition, text, availableNames, scoreByTool, options))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (!scoredRoutes.length) {
    const fallback = ROUTES.find((item) => item.id === "shell" && item.tools.some((tool) => availableNames.has(tool)))
      || ROUTES.find((item) => item.id === "diagnostics" && item.tools.some((tool) => availableNames.has(tool)));
    if (fallback) scoredRoutes.push(scoreRoute(fallback, text, availableNames, scoreByTool, options, 1));
  }

  const routes = scoredRoutes.slice(0, MAX_ROUTES);
  const availableRouteIds = new Set(ROUTES
    .filter((definition) => definition.tools.some((tool) => availableNames.has(tool)))
    .map((definition) => definition.id));
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
    ...routes.slice(0, 3).flatMap((item) => item.tools.slice(0, 5)),
    ...(Array.isArray(options.seedTools) ? options.seedTools : []),
    ...toolScores.slice(0, MAX_RANKED_TOOLS).map((item) => item.tool),
  ]).filter((tool) => availableNames.has(tool)).slice(0, MAX_RECOMMENDED_TOOLS);

  return {
    schema_version: 1,
    strategy: "set-level advisory routing with direct shell retained as a general escape hatch",
    score_semantics: "deterministic relative ranking within this response; scores are not probabilities and are not comparable across versions",
    policy_effective_tool_count: availableNames.size,
    primary_route: primary ? publicRoute(primary, availableRouteIds) : null,
    routes: routes.map((routeValue) => publicRoute(routeValue, availableRouteIds)),
    ranked_tools: toolScores.slice(0, MAX_RANKED_TOOLS),
    ambiguity: {
      level: ambiguity,
      score_gap: scoreGap,
      competing_routes: ambiguity === "none" ? [] : routes.slice(0, ambiguity === "high" ? 3 : 2).map((item) => item.id),
    },
    recommended_tools: recommendedTools,
    recovery_guidance: [
      "Diagnose policy, relay, or runtime failures before changing execution surfaces.",
      "After an ambiguous mutation failure, inspect stable state before retrying; do not assume the side effect did not occur.",
      "A fallback route is an alternative execution surface, not permission to bypass host or effective-policy denial.",
    ],
    enforcement: "advisory_only; the MCP host may choose any tool allowed by the effective policy",
  };
}

function route(id, title, tools, guidance, keywords) {
  return Object.freeze({ id, title, tools: Object.freeze(tools), guidance, keywords: Object.freeze(keywords) });
}

function scoreRoute(definition, task, availableNames, scoreByTool, options, fallbackScore = 0) {
  const tools = definition.tools.filter((tool) => availableNames.has(tool));
  if (!tools.length) return null;
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

function dynamicBoost(id, task, options) {
  const lower = String(task || "").toLowerCase();
  const reasons = [];
  let score = 0;
  const add = (amount, reason) => { score += amount; reasons.push(reason); };
  if (id === "guided-workflow" && options.skillRelevant === true) add(18, "relevant_skill_found");
  if (id === "registered-command" && options.commandRelevant === true) add(20, "relevant_registered_command_found");
  if (id === "application" && Array.isArray(options.applicationMatches) && options.applicationMatches.length > 0) add(20, "installed_application_match");
  if (id === "browser" && options.browserAvailable === true && /browser|chrome|edge|brave|网页|浏览器|表单|网站|登录/.test(lower)) add(14, "browser_intent");
  if (id === "managed-job" && /background|detached|durable|long[- ]?running|resume|cleanup|finally|overnight|continuous|后台|持久|断线|清理|长时间|持续|重试|多步骤/.test(lower)) add(14, "durability_or_cleanup_intent");
  if (id === "process-session" && /interactive|stdin|repl|watch|tail|stream|dev server|交互|实时日志|输入|常驻进程/.test(lower)) add(12, "interactive_process_intent");
  if (id === "shell" && /bash|shell|terminal|cli|command|script|debug|diagnos|benchmark|audit|probe|命令|终端|脚本|排查|调试|基准|审查|测试|构建/.test(lower)) add(10, "shell_or_cli_intent");
  if (id === "workspace-edit" && /file|source|code|edit|write|patch|refactor|repository|文件|源码|代码|修改|写入|补丁|重构|仓库/.test(lower)) add(10, "workspace_change_intent");
  if (id === "git-review" && /git|commit|diff|branch|history|revision|提交|分支|差异|历史|版本/.test(lower)) add(12, "git_intent");
  if (id === "protected-resource" && /credential|secret|token|private key|ssh key|password|凭据|密钥|令牌|密码/.test(lower)) add(14, "protected_data_intent");
  if (id === "diagnostics" && /status|health|diagnos|runtime|relay|policy|authorization|状态|健康|诊断|运行时|权限|连接/.test(lower)) add(10, "runtime_diagnostic_intent");
  return { score, reasons };
}

function publicRoute(routeValue, availableRouteIds) {
  return {
    id: routeValue.id,
    title: routeValue.title,
    score: routeValue.score,
    tools: [...routeValue.tools],
    guidance: routeValue.guidance,
    reasons: [...routeValue.reasons],
    fallback_routes: (ROUTE_FALLBACKS[routeValue.id] || []).filter((id) => availableRouteIds.has(id)),
  };
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}
