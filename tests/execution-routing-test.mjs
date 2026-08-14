import catalog from "../src/shared/tool-catalog.json" with { type: "json" };
import { accountRoleToolNames } from "../src/local/account-access.mjs";
import { buildExecutionRouting } from "../src/local/execution-routing.mjs";
import { policyProfile } from "../src/local/policy.mjs";

const shell = buildExecutionRouting("Use bash to inspect the repository, run tests, and debug the failing CLI", {
  policy: policyProfile("full"),
});
assert(shell.schema_version === 1 && shell.score_semantics.includes("not probabilities"),
  "routing output omitted its stable schema or relative-score semantics");
assert(shell.primary_route?.id === "shell", "direct shell was not retained as the primary route for explicit Bash work");
assert(shell.recommended_tools.includes("exec_command") && shell.recommended_tools.includes("run_process"),
  "shell route omitted the convenient Bash or direct-argv surfaces");
assert(shell.routes.some((route) => route.id === "workspace-edit"), "set-level routing omitted the supporting workspace tool set");
assert(shell.primary_route?.fallback_routes?.includes("process-session"), "shell route omitted its interactive-process fallback");

const durable = buildExecutionRouting("Run a long background multi-step migration that must survive disconnects and always clean up", {
  policy: policyProfile("full"),
});
assert(durable.primary_route?.id === "managed-job", "durable multi-step work did not prefer the managed-job route");
assert(durable.routes.some((route) => route.id === "shell"), "durable routing incorrectly removed the shell escape hatch");
assert(durable.recommended_tools.includes("start_job") && durable.recommended_tools.includes("exec_command"),
  "durable routing did not expose both the safe primary route and shell alternative");

const operatorDurable = buildExecutionRouting("Run a long background multi-step migration that must survive disconnects and always clean up", {
  policy: policyProfile("agent"),
  availableTools: accountRoleToolNames("operator"),
});
assert(operatorDurable.primary_route?.id !== "managed-job"
  && operatorDurable.routes.every((route) => route.id !== "managed-job" && !route.fallback_routes.includes("managed-job"))
  && !operatorDurable.recommended_tools.includes("start_job")
  && !operatorDurable.recommended_tools.includes("stage_job"),
"routing recommended an unsatisfiable managed-job creation path to a non-owner account");
assert(operatorDurable.effective_tool_count < operatorDurable.policy_effective_tool_count,
  "routing collapsed account-effective authority and the broader effective-policy tool count into one number");
const operatorExistingJob = buildExecutionRouting("Inspect and cancel my existing managed job", {
  policy: policyProfile("agent"),
  availableTools: accountRoleToolNames("operator"),
});
assert(operatorExistingJob.routes.some((route) => route.id === "managed-job"
  && route.tools.includes("read_job") && route.tools.includes("cancel_job")
  && !route.tools.includes("start_job")),
"owner-only creation filtering removed legitimate existing-job control tools from the managed-job route");

const registered = buildExecutionRouting("Run the repository verification command", {
  policy: policyProfile("full"),
  commandRelevant: true,
});
assert(registered.primary_route?.id === "registered-command", "a relevant registered command did not outrank ad hoc execution");
assert(registered.recommended_tools.includes("run_local_command"), "registered-command routing omitted run_local_command");
const noisySeed = buildExecutionRouting("Run the repository verification command", {
  policy: policyProfile("full"),
  commandRelevant: true,
  seedTools: catalog.map((tool) => tool.name).reverse(),
});
assert(noisySeed.recommended_tools[0] === "run_local_command",
  "legacy recommendation seeds displaced the primary route from the bounded tool shortlist");

const application = buildExecutionRouting("Use Notes to update the document", {
  policy: policyProfile("full"),
  applicationMatches: [{ name: "Notes", score: 15 }],
});
assert(application.primary_route?.id === "application", "an exact installed-application match did not select structured application automation");
assert(application.routes.some((route) => route.id === "shell"), "application routing removed the general shell alternative");

const review = buildExecutionRouting("Use bash and the browser to modify files", {
  policy: policyProfile("review"),
  browserAvailable: false,
});
const reviewTools = new Set(review.recommended_tools);
assert(!reviewTools.has("exec_command") && !reviewTools.has("browser_action") && !reviewTools.has("write_file") && !reviewTools.has("git_commit"),
  "advisory routing recommended tools outside the effective review policy");
assert(review.routes.every((route) => route.tools.every((tool) => !["exec_command", "browser_action", "write_file", "git_commit"].includes(tool))),
  "route bundles leaked tools outside the effective policy");
const editorCommit = buildExecutionRouting("Commit the staged Git changes", {
  policy: policyProfile("edit"),
});
assert(!editorCommit.recommended_tools.includes("git_commit")
  && editorCommit.routes.every((route) => !route.tools.includes("git_commit")),
"edit-only policy exposed non-idempotent Git history mutation");
const operatorCommit = buildExecutionRouting("Commit the staged Git changes", {
  policy: policyProfile("agent"),
});
assert(operatorCommit.recommended_tools.includes("git_commit"),
  "direct-exec policy lost the bounded Git commit surface");

const commit = buildExecutionRouting("Commit the staged Git changes with a Conventional Commit message", {
  policy: policyProfile("full"),
});
const commitRoute = commit.routes.find((route) => route.id === "git-review");
assert(commitRoute?.tools.includes("git_commit") && commit.recommended_tools.includes("git_commit"),
  "Git commit intent did not expose the bounded structured commit surface");
assert(commitRoute.guidance.includes("prefer git_commit"), "Git route no longer prefers the narrow commit surface over generic process execution");

const regressionCases = [
  { task: "Inspect the Git diff and recent commit history", primary: "git-review" },
  { task: "Edit the source files and apply a precise patch", primary: "workspace-edit" },
  { task: "Start an interactive REPL and stream its output", primary: "process-session" },
  { task: "Check relay health, runtime status, and authorization", primary: "diagnostics" },
  { task: "Use a registered SSH private key without exposing the credential", primary: "protected-resource" },
  { task: "在浏览器中填写登录后的复杂表单", primary: "browser", options: { browserAvailable: true } },
  { task: "使用 bash 脚本排查构建失败", primary: "shell" },
  { task: "后台运行长时间多步骤任务，断线后继续并确保清理", primary: "managed-job" },
  { task: "启动交互式服务并持续读取实时日志", primary: "process-session" },
  { task: "检查 Git 分支、提交历史与代码差异", primary: "git-review" },
  { task: "修改源码文件并重构实现", primary: "workspace-edit" },
  { task: "诊断本地运行时与远程连接状态", primary: "diagnostics" },
];
for (const testCase of regressionCases) {
  const routed = buildExecutionRouting(testCase.task, {
    policy: policyProfile("full"),
    ...(testCase.options || {}),
  });
  assert(routed.primary_route?.id === testCase.primary,
    `routing regression for ${testCase.primary}: received ${routed.primary_route?.id || "none"}`);
}

const ambiguous = buildExecutionRouting("Inspect and debug the Git repository", {
  policy: policyProfile("full"),
});
assert(["low", "medium", "high"].includes(ambiguous.ambiguity.level), "routing ambiguity was not classified");
assert(ambiguous.ranked_tools.length <= 12 && ambiguous.recommended_tools.length <= 18,
  "routing output exceeded its bounded context budget");
assert(ambiguous.recovery_guidance.some((item) => item.includes("ambiguous mutation")),
  "routing result omitted failure-aware recovery guidance");
assert(ambiguous.enforcement.startsWith("advisory_only") && ambiguous.enforcement.includes("effective authority")
  && !ambiguous.enforcement.includes("effective policy"),
"routing result did not state its account-attenuated non-enforcement boundary");

const descriptions = new Map(catalog.map((tool) => [tool.name, tool.description]));
assert(descriptions.get("exec_command")?.includes("pipelines") && descriptions.get("exec_command")?.includes("general escape hatch"),
  "exec_command description lost the positive Bash selection boundary");
assert(descriptions.get("run_process")?.includes("explicit executable plus argv") && descriptions.get("run_process")?.includes("no shell syntax"),
  "run_process description no longer distinguishes direct argv from Bash composition");
assert(descriptions.get("run_local_command")?.includes("repository already defines") && descriptions.get("run_local_command")?.includes("registered command"),
  "run_local_command description no longer distinguishes repeatable project commands");
assert(descriptions.get("browser_get_source")?.includes("raw serialized DOM HTML")
  && descriptions.get("browser_inspect_page")?.includes("semantic/actionability snapshot"),
"browser source and semantic-inspection descriptions collided");
assert(descriptions.get("resolve_task_capabilities")?.includes("set-level execution routes")
  && descriptions.get("agent_context")?.includes("Use this when the caller needs the context itself"),
"task routing and context inventory descriptions no longer communicate distinct purposes");

console.log("execution routing test ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
