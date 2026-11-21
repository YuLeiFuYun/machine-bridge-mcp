import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole, type AuthorizedToken } from "./access.ts";
import { accountAuthoritySnapshot, describeDaemonCeiling } from "./authority.ts";
import { jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool, workspaceTools, type WorkerToolDefinition } from "./tool-catalog.ts";

function stripManagedJobMonitorMeta(tool: WorkerToolDefinition): WorkerToolDefinition {
  const cloned = structuredClone(tool) as WorkerToolDefinition & { _meta?: unknown };
  if (cloned._meta && typeof cloned._meta === "object" && !Array.isArray(cloned._meta)) {
    const meta = { ...(cloned._meta as Record<string, unknown>) };
    delete meta.ui;
    if (Object.keys(meta).length === 0) delete cloned._meta;
    else cloned._meta = meta;
  }
  return cloned;
}

export function workerToolsForRole(role: AccountRole, includeJobMonitor = true): WorkerToolDefinition[] {
  const advertised = accountRoleToolNames(role, workspaceTools.map((tool) => tool.name));
  const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
  const monitorTools = includeJobMonitor && accountRoleAllowsTool(role, "start_job") ? [jobMonitorRenderTool, jobMonitorClaimTool, jobMonitorReadTool] : [];
  return [serverInfoTool, ...monitorTools, ...localTools].map((tool) => (
    includeJobMonitor ? structuredClone(tool) as WorkerToolDefinition : stripManagedJobMonitorMeta(tool)
  ));
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
  const effectiveTools = ["server_info", ...workerOnlyTools, ...accountRoleToolNames(input.authorized.role, input.daemonTools)];
  const authorization = accountAuthoritySnapshot({
    accountId: input.authorized.accountId,
    accountVersion: input.authorized.accountVersion,
    role: input.authorized.role,
    daemonPolicy: daemon.policy,
    effectiveTools,
  });
  return { daemon, effectiveTools, advertisedTools, authorization };
}
