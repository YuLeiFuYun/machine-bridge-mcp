import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { JsonRpcMessage } from "./mcp-resumption.ts";

const MAX_TERMINAL_MESSAGE_BYTES = relayContract.maximumResumableMessageBytes + 1024;

export class StreamSubscriptionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "StreamSubscriptionError";
    this.retryable = retryable;
  }
}

export function terminalMessageFromSocket(socket: WebSocket, signal?: AbortSignal): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const fail = (message: string, retryable: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new StreamSubscriptionError(message, retryable));
    };
    const succeed = (message: JsonRpcMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(message);
      try { socket.close(1000, "terminal received"); } catch { /* Peer may have closed first. */ }
    };
    const abort = () => {
      fail("internal MCP stream subscription cancelled", false);
      try { socket.close(1000, "outer stream closed"); } catch { /* socket may already be closing */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
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
    socket.addEventListener("close", (event) => {
      const code = Number((event as CloseEvent | undefined)?.code ?? 0);
      fail("internal MCP stream subscription closed before terminal result", code !== 1008);
    });
    socket.addEventListener("error", () => {
      fail("internal MCP stream subscription failed", true);
      try { socket.close(1011, "subscription transport failed"); } catch { /* socket may already be closing */ }
    });
  });
}

export function jsonRpcMessage(value: unknown): JsonRpcMessage {
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
