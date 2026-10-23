import { MCP_TASK_POLL_INTERVAL_MS, MCP_TASK_TTL_MS } from "../shared/mcp-task-contract.mjs";
import { completeResult } from "../shared/mcp-protocol.mjs";
import { projectMcpResult } from "../shared/result-projection.mjs";

// Managed-job statuses are projected onto the MCP task vocabulary the Worker publishes.
// Anything that is not active and not cancelled has settled, which the extension reports as
// `completed`; a settled failure carries its error in the result payload, never as a fake success.
const TASK_ACTIVE_JOB_STATUSES = new Set(["accepted", "queued", "running", "cleaning", "interrupted", "dependency_wait"]);
const TASK_TERMINAL_JOB_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
  "cancelled_cleanup_failed", "recovered", "recovery_failed", "runner_failed", "runner_launch_failed",
  "recovery_exhausted", "cancelled_before_start", "expired_before_start", "dependency_failed",
]);
const TASK_SUCCESSFUL_JOB_STATUSES = new Set(["succeeded", "recovered"]);

function taskStatusForJob(job) {
  const status = String(job?.status || "").toLowerCase();
  if (status.startsWith("cancelled") || status === "expired_before_start") return "cancelled";
  if (TASK_ACTIVE_JOB_STATUSES.has(status)) return "working";
  if (TASK_TERMINAL_JOB_STATUSES.has(status)) return "completed";
  return null;
}

function taskStatusMessage(job, status) {
  if (status === "cancelled") return "Execution was cancelled.";
  if (status === "completed") {
    return TASK_SUCCESSFUL_JOB_STATUSES.has(String(job?.status || "").toLowerCase())
      ? "Execution completed." : "Execution finished with an error result.";
  }
  const phase = typeof job?.current_phase === "string" && job.current_phase ? job.current_phase : "execution";
  if (phase === "dependency_wait") return "Waiting for dependency jobs.";
  const step = Number.isSafeInteger(job?.current_step) && Number(job.current_step) >= 0 ? `, step ${Number(job.current_step) + 1}` : "";
  return `Running ${phase.replace(/[_-]+/g, " ")}${step}.`;
}

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
    statusMessage: taskStatusMessage(job, status),
    createdAt,
    lastUpdatedAt,
    ttlMs: MCP_TASK_TTL_MS,
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
  };
}

/** @param {Record<string, unknown>} job @param {Record<string, unknown>} serverInfo */
export function taskToolResult(job, serverInfo) {
  const projection = projectMcpResult(job);
  const result = {
    content: [{ type: "text", text: projection.text }],
    isError: !TASK_SUCCESSFUL_JOB_STATUSES.has(String(job?.status || "").toLowerCase()),
  };
  if (projection.hasStructuredContent) result.structuredContent = structuredClone(projection.structuredContent);
  return completeResult(result, serverInfo);
}
