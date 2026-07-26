import { classifyOperationalError } from "./log.mjs";

export async function sessionBootstrap({
  agentContextManager,
  appAutomationManager,
  capabilityObserver,
  policy,
}, args = {}, context = {}) {
  const bootstrap = await agentContextManager.sessionBootstrap(args, context);
  bootstrap.local_automation = {
    applications: appAutomationManager.capabilities(),
    browser: policy.profile === "full" ? {
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
}, args = {}, context = {}) {
  const result = await agentContextManager.resolveTaskCapabilities(args, context);
  const task = String(args.task || "");
  if (policy.profile === "full") {
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
    result.application_discovery = { available: false, warning_count: 0, truncated: false, reason: "policy" };
  }
  if (result.application_matches.length) {
    result.recommended_tools = [...new Set([
      ...result.recommended_tools,
      "list_local_applications",
      "open_local_application",
      "inspect_local_application",
      "operate_local_application",
    ])];
  }
  result.browser_backend = policy.profile === "full"
    ? { tool: "browser_status", existing_profile: true, extension_bridge: true }
    : null;
  result.routing_observability = "Call server_info or project_overview to verify that bootstrap and task capability resolution reached the local runtime.";
  capabilityObserver.recordResolution(task, result);
  return result;
}

function applicationMatchScore(task, application) {
  const name = String(application.name || "").toLowerCase();
  const id = String(application.id || "").toLowerCase();
  if (!name) return 0;
  if (task.includes(name)) return 10 + Math.min(name.length, 20);
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  return words.reduce((score, word) => score + (task.includes(word) ? 2 : 0), id && task.includes(id) ? 5 : 0);
}
