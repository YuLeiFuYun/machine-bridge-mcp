export function jsonRpcResponseStream(
  result: Promise<Record<string, unknown>>,
  options: { onCancel: () => void; onError: (error: unknown) => Record<string, unknown> },
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
