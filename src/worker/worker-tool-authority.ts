import { accountRoleToolNames, type AccountRole, type AuthorizedToken } from "./access.ts";
import { accountAuthoritySnapshot, describeDaemonCeiling } from "./authority.ts";
import { serverInfoTool, workspaceTools, type WorkerToolDefinition } from "./tool-catalog.ts";

export function workerToolsForRole(role: AccountRole): WorkerToolDefinition[] {
  const advertised = accountRoleToolNames(role, workspaceTools.map((tool) => tool.name));
  const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
  return [serverInfoTool, ...localTools].map((tool) => structuredClone(tool) as WorkerToolDefinition);
}

export function workerAuthorityContext(input: {
  authorized: AuthorizedToken;
  daemonStatus: Record<string, unknown>;
  daemonTools: Iterable<string>;
}) {
  const daemon = describeDaemonCeiling(input.daemonStatus);
  const advertisedTools = workerToolsForRole(input.authorized.role).map((tool) => tool.name);
  const effectiveTools = ["server_info", ...accountRoleToolNames(input.authorized.role, input.daemonTools)];
  const authorization = accountAuthoritySnapshot({
    accountId: input.authorized.accountId,
    accountVersion: input.authorized.accountVersion,
    role: input.authorized.role,
    daemonPolicy: daemon.policy,
    effectiveTools,
  });
  return { daemon, effectiveTools, advertisedTools, authorization };
}
