import type { AuthorizedToken } from "./access.ts";
import { publicWorkerToolError } from "./errors.ts";
import { inspectWorkerToolCall } from "./mcp-tool-call-input.ts";
import { managedJobMonitorClientCapabilities } from "./mcp-job-monitor-ui.ts";
import { createWorkerTaskSeed, type TaskCredentialResolver } from "./mcp-tasks.ts";
import type { McpTaskStore } from "./mcp-task-store.ts";
import { rpcError, rpcResult, textToolResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { staleSchemaGuidanceResult } from "./mcp-stale-schema-guidance.ts";
import { taskCreatedResult } from "../shared/mcp-protocol.mjs";
import { isMcpTaskAugmentedTool, supportsMcpTasks } from "../shared/mcp-task-contract.mjs";

type WorkerToolCallConfig = Readonly<{
  serverInfo: Record<string, unknown>;
  tools: (authorized: AuthorizedToken) => Array<Record<string, unknown>>;
  recordError: (code: string) => void;
  taskStore?: McpTaskStore;
  resolveTaskCredentials?: TaskCredentialResolver;
  callTool: (input: {
    name: string;
    args: Record<string, unknown>;
    base: string;
    authorized: AuthorizedToken;
    signal: AbortSignal;
    requestKey?: string;
    clientCapabilities?: Record<string, unknown>;
    progressToken?: unknown;
  }) => Promise<unknown>;
}>;

export async function dispatchWorkerToolCall(
  request: JsonRpcRequest,
  base: string,
  authorized: AuthorizedToken,
  signal: AbortSignal,
  requestKey: string | undefined,
  progressToken: unknown,
  config: WorkerToolCallConfig,
): Promise<{ status: number; message: Record<string, unknown> }> {
  const inspected = inspectWorkerToolCall(request.params, config.tools(authorized));
  if (!inspected.ok) {
    const guidance = staleSchemaGuidanceResult(request, inspected.issues, config.serverInfo);
    if (guidance) return { status: 200, message: guidance };
    const message = inspected.reason === "missing_name" ? "tools/call requires a tool name"
      : inspected.reason === "unknown_tool" ? "Unknown tool"
        : "Tool arguments do not match the input schema";
    return {
      status: 200,
      message: rpcError(request.id, -32602, message, inspected.issues
        ? { side_effects_started: false, validation_issues: [...inspected.issues] } : undefined),
    };
  }

  const { name, args: rawArgs } = inspected;
  try {
    const clientCapabilities = managedJobMonitorClientCapabilities(request);
    const result = await config.callTool({
      name, args: rawArgs as Record<string, unknown>, base, authorized, signal, requestKey,
      clientCapabilities, progressToken,
    });
    if (supportsMcpTasks(clientCapabilities) && isMcpTaskAugmentedTool(name)
      && config.taskStore && config.resolveTaskCredentials) {
      try {
        const task = await createWorkerTaskSeed({
          name, result, authorized, clientCapabilities, store: config.taskStore,
          resolveCredentials: config.resolveTaskCredentials,
        });
        if (task) return { status: 200, message: rpcResult(request.id, taskCreatedResult(task, config.serverInfo))! };
      } catch {
        // Task projection is optional. The already-accepted managed-job result remains
        // available as the ordinary tools/call result if task persistence is unavailable.
        config.recordError("mcp_task_create_failed");
      }
    }
    return { status: 200, message: rpcResult(request.id, textToolResult(result, false, config.serverInfo))! };
  } catch (error) {
    return {
      status: 200,
      message: rpcResult(request.id, textToolResult({ error: publicWorkerToolError(error) }, true, config.serverInfo))!,
    };
  }
}
