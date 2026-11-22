import type { AuthorizedToken } from "../oauth/authority.ts";
import { publicWorkerToolError } from "../room/errors.ts";
import { managedJobMonitorClientCapabilities } from "./job-monitor.ts";
import { createWorkerTaskSeed, type TaskCredentialResolver } from "./tasks.ts";
import type { McpTaskStore } from "./task-store.ts";
import { rpcError, rpcResult, textToolResult, type JsonRpcRequest, asObject } from "./jsonrpc.ts";
import { staleSchemaGuidanceResult } from "./stale-schema.ts";
import { taskCreatedResult, toolArgumentValidationError } from "../../shared/mcp-protocol.mjs";
import { isMcpTaskAugmentedTool, supportsMcpTasks } from "../../shared/mcp-task-contract.mjs";
import { validateWorkerToolArguments } from "./tool-catalog.ts";

export type WorkerToolCallConfig = Readonly<{
  serverInfo: Record<string, unknown>;
  tools: (authorized: AuthorizedToken) => Array<Record<string, unknown>>;
  includeJobMonitor?: boolean;
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
  const inspected = inspectWorkerToolCall(request.params, config.tools(authorized), config.includeJobMonitor !== false);
  if (!inspected.ok) {
    const guidance = staleSchemaGuidanceResult(request, inspected.issues, config.serverInfo);
    if (guidance) return { status: 200, message: guidance };
    if (inspected.reason === "invalid_arguments") {
      return { status: 200, message: rpcResult(request.id,
        textToolResult(toolArgumentValidationError(inspected.issues || []), true, config.serverInfo))! };
    }
    const message = inspected.reason === "missing_name" ? "tools/call requires a tool name"
      : inspected.reason === "unknown_tool" ? "Unknown tool"
        : "tools/call arguments must be an object";
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
type ToolDefinition = Readonly<{ name?: unknown }>;

type ValidationIssue = Readonly<{ instancePath: string; keyword: string; message: string }>;

export type WorkerToolCallInput =
  | Readonly<{ ok: true; name: string; args: Record<string, unknown> }>
  | Readonly<{ ok: false; reason: "missing_name" | "unknown_tool" | "invalid_argument_structure" | "invalid_arguments"; issues?: readonly ValidationIssue[] }>;

export function inspectWorkerToolCall(
  paramsValue: unknown,
  advertisedTools: readonly ToolDefinition[],
  includeJobMonitor = true,
): WorkerToolCallInput {
  const params = asObject(paramsValue);
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "";
  if (!name) return Object.freeze({ ok: false, reason: "missing_name" });
  if (!advertisedTools.some((tool) => tool.name === name)) return Object.freeze({ ok: false, reason: "unknown_tool" });
  const rawArgs = params.arguments === undefined ? {} : params.arguments;
  const validation = validateWorkerToolArguments(name, rawArgs, includeJobMonitor);
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return Object.freeze({ ok: false, reason: "invalid_argument_structure", issues: validation.issues });
  }
  if (!validation.known) return Object.freeze({ ok: false, reason: "unknown_tool" });
  if (!validation.valid) {
    return Object.freeze({ ok: false, reason: "invalid_arguments", issues: validation.issues });
  }
  return Object.freeze({ ok: true, name, args: rawArgs as Record<string, unknown> });
}
