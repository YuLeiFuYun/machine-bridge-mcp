import type { AuthorizedToken } from "./access.ts";
import { rpcError, asObject, type JsonRpcRequest } from "./mcp-jsonrpc.ts";
import type { McpRequestCancellationRegistry } from "./mcp-request-cancellation.ts";
import { streamedMcpToolResponse } from "./mcp-streamed-tool-response.ts";
import { createProgressReporter } from "../shared/progress-reporter.mjs";
import { isMcpTaskAugmentedTool, supportsMcpTasks, taskClientCapabilities } from "../shared/mcp-task-contract.mjs";

export function createStreamedToolResponse(input: Readonly<{
  request: Request;
  body: JsonRpcRequest;
  base: string;
  authorized: AuthorizedToken;
  requestKey?: string;
  progressToken?: unknown;
  cancellations: McpRequestCancellationRegistry;
  dispatch: (signal: AbortSignal, requestKey?: string, progressToken?: unknown) => Promise<{ message: Record<string, unknown> }>;
  recordError: (code: string) => void;
}>): Response {
  return streamedMcpToolResponse({
    request: input.request,
    requestKey: input.requestKey,
    cancellations: input.cancellations,
    dispatch: async (signal, onProgress) => {
      const params = asObject(input.body.params);
      const toolName = typeof params.name === "string" ? params.name : "tool call";
      const taskCapable = supportsMcpTasks(taskClientCapabilities(input.body)) && isMcpTaskAugmentedTool(toolName);
      const progressToken = typeof input.progressToken === "string" || typeof input.progressToken === "number"
        ? input.progressToken : undefined;
      const stopProgress = !taskCapable && progressToken !== undefined && onProgress
        ? createProgressReporter({ progressToken, label: toolName, emit: onProgress })
        : () => {};
      try {
        return (await input.dispatch(signal, input.requestKey, input.progressToken)).message;
      } finally {
        stopProgress();
      }
    },
    onError: () => {
      input.recordError("mcp_stream_dispatch_failed");
      return rpcError(input.body.id, -32603, "Internal error");
    },
  });
}
