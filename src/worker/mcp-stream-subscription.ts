import type { JsonRpcMessage } from "./mcp-resumption.ts";
import { createThrottledEdgeLogger } from "./worker-edge-log.ts";
import { jsonRpcMessage, StreamSubscriptionError, terminalMessageFromSocket } from "./mcp-stream-terminal-socket.ts";
import { boundedStreamAttempt } from "./mcp-stream-attempt.ts";
export const DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS = [0, 100, 300, 1_000, 3_000, 5_000] as const;
type BridgeFetcher = { fetch(request: Request): Promise<Response> };
const logSubscriptionFailure = createThrottledEdgeLogger();

export async function subscribeTerminalMessage(
  bridge: BridgeFetcher,
  createRequest: (signal?: AbortSignal) => Request,
  retryDelaysMs: readonly number[],
  signal?: AbortSignal,
  attemptTimeoutMs = 5_000,
): Promise<JsonRpcMessage> {
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs.slice(0, 8) : [0];
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: unknown = new Error("internal MCP stream subscription failed");
  for (const rawDelay of delays) {
    throwIfAborted(signal);
    const delayMs = Math.max(0, Math.min(10_000, Math.floor(Number(rawDelay) || 0)));
    if (delayMs > 0) await delay(delayMs, signal);
    attempts += 1;
    try {
      const response = await boundedStreamAttempt(signal, attemptTimeoutMs, (attemptSignal) => (
        bridge.fetch(createRequest(attemptSignal))
      ));
      if (response.status === 200) return await readJsonRpcResponse(response);
      if (response.status !== 101 || !response.webSocket) {
        const retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel().catch(() => {});
        throw new StreamSubscriptionError(`internal MCP stream subscription failed (${response.status})`, retryable);
      }
      const socket = response.webSocket;
      socket.accept();
      return await terminalMessageFromSocket(socket, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || (error instanceof StreamSubscriptionError && !error.retryable)) break;
    }
  }
  if (!signal?.aborted) {
    logSubscriptionFailure("warn", "mcp.stream.subscription.failed", {
      attempts,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
    });
  }
  throw lastError;
}


async function readJsonRpcResponse(response: Response): Promise<JsonRpcMessage> {
  try {
    return jsonRpcMessage(await response.json());
  } catch (error) {
    throw new StreamSubscriptionError(
      error instanceof Error ? error.message : "invalid terminal JSON-RPC response",
      false,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StreamSubscriptionError("internal MCP stream subscription cancelled", false);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new StreamSubscriptionError("internal MCP stream subscription cancelled", false));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
