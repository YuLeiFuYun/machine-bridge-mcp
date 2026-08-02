import { boundedStreamAttempt } from "./mcp-stream-attempt.ts";
import { withProxyHeaders, type BridgeFetcher } from "./mcp-stream-proxy-contract.ts";

export const DEFAULT_PREPARE_RETRY_DELAYS_MS = [0, 100, 300] as const;

export async function fetchPreparedStreamResponse(
  bridge: BridgeFetcher,
  request: Request,
  retryDelaysMs: readonly number[],
  attemptTimeoutMs = 5_000,
  retryId = "",
): Promise<Response> {
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs.slice(0, 4) : [0];
  let lastError: unknown = new Error("MCP stream preparation failed");
  for (let index = 0; index < delays.length; index += 1) {
    const delayMs = Math.max(0, Math.min(2_000, Math.floor(Number(delays[index]) || 0)));
    if (delayMs > 0) await delay(delayMs, request.signal);
    if (request.signal.aborted) throw request.signal.reason ?? new Error("MCP stream preparation cancelled");
    try {
      const response = await boundedStreamAttempt(request.signal, attemptTimeoutMs, (signal) => bridge.fetch(
        withProxyHeaders(request.clone() as Request, "prepare", "", signal, retryId),
      ));
      if (response.status < 500) return response;
      if (index === delays.length - 1) return response;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("MCP stream preparation cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
