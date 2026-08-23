import { createLogger } from "./log.mjs";

export function printStartJson(state, { requestedChangesApplied = true, notice = "", initialOwner = null } = {}) {
  createLogger({ component: "ready" }).rawJson({
    mcp: {
      server_url: state.worker.mcpServerUrl,
      worker_url: state.worker.url,
      worker_name: state.worker.name,
    },
    ...(initialOwner ? { initial_owner: initialOwner } : {}),
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
    requested_changes_applied: requestedChangesApplied,
    ...(notice ? { notice } : {}),
  });
}

export function printMcpConnection(state, { quiet = false, verbose = false, initialOwner = null, logger: readyLogger = null } = {}) {
  const output = readyLogger || createLogger({ component: "ready", quiet, level: quiet ? "error" : verbose ? "debug" : "info" });
  if (output.format === "json" && !initialOwner) {
    output.event("success", "daemon.ready", {
      mcp_server_url: state.worker.mcpServerUrl,
      worker_name: state.worker.name,
      workspace_path: state.workspace.path,
      policy_profile: state.policy.profile,
      policy_origin: state.policy.origin,
      write_enabled: state.policy.allowWrite,
      exec_mode: state.policy.execMode,
    }, "Remote MCP bridge is ready");
    return;
  }
  const logger = output;
  logger.success("Remote MCP bridge is ready");
  logger.rawPlain(`  MCP Server URL: ${state.worker.mcpServerUrl}`);
  if (initialOwner) {
    logger.warn("Initial owner account created; save the password now because it is not stored locally or shown again. Do not share this terminal output; rotate the password immediately if it has been exposed.");
    logger.rawPlain(`  Account: ${initialOwner.name}`);
    logger.rawPlain(`  Password: ${initialOwner.password}`);
  } else {
    logger.safePlain("  Use `machine-mcp account` to manage account access.");
  }
  logger.rawPlain(`  Workspace: ${state.workspace.path}`);
  logger.safePlain(`  Policy: ${formatPolicySummary(state.policy)}`);
  if (verbose) logger.rawPlain(`  State: ${state.paths.statePath}`);
}

export function formatPolicySummary(policy = {}) {
  const scope = policy.unrestrictedPaths ? "all local paths" : "workspace only";
  const environment = policy.minimalEnv ? "isolated env" : "full parent env";
  return `${policy.profile || "custom"} [${policy.origin || "unknown"}; write=${policy.allowWrite ? "on" : "off"}; exec=${policy.execMode || "off"}; ${scope}; ${environment}; absolute_paths=${policy.exposeAbsolutePaths ? "on" : "off"}]`;
}
