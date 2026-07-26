import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { JsonRpcMessage } from "./mcp-resumption.ts";
import { createThrottledEdgeLogger } from "./worker-edge-log.ts";

const MAX_TERMINAL_MESSAGE_BYTES = relayContract.maximumResumableMessageBytes + 1024;
export const DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS = [0, 100, 300] as const;
type BridgeFetcher = { fetch(request: Request): Promise<Response> };
const logSubscriptionFailure = createThrottledEdgeLogger();

export async function subscribeTerminalMessage(
  bridge: BridgeFetcher,
  createRequest: () => Request,
  retryDelaysMs: readonly number[],
): Promise<JsonRpcMessage> {
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs.slice(0, 4) : [0];
  let lastError: unknown = new Error("internal MCP stream subscription failed");
  for (const rawDelay of delays) {
    const delayMs = Math.max(0, Math.min(2_000, Math.floor(Number(rawDelay) || 0)));
    if (delayMs > 0) await delay(delayMs);
    try {
      const response = await bridge.fetch(createRequest());
      if (response.status === 200) return await readJsonRpcResponse(response);
      if (response.status !== 101 || !response.webSocket) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new StreamSubscriptionError(`internal MCP stream subscription failed (${response.status})`, retryable);
      }
      const socket = response.webSocket;
      socket.accept();
      return await terminalMessageFromSocket(socket);
    } catch (error) {
      lastError = error;
      if (error instanceof StreamSubscriptionError && !error.retryable) break;
    }
  }
  logSubscriptionFailure("warn", "mcp.stream.subscription.failed", { attempts: delays.length });
  throw lastError;
}

class StreamSubscriptionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "StreamSubscriptionError";
    this.retryable = retryable;
  }
}

function terminalMessageFromSocket(socket: WebSocket): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string, retryable: boolean) => {
      if (settled) return;
      settled = true;
      reject(new StreamSubscriptionError(message, retryable));
    };
    const succeed = (message: JsonRpcMessage) => {
      if (settled) return;
      settled = true;
      resolve(message);
      try { socket.close(1000, "terminal received"); } catch { /* Peer may have closed first. */ }
    };
    socket.addEventListener("message", (event) => {
      if (settled) return;
      try {
        const text = webSocketText(event.data);
        if (new TextEncoder().encode(text).byteLength > MAX_TERMINAL_MESSAGE_BYTES) throw new Error("terminal message is too large");
        succeed(jsonRpcMessage(JSON.parse(text)));
      } catch (error) {
        fail(error instanceof Error ? error.message : "invalid terminal message", false);
        try { socket.close(1008, "invalid terminal message"); } catch { /* socket may already be closing */ }
      }
    });
    socket.addEventListener("close", () => fail("internal MCP stream subscription closed before terminal result", true));
    socket.addEventListener("error", () => fail("internal MCP stream subscription failed", true));
  });
}

async function readJsonRpcResponse(response: Response): Promise<JsonRpcMessage> {
  return jsonRpcMessage(await response.json());
}

function jsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    throw new Error("internal MCP stream subscription returned an invalid JSON-RPC message");
  }
  return value as JsonRpcMessage;
}

function webSocketText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  throw new Error("terminal message must be text or binary UTF-8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
