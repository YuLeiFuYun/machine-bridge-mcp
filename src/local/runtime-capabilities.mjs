import { classifyOperationalError } from "./log.mjs";
import { buildExecutionRouting } from "./execution-routing.mjs";
import { policyAllowsTool } from "./policy.mjs";
const APPLICATION_TOOLS = ["list_local_applications", "open_local_application", "inspect_local_application", "operate_local_application"];
export async function sessionBootstrap({
  agentContextManager,
  appAutomationManager,
  capabilityObserver,
  policy,
  availableTools = null,
}, args = {}, context = {}) {
  const bootstrap = await agentContextManager.sessionBootstrap(args, context);
  const availableNames = availableToolSet(availableTools);
  const applicationAllowed = availableNames ? availableNames.has("list_local_applications") : policyAllowsTool(policy, "list_local_applications");
  const browserAllowed = availableNames ? availableNames.has("browser_status") : policyAllowsTool(policy, "browser_status");
  bootstrap.local_automation = {
    applications: applicationAllowed ? appAutomationManager.capabilities() : null,
    browser: browserAllowed ? {
      existing_profile: true,
      extension_bridge: true,
      status_tool: "browser_status",
    } : null,
  };
  capabilityObserver.recordBootstrap(bootstrap);
  return bootstrap;
}

export async function resolveTaskCapabilities({
  agentContextManager,
  appAutomationManager,
  capabilityObserver,
  policy,
  availableTools = null,
}, args = {}, context = {}) {
  const result = await agentContextManager.resolveTaskCapabilities(args, context);
  const task = String(args.task || "");
  const availableNames = availableToolSet(availableTools);
  const applicationAllowed = availableNames ? availableNames.has("list_local_applications") : policyAllowsTool(policy, "list_local_applications");
  const browserAllowed = availableNames ? availableNames.has("browser_status") : policyAllowsTool(policy, "browser_status");
  if (applicationAllowed) {
    let applications;
    try {
      applications = await appAutomationManager.listApplications({ query: "", max_results: 500 }, context);
    } catch (error) {
      applications = { applications: [], warnings: [{ error_class: classifyOperationalError(error) }], truncated: false };
    }
    result.application_discovery = {
      available: !(applications.warnings?.length),
      warning_count: applications.warnings?.length ?? 0,
      truncated: applications.truncated === true,
      ...(applications.warnings?.[0]?.error_class ? { error_class: applications.warnings[0].error_class } : {}),
    };
    const lower = task.toLowerCase();
    result.application_matches = applications.applications
      .map((application) => ({ application, score: applicationMatchScore(lower, application) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.application.name.localeCompare(right.application.name))
      .slice(0, 20)
      .map(({ application, score }) => ({ ...application, score }));
  } else {
    result.application_matches = [];
    result.application_discovery = {
      available: false, warning_count: 0, truncated: false,
      reason: availableNames ? "effective_authority" : "effective_policy",
    };
  }
  if (result.application_matches.length) {
    const applicationTools = APPLICATION_TOOLS.filter((tool) => !availableNames || availableNames.has(tool));
    result.recommended_tools = [...new Set([...result.recommended_tools, ...applicationTools])];
  }
  result.browser_backend = browserAllowed
    ? { tool: "browser_status", existing_profile: true, extension_bridge: true }
    : null;
  const routing = buildExecutionRouting(task, {
    policy,
    availableTools,
    seedTools: result.recommended_tools,
    commandRelevant: (result.command_matches?.[0]?.score || 0) >= 3,
    skillRelevant: (result.skill_matches?.[0]?.score || 0) >= 3,
    applicationMatches: result.application_matches,
    browserAvailable: browserAllowed,
  });
  result.execution_routing = routing;
  result.recommended_tools = routing.recommended_tools;
  result.routing_observability = "Call server_info or project_overview to verify that bootstrap and task capability resolution reached the local runtime. Routing is advisory and cannot expand the effective authority; direct shell is available only when that authority exposes it.";
  capabilityObserver.recordResolution(task, result);
  return result;
}

function availableToolSet(value) { if (value === null || value === undefined) return null; if (!Array.isArray(value) && !(value instanceof Set)) throw new TypeError("availableTools must be an array or set"); return new Set([...value].map((tool) => String(tool || "")).filter(Boolean)); }

function applicationMatchScore(task, application) {
  const name = String(application.name || "").toLowerCase();
  const id = String(application.id || "").toLowerCase();
  if (!name) return 0;
  if (task.includes(name)) return 10 + Math.min(name.length, 20);
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  return words.reduce((score, word) => score + (task.includes(word) ? 2 : 0), id && task.includes(id) ? 5 : 0);
}
