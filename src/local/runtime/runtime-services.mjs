import { basename, resolve } from "node:path";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { allToolNames, isCanonicalFullPolicy, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, POLICY_PROFILES, SERVER_NAME } from "./observability.mjs";
import { executionGuardrailsSnapshot } from "../process/execution-limits.mjs";
import { hiddenGlobalActivity, hiddenInFlightActivity, publicDeviceRootStatus, publicSecurityAudit, runtimeActivityVisible, stateRootFromProfileStatePath } from "./runtime-projections.mjs";
import { inspectResourceFile } from "../jobs/plan.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { expandHome } from "../state/state.mjs";
import { clampInteger } from "../../shared/numbers.mjs";
import { settleManagedJobAcceptance } from "./call-helpers.mjs";
import { waitForManagedJobRead } from "../jobs/projection.mjs";

const MAX_PROJECT_OVERVIEW_TOP_LEVEL_ENTRIES = 40;

export function buildRuntimeInfo({
  workspace,
  displayPath,
  policy,
  toolNames,
  daemonToolNames = toolNames,
  capabilityObserver,
  observability,
  callRegistry,
  lifecycle,
  relayStatus,
  runtimeDir,
  processTracker,
  processSessionManager,
  managedJobManager,
  securityAudit = null,
  deviceRootStatus = null,
  context = {},
  clientToolSchemaGeneration = null,
}) {
  const globalActivityVisible = runtimeActivityVisible(context);
  const inFlightCalls = callRegistry.snapshot();
  const effectiveSet = new Set(toolNames);
  const omittedTools = daemonToolNames.filter((name) => !effectiveSet.has(name));
  const authorityDelta = {
    daemon_tool_count: daemonToolNames.length + 1,
    effective_tool_count: toolNames.length + 1,
    omitted_count: omittedTools.length,
    ...(globalActivityVisible
      ? { omitted_sample: omittedTools.slice(0, 16) }
      : { omitted_sample_hidden_by_authority: omittedTools.length > 0 }),
  };
  const serverGeneration = Number(serverMetadata.toolSchemaGeneration);
  const schemaDrift = Number.isSafeInteger(clientToolSchemaGeneration) && clientToolSchemaGeneration >= 1
    ? {
      client_generation: clientToolSchemaGeneration,
      server_generation: serverGeneration,
      drifted: clientToolSchemaGeneration !== serverGeneration,
    }
    : null;
  return {
    name: SERVER_NAME,
    protocol_version: MCP_PROTOCOL_VERSION,
    supported_protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    workspace: displayPath(workspace),
    workspace_name: policy.exposeAbsolutePaths ? basename(workspace) : "workspace",
    policy,
    authority_delta: authorityDelta,
    ...(schemaDrift ? { schema_drift: schemaDrift } : {}),
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
      effective_tool_count: toolNames.length + 1,
      daemon_advertised_tool_count: daemonToolNames.length + 1,
      tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
      discovery_ttl_ms: 0,
      tool_list_ttl_ms: 0,
      host_turn_deadline_observable: false,
      managed_jobs_detached_from_mcp_response: true,
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
      capability_routing: globalActivityVisible ? capabilityObserver.snapshot() : hiddenGlobalActivity(),
      tool_calls: globalActivityVisible ? observability.snapshot() : hiddenGlobalActivity(),
      in_flight_calls: globalActivityVisible ? inFlightCalls : hiddenInFlightActivity(inFlightCalls),
    },
    runtime: {
      environment: policy.minimalEnv ? "isolated-minimal" : "full-parent",
      lifecycle: lifecycle.snapshot(),
      relay: relayStatus(),
      runtime_dir: policy.exposeAbsolutePaths ? runtimeDir : "<private-runtime-dir>",
      processes: globalActivityVisible ? processTracker.snapshot() : hiddenGlobalActivity(),
      execution_guardrails: executionGuardrailsSnapshot(),
      process_sessions: processSessionManager.status(context),
      managed_jobs: managedJobManager.status(context),
      local_resources: managedJobManager.resourceInfo(context),
    },
    ...(securityAudit ? { security_audit: publicSecurityAudit(securityAudit, globalActivityVisible) } : {}),
    trust: { device_root: publicDeviceRootStatus(deviceRootStatus, globalActivityVisible) },
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
  resolveGitRoot,
  safeErrorMessage,
  throwIfCancelled,
}, context = {}) {
  throwIfCancelled(context);
  const topPromise = listTopLevel(context).catch((error) => ({ error: safeErrorMessage(error), entries: [] }));
  const gitPromise = resolveGitRoot(context);
  const [top, gitRoot] = await Promise.all([topPromise, gitPromise]);
  const topEntries = Array.isArray(top.entries) ? top.entries : [];
  const topLevel = topEntries.slice(0, MAX_PROJECT_OVERVIEW_TOP_LEVEL_ENTRIES);
  return {
    workspace: displayPath(workspace),
    workspaceName: policy.exposeAbsolutePaths ? basename(workspace) : "workspace",
    gitRoot: gitRoot ? displayPath(gitRoot) : "",
    policy,
    tools: ["server_info", ...toolNames],
    daemonPolicy,
    daemonTools: ["server_info", ...daemonToolNames],
    capabilityRouting: runtimeActivityVisible(context) ? capabilityObserver.snapshot() : hiddenGlobalActivity(),
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
const MAX_BROWSER_RESOURCE_BYTES = 1024 * 1024;

export class RuntimeResourceService {
  constructor({ workspace, resourceStatePath = "", currentResources, authorizeTool }) {
    this.workspace = resolve(workspace);
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.currentResources = currentResources;
    this.authorizeTool = authorizeTool;
  }

  readBinary(name) {
    const registry = this.currentResources();
    const resource = Object.hasOwn(registry, name) ? registry[name] : null;
    if (!resource) throw new Error(`unknown local resource: ${name}`);
    const inspected = inspectResourceFile(resource.path, {
      allowInsecurePermissions: resource.allowInsecurePermissions === true,
      includeContent: true,
    });
    if (inspected.size > MAX_BROWSER_RESOURCE_BYTES) {
      throw new Error("local resource exceeds 1 MiB browser injection limit");
    }
    return {
      buffer: inspected.content,
      path: inspected.path,
      size: inspected.size,
    };
  }

  readText(name) {
    const { buffer } = this.readBinary(name);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`local resource is not valid UTF-8 text: ${name}`);
    }
  }

  async generateSshKey(args = {}) {
    this.authorizeTool("generate_ssh_key_resource");
    if (!this.resourceStatePath) throw new Error("local resource state is unavailable in this runtime");
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw new Error("HOME or USERPROFILE is required to choose a default SSH key path");
    const target = args.path
      ? resolve(expandHome(String(args.path)))
      : resolve(home, ".ssh", `machine-mcp-${args.name}-ed25519`);
    const key = await generateRegisteredSshKey({
      workspace: this.workspace,
      stateDir: stateRootFromProfileStatePath(this.resourceStatePath),
      name: args.name,
      targetPath: target,
      comment: args.comment || `machine-mcp:${args.name}`,
    });
    const exposePaths = args.expose_paths === true;
    return {
      name: key.name,
      created: key.created,
      registered: key.registered,
      fingerprint: key.fingerprint,
      key_type: key.keyType,
      private_mode: key.privateMode,
      public_mode: key.publicMode,
      private_key_content_exposed: key.privateKeyContentExposed,
      available_to_new_jobs_immediately: key.availableToNewJobsImmediately,
      paths_exposed: exposePaths,
      ...(exposePaths ? {
        private_key_path: resolve(key.privateKeyPath),
        public_key_path: resolve(key.publicKeyPath),
      } : {}),
    };
  }
}
const RUNTIME_TOOL_HANDLERS = Object.freeze({
  server_info: (runtime, args, context) => runtime.serverInfo(args, context),
  project_overview: (runtime, args, context) => runtime.projectOverview(args, context),
  session_bootstrap: (runtime, args, context) => runtime.sessionBootstrap(args, context),
  agent_context: (runtime, args, context) => runtime.agentContextManager.agentContext(args, context),
  resolve_task_capabilities: (runtime, args, context) => runtime.resolveTaskCapabilities(args, context),
  list_local_skills: (runtime, args, context) => runtime.agentContextManager.listLocalSkills(args, context),
  load_local_skill: (runtime, args, context) => runtime.agentContextManager.loadLocalSkill(args, context),
  list_local_commands: (runtime, args, context) => runtime.agentContextManager.listLocalCommands(args, context),
  run_local_command: (runtime, args, context) => runtime.runLocalCommand(args, context),
  list_local_applications: (runtime, args, context) => runtime.appAutomationManager.listApplications(args, context),
  open_local_application: (runtime, args, context) => runtime.appAutomationManager.openApplication(args, context),
  inspect_local_application: (runtime, args, context) => runtime.appAutomationManager.inspectApplication(args, context),
  operate_local_application: (runtime, args, context) => runtime.appAutomationManager.operateApplication(args, context),
  computer_observe: (runtime, args, context) => runtime.computerUseManager.observe(args, context),
  computer_act: (runtime, args, context) => runtime.computerUseManager.act(args, context),
  browser_status: (runtime, _args, context) => runtime.browserBridgeManager.status(context),
  pair_browser_extension: (runtime, args, context) => runtime.browserBridgeManager.pair(args, context),
  browser_list_tabs: (runtime, args, context) => runtime.browserBridgeManager.listTabs(args, context),
  browser_manage_tabs: (runtime, args, context) => runtime.browserBridgeManager.manageTabs(args, context),
  browser_wait: (runtime, args, context) => runtime.browserBridgeManager.wait(args, context),
  browser_get_source: (runtime, args, context) => runtime.browserBridgeManager.getSource(args, context),
  browser_inspect_page: (runtime, args, context) => runtime.browserBridgeManager.inspectPage(args, context),
  browser_action: (runtime, args, context) => runtime.browserBridgeManager.act(args, context),
  browser_fill_form: (runtime, args, context) => runtime.browserBridgeManager.fillForm(args, context),
  browser_screenshot: (runtime, args, context) => runtime.browserBridgeManager.screenshot(args, context),
  browser_upload_files: (runtime, args, context) => runtime.browserBridgeManager.uploadFiles(args, context),
  browser_network_log: (runtime, args, context) => runtime.browserBridgeManager.networkLog(args, context),
  list_roots: (runtime, _args, context) => runtime.listRoots(context),
  list_dir: (runtime, args, context) => runtime.listDir(args.path || ".", context),
  list_files: (runtime, args, context) => runtime.listFiles(args.path || ".", clampInteger(args.max_files, 1000, 1, 10000), context, { includeIgnored: args.include_ignored === true }),
  read_file: (runtime, args, context) => runtime.readFile(args, context),
  view_image: (runtime, args, context) => runtime.viewImage(args, context),
  write_file: (runtime, args, context) => runtime.writeFile(args, context),
  edit_file: (runtime, args, context) => runtime.editFile(args, context),
  apply_patch: (runtime, args, context) => runtime.applyPatch(args, context),
  search_text: (runtime, args, context) => runtime.searchText(args, context),
  git_status: (runtime, args, context) => runtime.gitStatus(args, context),
  git_diff: (runtime, args, context) => runtime.gitDiff(args, context),
  git_log: (runtime, args, context) => runtime.gitLog(args, context),
  git_show: (runtime, args, context) => runtime.gitShow(args, context),
  git_commit: (runtime, args, context) => runtime.gitCommit(args, context),
  diagnose_runtime: (runtime, _args, context) => runtime.diagnoseRuntime(context),
  list_local_resources: (runtime, _args, context) => runtime.managedJobManager.listResources(context),
  generate_ssh_key_resource: (runtime, args, context) => runtime.generateSshKeyResource(args, context),
  stage_job: (runtime, args, context) => runtime.managedJobManager.stage(args, context),
  start_job: (runtime, args, context) => settleManagedJobAcceptance(
    runtime.managedJobManager, runtime.managedJobManager.start(args, context), context,
  ),
  list_jobs: (runtime, args, context) => runtime.managedJobManager.list(args, context),
  read_job: (runtime, args, context) => waitForManagedJobRead({
    args, context,
    readCurrent: () => context?.authority?.origin === "relay"
      ? runtime.managedJobManager.readHosted(args, context)
      : runtime.managedJobManager.read(args, context),
    readProgress: () => runtime.managedJobManager.readProgress(args, context),
    throwIfCancelled: () => runtime.throwIfCancelled(context),
  }),
  cancel_job: (runtime, args, context) => runtime.managedJobManager.cancel(args, context),
  run_process: (runtime, args, context) => runtime.runDirectProcess(args, context),
  start_process: (runtime, args, context) => runtime.processSessionManager.start(args, context),
  read_process: (runtime, args, context) => runtime.processSessionManager.read(args, context),
  write_process: (runtime, args, context) => runtime.processSessionManager.write(args, context),
  kill_process: (runtime, args, context) => runtime.processSessionManager.kill(args, context),
  exec_command: (runtime, args, context) => runtime.execCommand(args, context),
});

export function runtimeToolHandlerNames() {
  return Object.keys(RUNTIME_TOOL_HANDLERS);
}

export function bindRuntimeToolHandlers(runtime) {
  return Object.fromEntries(Object.entries(RUNTIME_TOOL_HANDLERS).map(([name, handler]) => [
    name,
    (args, context) => handler(runtime, args, context),
  ]));
}
