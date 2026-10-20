import { jsonRpcResponseStream } from "./mcp-response-stream.ts";
import type { McpRequestCancellationRegistry } from "./mcp-request-cancellation.ts";

export function streamedMcpToolResponse(input: Readonly<{
  request: Request;
  requestKey?: string;
  cancellations: McpRequestCancellationRegistry;
  dispatch: (signal: AbortSignal, onProgress?: (msg: unknown) => void) => Promise<Record<string, unknown>>;
  onError: () => Record<string, unknown>;
}>): Response {
  const cancellation = input.cancellations.open(input.requestKey, input.request.signal);
  let progressEmitter: ((msg: unknown) => void) | undefined;
  const result = Promise.resolve()
    .then(() => input.dispatch(cancellation.signal, (msg) => progressEmitter?.(msg)))
    .finally(cancellation.release);
  return jsonRpcResponseStream(result, {
    onCancel: () => cancellation.cancel("client response stream closed"),
    onError: input.onError,
    onProgress: (emit) => { progressEmitter = emit; },
  });
}
