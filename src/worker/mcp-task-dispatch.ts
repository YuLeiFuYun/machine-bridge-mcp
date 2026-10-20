import { MCP_MISSING_REQUIRED_CLIENT_CAPABILITY, completeResult } from "../shared/mcp-protocol.mjs";
import type { AuthorizedToken } from "./access.ts";
import { publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { rpcError, rpcResult, textToolResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { McpTaskStore } from "./mcp-task-store.ts";
import type { TaskCredentialResolver } from "./mcp-task-seed.ts";
import { isSuccessfulJobStatus, isTaskRecord, statusMessageFor, taskObject, taskStatusForJob, taskView } from "./mcp-task-projection.ts";
import { isMcpTaskJobId, supportsMcpTasks, taskClientCapabilities } from "../shared/mcp-task-contract.mjs";

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
