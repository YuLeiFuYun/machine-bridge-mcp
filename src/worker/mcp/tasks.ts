import { MCP_MISSING_REQUIRED_CLIENT_CAPABILITY, completeResult } from "../../shared/mcp-protocol.mjs";
import type { AuthorizedToken } from "../oauth/authority.ts";
import { publicWorkerToolError, WorkerToolError } from "../room/errors.ts";
import { rpcError, rpcResult, textToolResult, type JsonRpcRequest } from "./jsonrpc.ts";
import { McpTaskStore } from "./task-store.ts";
import { isMcpTaskJobId, supportsMcpTasks, taskClientCapabilities, isMcpTaskAugmentedTool, isSeedableTaskJobStatus, isSuccessfulJobStatus, MCP_TASK_POLL_INTERVAL_MS, statusMessageFor, taskStatusForJob } from "../../shared/mcp-task-contract.mjs";
import type { AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import { issueManagedJobCapability } from "../room/managed-job-contract.ts";
import type { McpTaskRecord } from "./task-store.ts";

export type TaskToolInvoker = (input: {
  name: string;
  args: Record<string, unknown>;
  base: string;
  authorized: AuthorizedToken;
  signal: AbortSignal;
  requestKey?: string;
}) => Promise<unknown>;

export async function dispatchWorkerTaskOperation(
  request: JsonRpcRequest,
  invoker: TaskToolInvoker,
  base: string,
  authorized: AuthorizedToken,
  signal: AbortSignal,
  store: McpTaskStore | undefined,
  resolveCredentials: TaskCredentialResolver | undefined,
  serverInfo: Record<string, unknown>,
  requestKey?: string,
): Promise<{ status: number; message: Record<string, unknown> } | null> {
  const method = request.method;
  if (method !== "tasks/get" && method !== "tasks/update" && method !== "tasks/cancel") return null;
  if (!supportsMcpTasks(taskClientCapabilities(request))) {
    return { status: 200, message: rpcError(request.id, MCP_MISSING_REQUIRED_CLIENT_CAPABILITY, "Missing required client capability", {
      requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
    }) };
  }
  const params = taskObject(request.params);
  const taskId = typeof params.taskId === "string" ? params.taskId : "";
  if (!isMcpTaskJobId(taskId)) {
    return { status: 200, message: rpcError(request.id, -32602, method + " requires a valid taskId") };
  }
  if (!store || !resolveCredentials) {
    return { status: 200, message: rpcError(request.id, -32603, "Task service is unavailable") };
  }

  try {
    const task = await store.get(taskId, authorized);
    if (!task) return { status: 200, message: rpcError(request.id, -32000, "Task not found or not authorized") };
    if (method === "tasks/get" && (task.status === "cancelled" || task.status === "failed")) {
      const fields = task.status === "failed"
        ? { ...taskView(task), error: { code: -32603, message: task.statusMessage } }
        : taskView(task);
      return { status: 200, message: rpcResult(request.id, completeResult(fields, serverInfo))! };
    }
    if (method === "tasks/get" && task.status === "completed") {
      const cached = await store.getResult(taskId, authorized);
      if (cached) return { status: 200, message: rpcResult(request.id, completeResult({ ...taskView(task), result: cached }, serverInfo))! };
    }
    if (method === "tasks/update") {
      if (!isTaskRecord(params.inputResponses)) {
        return { status: 200, message: rpcError(request.id, -32602, "tasks/update requires an inputResponses object") };
      }
      // This server does not issue client-input requests. Unknown or satisfied response keys are ignored.
      return { status: 200, message: rpcResult(request.id, completeResult({}, serverInfo))! };
    }

    const credentials = await resolveCredentials(taskId, authorized);
    if (method === "tasks/cancel") {
      if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
        return { status: 200, message: rpcResult(request.id, completeResult({}, serverInfo))! };
      }
      await invoker({ name: "cancel_job", args: { job_id: taskId, control_key: credentials.control_key }, base, authorized, signal, requestKey });
      await store.updateStatus(taskId, authorized, "cancelled", "Execution was cancelled.");
      return { status: 200, message: rpcResult(request.id, completeResult({}, serverInfo))! };
    }

    const raw = await invoker({ name: "read_job", args: { job_id: taskId, recovery_key: credentials.recovery_key }, base, authorized, signal, requestKey });
    const job = taskObject(raw);
    const jobStatus = String(job.status || "").toLowerCase();
    const status = taskStatusForJob(jobStatus);
    if (!status) return { status: 200, message: rpcError(request.id, -32603, "Managed task returned an unknown execution state") };
    const taskResult = status === "completed" ? textToolResult(raw, !isSuccessfulJobStatus(jobStatus), serverInfo) : undefined;
    const updated = await store.updateStatus(taskId, authorized, status, statusMessageFor(job, status), taskResult);
    if (!updated) return { status: 200, message: rpcError(request.id, -32000, "Task not found or not authorized") };
    const result: Record<string, unknown> = taskView(updated);
    if (updated.status === "completed") {
      const cached = await store.getResult(taskId, authorized);
      if (cached) result.result = cached;
      else if (taskResult && status === "completed") result.result = taskResult;
      else {
        const refreshed = await invoker({ name: "read_job", args: { job_id: taskId, recovery_key: credentials.recovery_key }, base, authorized, signal, requestKey });
        const refreshedStatus = String(taskObject(refreshed).status || "").toLowerCase();
        if (taskStatusForJob(refreshedStatus) !== "completed") {
          return { status: 200, message: rpcError(request.id, -32603, "Task completed but its result is not yet available") };
        }
        result.result = textToolResult(refreshed, !isSuccessfulJobStatus(refreshedStatus), serverInfo);
      }
    }
    return { status: 200, message: rpcResult(request.id, completeResult(result, serverInfo))! };
  } catch (error) {
    if (method === "tasks/get" && error instanceof WorkerToolError && error.code === "not_found") {
      const message = "Managed-job result is unavailable; the task result could not be recovered.";
      try {
        const updated = await store.updateStatus(taskId, authorized, "failed", message);
        if (updated?.status === "failed") {
          return { status: 200, message: rpcResult(request.id, completeResult({
            ...taskView(updated), error: { code: -32603, message: updated.statusMessage },
          }, serverInfo))! };
        }
      } catch {
        // Preserve the original operation error if terminal task-state persistence also fails.
      }
    }
    return { status: 200, message: rpcError(request.id, -32000, "Task operation failed", publicWorkerToolError(error)) };
  }
}
const RECOVERY_KEY = /^mcp_jr_[A-Za-z0-9_-]{43}$/;

const CONTROL_KEY = /^mcp_jc_[A-Za-z0-9_-]{43}$/;

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
  if (!taskId || !isSeedableTaskJobStatus(result.status)
    || typeof result.recovery_key !== "string" || !RECOVERY_KEY.test(result.recovery_key)
    || typeof result.control_key !== "string" || !CONTROL_KEY.test(result.control_key)) return null;
  const credentials = await input.resolveCredentials(taskId, input.authorized);
  if (credentials.recovery_key !== result.recovery_key || credentials.control_key !== result.control_key) return null;
  const record = await input.store.create(taskId, input.authorized, input.now);
  return record ? taskView(record) : null;
}
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;

export class McpTaskService {
  readonly store: McpTaskStore;
  readonly resolveCredentials: TaskCredentialResolver;
  private readonly identityKey: () => string;

  constructor(storage: Storage, identityKey: () => string) {
    this.store = new McpTaskStore(storage);
    this.identityKey = identityKey;
    this.resolveCredentials = async (taskId, authorized) => {
      const keyMaterial = this.identityKey();
      const [recovery_key, control_key] = await Promise.all([
        issueManagedJobCapability(keyMaterial, authorized, taskId, "read"),
        issueManagedJobCapability(keyMaterial, authorized, taskId, "control"),
      ]);
      return { recovery_key, control_key };
    };
  }

  async cancelAuthority(revocation: AuthorityRevocation, onFailure: (error: unknown) => void): Promise<number> {
    try { return await this.store.cancelAuthority(revocation); }
    catch (error) {
      try { onFailure(error); } catch { /* telemetry cannot block authority cleanup */ }
      return 0;
    }
  }
}
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
