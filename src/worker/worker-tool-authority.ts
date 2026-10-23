import { accountRoleAllowsTool, accountRoleToolNames, type AccountRole, type AuthorizedToken } from "./access.ts";
import { accountAuthoritySnapshot, describeDaemonCeiling } from "./authority.ts";
import { jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool, workspaceTools, type WorkerToolDefinition } from "./tool-catalog.ts";
import { CORE_CORNERSTONE_TOOL_NAMES, PROGRESSIVE_TOOL_GROUPS } from "../shared/tool-groups.mjs";

export function workerToolsForRole(role: AccountRole, options: { progressive?: boolean; groups?: string[]; intent?: string; topK?: number } = {}): WorkerToolDefinition[] {
  const advertised = accountRoleToolNames(role, workspaceTools.map((tool) => tool.name));
  const localTools = workspaceTools.filter((tool) => advertised.has(tool.name));
  const monitorTools = accountRoleAllowsTool(role, "start_job") ? [jobMonitorRenderTool, jobMonitorClaimTool, jobMonitorReadTool] : [];
  let combined = [serverInfoTool, ...monitorTools, ...localTools];
  if (options.progressive) {
    const allowed = new Set([...CORE_CORNERSTONE_TOOL_NAMES, ...monitorTools.map((t) => t.name)]);
    if (Array.isArray(options.groups)) {
      for (const group of options.groups) {
        const groupTools = PROGRESSIVE_TOOL_GROUPS[group as keyof typeof PROGRESSIVE_TOOL_GROUPS];
        if (Array.isArray(groupTools)) {
          for (const name of groupTools) allowed.add(name);
        }
      }
    }
    combined = combined.filter((tool) => allowed.has(tool.name));
  }
  if (options.intent && typeof options.intent === "string" && options.intent.trim().length > 0) {
    const intentLower = options.intent.toLowerCase();
    const scored = combined.map((tool) => {
      let score = 0;
      if (CORE_CORNERSTONE_TOOL_NAMES.has(tool.name as any)) score += 5;
      const matchText = `${tool.name} ${tool.description || ""}`.toLowerCase();
      for (const word of intentLower.split(/\s+/)) {
        if (word.length >= 3 && matchText.includes(word)) score += 3;
      }
      return { tool, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const topK = Math.max(4, Math.min(options.topK || 8, combined.length));
    combined = scored.slice(0, topK).map((item) => item.tool);
  }
  return combined.map((tool) => structuredClone(tool) as WorkerToolDefinition);
}

export function workerAuthorityContext(input: {
  authorized: AuthorizedToken;
  daemonStatus: Record<string, unknown>;
  daemonTools: Iterable<string>;
}) {
  const daemon = describeDaemonCeiling(input.daemonStatus);
  const advertisedTools = workerToolsForRole(input.authorized.role).map((tool) => tool.name);
  const workerOnlyTools = accountRoleAllowsTool(input.authorized.role, "start_job")
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
