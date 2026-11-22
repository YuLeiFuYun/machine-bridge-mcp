import type { ProgressNotification } from "../../shared/mcp-protocol.mjs";
import type { AuthorizedToken } from "../oauth/authority.ts";
import { rpcError, asObject, type JsonRpcRequest } from "./jsonrpc.ts";
import type { McpRequestCancellationRegistry } from "./request-cancellation.ts";
import { createProgressReporter } from "../../shared/progress-reporter.mjs";
import { progressNotification } from "../../shared/mcp-protocol.mjs";
import { isMcpTaskAugmentedTool, supportsMcpTasks, taskClientCapabilities } from "../../shared/mcp-task-contract.mjs";

export function jsonRpcResponseStream(
  result: Promise<Record<string, unknown>>,
  options: {
    onCancel: () => void;
    onError: (error: unknown) => Record<string, unknown>;
    onProgress?: (emit: (event: ProgressNotification) => void) => void;
  },
): Response {
  const encoder = new TextEncoder();
  let writable = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const finish = (message: () => Record<string, unknown>) => {
        if (!writable) return;
        writable = false;
        try {
          controller.enqueue(encoder.encode(sseMessage(message())));
          controller.close();
        } catch {
          try { controller.error(new Error("JSON-RPC response stream failed")); }
          catch { /* Client already closed the response stream. */ }
        }
      };
      if (options.onProgress) {
        try {
          options.onProgress((event) => {
            if (!writable) return;
            try { controller.enqueue(encoder.encode(sseMessage(event))); }
            catch { /* Client already closed the response stream. */ }
          });
        } catch { /* Progress subscription ignored. */ }
      }
      void result.then(
        (message) => finish(() => message),
        (error) => finish(() => options.onError(error)),
      );
    },
    cancel() {
      if (!writable) return;
      writable = false;
      options.onCancel();
    },
  });
  return eventStreamResponse(body);
}

function eventStreamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

function sseMessage(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}
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
        ? createProgressReporter({ progressToken, label: toolName, emit: (params) => onProgress(progressNotification(params)) })
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
export function streamedMcpToolResponse(input: Readonly<{
  request: Request;
  requestKey?: string;
  cancellations: McpRequestCancellationRegistry;
  dispatch: (signal: AbortSignal, onProgress?: (msg: ProgressNotification) => void) => Promise<Record<string, unknown>>;
  onError: () => Record<string, unknown>;
}>): Response {
  const cancellation = input.cancellations.open(input.requestKey, input.request.signal);
  let progressEmitter: ((msg: ProgressNotification) => void) | undefined;
  const result = Promise.resolve()
    .then(() => input.dispatch(cancellation.signal, (msg) => progressEmitter?.(msg)))
    .finally(cancellation.release);
  return jsonRpcResponseStream(result, {
    onCancel: () => cancellation.cancel("client response stream closed"),
    onError: input.onError,
    onProgress: (emit) => { progressEmitter = emit; },
  });
}
