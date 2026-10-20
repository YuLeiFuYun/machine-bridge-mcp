import { MCP_TASK_POLL_INTERVAL_MS } from "../shared/mcp-task-contract.mjs";
import type { McpTaskRecord, McpTaskStatus } from "./mcp-task-store.ts";

const ACTIVE_JOB_STATUSES = new Set(["accepted", "queued", "running", "cleaning", "interrupted", "dependency_wait"]);
const TERMINAL_JOB_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
  "cancelled_cleanup_failed", "recovered", "recovery_failed", "runner_failed", "runner_launch_failed",
  "recovery_exhausted", "cancelled_before_start", "expired_before_start", "dependency_failed",
]);
const SUCCESSFUL_JOB_STATUSES = new Set(["succeeded", "recovered"]);

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

export function taskStatusForJob(status: string): McpTaskStatus | null {
  if (status.startsWith("cancelled") || status === "expired_before_start") return "cancelled";
  if (ACTIVE_JOB_STATUSES.has(status)) return "working";
  if (TERMINAL_JOB_STATUSES.has(status)) return "completed";
  return null;
}

export function statusMessageFor(job: Record<string, unknown>, status: McpTaskStatus): string {
  if (status === "cancelled") return "Execution was cancelled.";
  if (status === "completed") return isSuccessfulJobStatus(String(job.status || "").toLowerCase())
    ? "Execution completed." : "Execution finished with an error result.";
  const phase = typeof job.current_phase === "string" && job.current_phase ? job.current_phase : "execution";
  if (phase === "dependency_wait") return "Waiting for dependency jobs.";
  const step = Number.isSafeInteger(job.current_step) && Number(job.current_step) >= 0
    ? ", step " + (Number(job.current_step) + 1) : "";
  const readablePhase = phase.replace(/[_-]+/g, " ");
  return "Running " + readablePhase + step + ".";
}

export function isSuccessfulJobStatus(status: string): boolean {
  return SUCCESSFUL_JOB_STATUSES.has(status);
}

export function taskObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isTaskRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
