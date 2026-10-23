// @ts-check

export const MCP_TASK_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_TASK_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_TASK_POLL_INTERVAL_MS = 2000;
export const MCP_TASK_JOB_ID_PATTERN = "^job_[A-Za-z0-9_-]{24,}$";
const MCP_TASK_JOB_ID = new RegExp(MCP_TASK_JOB_ID_PATTERN);

export const MCP_TASK_ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cleaning", "interrupted"]);
export const MCP_TASK_TERMINAL_JOB_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
  "cancelled_cleanup_failed", "recovered", "recovery_failed", "runner_failed", "runner_launch_failed",
  "recovery_exhausted", "cancelled_before_start", "expired_before_start",
]);
export const MCP_TASK_SUCCESSFUL_JOB_STATUSES = new Set(["succeeded", "recovered"]);

/** @param {unknown} value @returns {value is string} */
export function isMcpTaskJobId(value) {
  return typeof value === "string" && MCP_TASK_JOB_ID.test(value);
}

const TASK_AUGMENTED_TOOLS = new Set(["exec_command", "run_process", "run_local_command", "start_job"]);

/** @param {unknown} clientCapabilities */
export function supportsMcpTasks(clientCapabilities) {
  if (!clientCapabilities || typeof clientCapabilities !== "object" || Array.isArray(clientCapabilities)) return false;
  const extensions = /** @type {Record<string, unknown>} */ (clientCapabilities).extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return false;
  const capability = /** @type {Record<string, unknown>} */ (extensions)[MCP_TASK_EXTENSION_ID];
  return Boolean(capability) && typeof capability === "object" && !Array.isArray(capability);
}

/** @param {string} name */
export function isMcpTaskAugmentedTool(name) {
  return TASK_AUGMENTED_TOOLS.has(name);
}

/** @param {unknown} request @returns {Record<string, unknown>} */
export function taskClientCapabilities(request) {
  const params = asObject(asObject(request).params);
  const meta = asObject(params._meta);
  return asObject(meta["io.modelcontextprotocol/clientCapabilities"]);
}

/** @param {unknown} statusOrJob @returns {"working" | "completed" | "cancelled" | null} */
export function taskStatusForJob(statusOrJob) {
  const raw = typeof statusOrJob === "string" ? statusOrJob : String(asObject(statusOrJob).status || "");
  const status = raw.toLowerCase();
  if (status.startsWith("cancelled") || status === "expired_before_start") return "cancelled";
  if (MCP_TASK_ACTIVE_JOB_STATUSES.has(status)) return "working";
  if (MCP_TASK_TERMINAL_JOB_STATUSES.has(status)) return "completed";
  return null;
}

/** @param {unknown} statusOrJob */
export function isSeedableTaskJobStatus(statusOrJob) {
  return taskStatusForJob(statusOrJob) === "working";
}

/** @param {unknown} statusOrJob */
export function isSuccessfulJobStatus(statusOrJob) {
  const raw = typeof statusOrJob === "string" ? statusOrJob : String(asObject(statusOrJob).status || "");
  return MCP_TASK_SUCCESSFUL_JOB_STATUSES.has(raw.toLowerCase());
}

/** @param {unknown} job @param {"working" | "input_required" | "completed" | "failed" | "cancelled"} status */
export function statusMessageFor(job, status) {
  const record = asObject(job);
  if (status === "cancelled") return "Execution was cancelled.";
  if (status === "completed") {
    return isSuccessfulJobStatus(record) ? "Execution completed." : "Execution finished with an error result.";
  }
  const phase = typeof record.current_phase === "string" && record.current_phase ? record.current_phase : "execution";
  if (phase === "dependency_wait") return "Waiting for dependency jobs.";
  const step = Number.isSafeInteger(record.current_step) && Number(record.current_step) >= 0
    ? `, step ${Number(record.current_step) + 1}` : "";
  return `Running ${phase.replace(/[_-]+/g, " ")}${step}.`;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}
