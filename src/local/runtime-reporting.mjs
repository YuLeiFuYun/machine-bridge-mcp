import { basename } from "node:path";
import {
  allToolNames, isCanonicalFullPolicy, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS,
  POLICY_PROFILES, SERVER_NAME,
} from "./tools.mjs";
import { executionGuardrailsSnapshot } from "./execution-limits.mjs";

const MAX_PROJECT_OVERVIEW_TOP_LEVEL_ENTRIES = 40;

export function buildRuntimeInfo({
  workspace,
  displayPath,
  policy,
  toolNames,
  capabilityObserver,
  observability,
  callRegistry,
  lifecycle,
  relayStatus,
  runtimeDir,
  processTracker,
  processSessionManager,
  managedJobManager,
}) {
  return {
    name: SERVER_NAME,
    protocol_version: MCP_PROTOCOL_VERSION,
    supported_protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    workspace: displayPath(workspace),
    workspace_name: policy.exposeAbsolutePaths ? basename(workspace) : "workspace",
    policy,
    policy_contract: {
      named_profile_is_canonical: policy.profile === "custom" || policyMatchesNamedProfile(policy),
      full_catalog_complete: policy.profile === "full"
        ? isCanonicalFullPolicy(policy) && toolNames.length + 1 === allToolNames().length
        : null,
      machine_bridge_internal_denials_under_full: policy.profile === "full" && isCanonicalFullPolicy(policy) ? false : null,
    },
    enforcement: {
      filesystem_scope: policy.unrestrictedPaths ? "local-user-accessible" : "workspace",
      sensitive_filename_filter: false,
      operating_system_permissions_apply: true,
      host_policy_is_independent: true,
    },
    tool_delivery: {
      full_profile_scope: "local-daemon-and-relay-advertisement",
      daemon_advertised_tool_count: toolNames.length + 1,
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
    },
    tools: ["server_info", ...toolNames],
    observability: {
      relay_readiness: "end-to-end-relay-probe-verified",
      brief_relay_interruptions: "debug-only",
      raw_transport_details: "debug-only",
      per_tool_events: "structured-debug-events",
      default_logs_include_tool_failures: false,
      tool_arguments_or_results_logged: false,
      capability_routing: capabilityObserver.snapshot(),
      tool_calls: observability.snapshot(),
      in_flight_calls: callRegistry.snapshot(),
    },
    runtime: {
      environment: policy.minimalEnv ? "isolated-minimal" : "full-parent",
      lifecycle: lifecycle.snapshot(),
      relay: relayStatus(),
      runtime_dir: policy.exposeAbsolutePaths ? runtimeDir : "<private-runtime-dir>",
      processes: processTracker.snapshot(),
      execution_guardrails: executionGuardrailsSnapshot(),
      process_sessions: processSessionManager.status(),
      managed_jobs: managedJobManager.status(),
      local_resources: managedJobManager.resourceInfo(),
    },
  };
}

export async function buildProjectOverview({
  workspace,
  displayPath,
  policy,
  toolNames,
  daemonPolicy = policy,
  daemonToolNames = toolNames,
  capabilityObserver,
  listTopLevel,
  runInternalProcess,
  gitExecutable,
  safeErrorMessage,
  throwIfCancelled,
}, context = {}) {
  throwIfCancelled(context);
  const topPromise = listTopLevel(context).catch((error) => ({ error: safeErrorMessage(error), entries: [] }));
  const gitPromise = runInternalProcess(
    gitExecutable(),
    ["-c", "core.fsmonitor=false", "-C", workspace, "rev-parse", "--show-toplevel"],
    10_000,
    true,
    512 * 1024,
    context,
  );
  const [top, git] = await Promise.all([topPromise, gitPromise]);
  const topEntries = Array.isArray(top.entries) ? top.entries : [];
  const topLevel = topEntries.slice(0, MAX_PROJECT_OVERVIEW_TOP_LEVEL_ENTRIES);
  return {
    workspace: displayPath(workspace),
    workspaceName: policy.exposeAbsolutePaths ? basename(workspace) : "workspace",
    gitRoot: git.code === 0 ? displayPath(git.stdout.trim()) : "",
    policy,
    tools: ["server_info", ...toolNames],
    daemonPolicy,
    daemonTools: ["server_info", ...daemonToolNames],
    capabilityRouting: capabilityObserver.snapshot(),
    topLevel,
    topLevelTotal: topEntries.length,
    topLevelTruncated: Boolean(top.truncated || topEntries.length > topLevel.length),
  };
}

function policyMatchesNamedProfile(policy) {
  if (!Object.hasOwn(POLICY_PROFILES, policy.profile)) return false;
  const named = POLICY_PROFILES[policy.profile];
  return policy.allowWrite === named.allowWrite
    && policy.execMode === named.execMode
    && policy.unrestrictedPaths === named.unrestrictedPaths
    && policy.minimalEnv === named.minimalEnv
    && policy.exposeAbsolutePaths === named.exposeAbsolutePaths;
}
