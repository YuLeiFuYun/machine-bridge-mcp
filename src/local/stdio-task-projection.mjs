// @ts-check

import {
  isSuccessfulJobStatus, MCP_TASK_POLL_INTERVAL_MS, MCP_TASK_TTL_MS, statusMessageFor, taskStatusForJob,
} from "../shared/mcp-task-contract.mjs";
import { completeResult } from "../shared/mcp-protocol.mjs";
import { projectMcpResult } from "../shared/result-projection.mjs";

/** @param {Record<string, unknown>} job @param {string} taskId */
export function taskViewForJob(job, taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) throw new Error("Task is missing its identifier");
  const status = taskStatusForJob(job);
  if (!status) throw new Error(`Task ${taskId} has an unknown execution state`);
  const createdAt = typeof job?.created_at === "string" ? job.created_at
    : typeof job?.createdAt === "string" ? job.createdAt : null;
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error(`Task ${taskId} is missing a valid creation timestamp`);
  const candidateUpdatedAt = typeof job?.updated_at === "string" ? job.updated_at
    : typeof job?.updatedAt === "string" ? job.updatedAt : createdAt;
  const lastUpdatedAt = Number.isFinite(Date.parse(candidateUpdatedAt)) ? candidateUpdatedAt : createdAt;
  return {
    taskId,
    status,
    statusMessage: statusMessageFor(job, status),
    createdAt,
    lastUpdatedAt,
    ttlMs: MCP_TASK_TTL_MS,
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
  };
}

/** @param {Record<string, unknown>} job @param {Record<string, unknown>} serverInfo */
export function taskToolResult(job, serverInfo) {
  const projection = projectMcpResult(job);
  /** @type {Record<string, unknown>} */
  const result = {
    content: [{ type: "text", text: projection.text }],
    isError: !isSuccessfulJobStatus(job),
  };
  if (projection.hasStructuredContent) result.structuredContent = structuredClone(projection.structuredContent);
  return completeResult(result, serverInfo);
}
