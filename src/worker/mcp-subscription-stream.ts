export function closedSubscriptionResponse(
  acknowledged: Record<string, unknown>,
  completed: Record<string, unknown>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage(acknowledged)));
      controller.enqueue(encoder.encode(sseMessage(completed)));
      controller.close();
    },
  });
  return eventStreamResponse(body);
}

export function openSubscriptionResponse(
  acknowledged: Record<string, unknown>,
  initialMessages: readonly Record<string, unknown>[],
  signal: AbortSignal,
  onClose: () => void = () => {},
): Response {
  const encoder = new TextEncoder();
  let writable = true;
  let finalized = false;
  let removeAbort = () => {};
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    try { onClose(); } catch { /* Subscription accounting cleanup must not corrupt stream settlement. */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage(acknowledged)));
      for (const message of initialMessages) controller.enqueue(encoder.encode(sseMessage(message)));
      const abort = () => {
        if (!writable) return;
        writable = false;
        try { controller.close(); } catch { /* The client already closed the subscription stream. */ }
        finalize();
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    },
    cancel() {
      if (!writable) return;
      writable = false;
      removeAbort();
      finalize();
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
