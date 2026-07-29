import { subscriptionAcknowledgedNotification, subscriptionCompleteResult } from "../shared/mcp-subscriptions.mjs";
import { rpcResult, type JsonRpcId } from "./mcp-jsonrpc.ts";

export function modernSubscriptionResponse(input: {
  requestId: Exclude<JsonRpcId, null>;
  notifications: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
}): Response {
  const encoder = new TextEncoder();
  const acknowledged = subscriptionAcknowledgedNotification(input.requestId, input.notifications);
  const complete = rpcResult(input.requestId, subscriptionCompleteResult(input.requestId, input.serverInfo));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage(acknowledged)));
      controller.enqueue(encoder.encode(sseMessage(complete)));
      controller.close();
    },
  });
  return modernEventStreamResponse(body);
}

export function modernJsonRpcResponseStream(
  result: Promise<Record<string, unknown>>,
  options: { onCancel: () => void; onError: (error: unknown) => Record<string, unknown> },
): Response {
  const encoder = new TextEncoder();
  let writable = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      void result.then(
        (message) => {
          if (!writable) return;
          try { controller.enqueue(encoder.encode(sseMessage(message))); } catch { writable = false; }
          if (!writable) return;
          writable = false;
          try { controller.close(); } catch { /* Client already closed the response stream. */ }
        },
        (error) => {
          if (!writable) return;
          try { controller.enqueue(encoder.encode(sseMessage(options.onError(error)))); } catch { writable = false; }
          if (!writable) return;
          writable = false;
          try { controller.close(); } catch { /* Client already closed the response stream. */ }
        },
      );
    },
    cancel() {
      if (!writable) return;
      writable = false;
      options.onCancel();
    },
  });
  return modernEventStreamResponse(body);
}

function modernEventStreamResponse(body: ReadableStream<Uint8Array>): Response {
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
