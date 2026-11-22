import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole, type AuthorizedToken, accountAuthoritySnapshot, describeDaemonCeiling } from "../oauth/authority.ts";
import { jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool, workspaceTools, workspaceToolsPlain, type WorkerToolDefinition } from "./tool-catalog.ts";

export function workerToolsForRole(role: AccountRole, includeJobMonitor = true): WorkerToolDefinition[] {
  const sourceTools = includeJobMonitor ? workspaceTools : workspaceToolsPlain;
  const advertised = accountRoleToolNames(role, sourceTools.map((tool) => tool.name));
  const localTools = sourceTools.filter((tool) => advertised.has(tool.name));
  const monitorTools = includeJobMonitor && accountRoleAllowsTool(role, "start_job")
    ? [jobMonitorRenderTool, jobMonitorClaimTool, jobMonitorReadTool]
    : [];
  return [serverInfoTool, ...monitorTools, ...localTools].map((tool) => structuredClone(tool) as WorkerToolDefinition);
}

export function workerAuthorityContext(input: {
  authorized: AuthorizedToken;
  daemonStatus: Record<string, unknown>;
  daemonTools: Iterable<string>;
  includeJobMonitor?: boolean;
}) {
  const includeJobMonitor = input.includeJobMonitor ?? true;
  const daemon = describeDaemonCeiling(input.daemonStatus);
  const advertisedTools = workerToolsForRole(input.authorized.role, includeJobMonitor).map((tool) => tool.name);
  const workerOnlyTools = includeJobMonitor && accountRoleAllowsTool(input.authorized.role, "start_job")
    ? [jobMonitorRenderTool.name, jobMonitorClaimTool.name, jobMonitorReadTool.name]
    : [];
  const effectiveTools = [...new Set(["server_info", ...workerOnlyTools, ...accountRoleToolNames(input.authorized.role, input.daemonTools)])];
  const authorization = accountAuthoritySnapshot({
    accountId: input.authorized.accountId,
    accountVersion: input.authorized.accountVersion,
    role: input.authorized.role,
    daemonPolicy: daemon.policy,
    effectiveTools,
  });
  return { daemon, effectiveTools, advertisedTools, authorization };
}
