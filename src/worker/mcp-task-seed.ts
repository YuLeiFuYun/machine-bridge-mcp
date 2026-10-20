import { isMcpTaskAugmentedTool, isMcpTaskJobId, supportsMcpTasks } from "../shared/mcp-task-contract.mjs";
import type { AuthorizedToken } from "./access.ts";
import { McpTaskStore } from "./mcp-task-store.ts";
import { taskView, taskObject } from "./mcp-task-projection.ts";

const RECOVERY_KEY = /^mcp_jr_[A-Za-z0-9_-]{43}$/;
const CONTROL_KEY = /^mcp_jc_[A-Za-z0-9_-]{43}$/;
const ACTIVE_JOB_STATUSES = new Set(["accepted", "queued", "running", "dependency_wait"]);

export type TaskCredentials = Readonly<{ recovery_key: string; control_key: string }>;
export type TaskCredentialResolver = (taskId: string, authorized: AuthorizedToken) => Promise<TaskCredentials>;

export async function createWorkerTaskSeed(input: {
  name: string;
  result: unknown;
  authorized: AuthorizedToken;
  clientCapabilities: unknown;
  store: McpTaskStore;
  resolveCredentials: TaskCredentialResolver;
  now?: number;
}): Promise<Record<string, unknown> | null> {
  if (!supportsMcpTasks(input.clientCapabilities) || !isMcpTaskAugmentedTool(input.name)) return null;
  const result = taskObject(input.result);
  const taskId = isMcpTaskJobId(result.job_id) ? result.job_id : "";
  const status = String(result.status || "").toLowerCase();
  if (!taskId || !ACTIVE_JOB_STATUSES.has(status)
    || typeof result.recovery_key !== "string" || !RECOVERY_KEY.test(result.recovery_key)
    || typeof result.control_key !== "string" || !CONTROL_KEY.test(result.control_key)) return null;
  const credentials = await input.resolveCredentials(taskId, input.authorized);
  if (credentials.recovery_key !== result.recovery_key || credentials.control_key !== result.control_key) return null;
  const record = await input.store.create(taskId, input.authorized, input.now);
  return record ? taskView(record) : null;
}
