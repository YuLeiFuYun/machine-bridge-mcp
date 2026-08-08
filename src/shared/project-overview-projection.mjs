// @ts-check

export function projectOverviewDetail(args = {}) {
  return args?.detail === "summary" ? "summary" : "full";
}

export function projectProjectOverview(value, detail = "full") {
  if (detail !== "summary" || !isRecord(value)) return value;
  const authorization = record(value.authorization);
  const summary = /** @type {Record<string, unknown>} */ ({
    detail: "summary",
    workspace: value.workspace ?? null,
    workspaceName: value.workspaceName ?? null,
    gitRoot: value.gitRoot ?? "",
    policy: value.policy ?? null,
    effectiveToolCount: numberOrLength(authorization.effective_tool_count, value.tools),
    daemonPolicy: value.daemonPolicy ?? null,
    daemonToolCount: arrayLength(value.daemonTools),
    capabilityRouting: compactCapabilityRouting(value.capabilityRouting),
    topLevel: compactTopLevel(value.topLevel),
    topLevelTotal: numberOr(value.topLevelTotal, 0),
    topLevelTruncated: value.topLevelTruncated === true,
  });
  if (typeof value.policyScope === "string") summary.policyScope = value.policyScope;
  if (typeof value.toolsScope === "string") summary.toolsScope = value.toolsScope;
  if (Object.keys(authorization).length) summary.authorization = compactAuthorization(authorization);
  return summary;
}

function compactAuthorization(value) {
  const account = record(value.account);
  const execution = record(value.execution_model);
  return {
    account: Object.keys(account).length ? { role: account.role ?? null, version: account.version ?? null } : null,
    effective_policy: value.effective_policy ?? null,
    effective_tool_count: numberOr(value.effective_tool_count, 0),
    account_role_is_owner: value.account_role_is_owner === true,
    effective_profile_is_full: value.effective_profile_is_full === true,
    execution_model: Object.keys(execution).length ? {
      within_effective_authority: execution.within_effective_authority ?? null,
      owner_ambient_authority: execution.owner_ambient_authority ?? null,
    } : null,
  };
}

function compactCapabilityRouting(value) {
  const source = record(value);
  const last = record(source.last_task_resolution);
  return {
    bootstrap_observed: source.bootstrap_observed === true,
    bootstrap_count: numberOr(source.bootstrap_count, 0),
    task_resolution_observed: source.task_resolution_observed === true,
    task_resolution_count: numberOr(source.task_resolution_count, 0),
    last_task_resolution: Object.keys(last).length ? {
      observed_at: last.observed_at ?? null,
      selected_skill: last.selected_skill ?? null,
      matched_skills: numberOr(last.matched_skills, 0),
      matched_commands: numberOr(last.matched_commands, 0),
      matched_applications: numberOr(last.matched_applications, 0),
      recommended_tool_count: arrayLength(last.recommended_tools),
      primary_route: last.primary_route ?? null,
      routing_ambiguity: last.routing_ambiguity ?? "none",
      routing_score_gap: numberOr(last.routing_score_gap, 0),
    } : null,
  };
}

function compactTopLevel(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const entry = record(item);
    return { name: entry.name ?? "", type: entry.type ?? "other" };
  });
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function numberOrLength(value, array) {
  return Number.isFinite(Number(value)) ? Number(value) : arrayLength(array);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value) {
  return isRecord(value) ? value : {};
}
