import {
  isSuccessfulJobStatus, MCP_TASK_POLL_INTERVAL_MS, statusMessageFor, taskStatusForJob,
} from "../shared/mcp-task-contract.mjs";
import type { McpTaskRecord } from "./mcp-task-store.ts";

export { isSuccessfulJobStatus, statusMessageFor, taskStatusForJob };

export function taskView(task: McpTaskRecord): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: Math.max(0, task.expiresAt - Date.parse(task.createdAt)),
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
  };
}

export function taskObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isTaskRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
