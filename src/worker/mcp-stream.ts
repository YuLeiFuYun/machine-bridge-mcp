import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { streamEventId, type JsonRpcMessage } from "./mcp-resumption.ts";

const DEFAULT_HEARTBEAT_MS = relayContract.streamHeartbeatMs;

type IntervalHandle = ReturnType<typeof setInterval>;

type StreamScheduler = {
  setInterval: (callback: () => void, delay: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
};

type StreamResponseOptions = {
  heartbeatMs?: number;
  streamId: string;
  scheduler?: StreamScheduler;
  keepAlive?: (promise: Promise<void>) => void;
};

export function acceptsEventStream(request: Pick<Request, "headers">): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";").map((value) => value.trim().toLowerCase());
    if (mediaType !== "text/event-stream") return false;
    const quality = parameters.find((value) => value.startsWith("q="));
    if (!quality) return true;
    const parsed = Number(quality.slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}

export function streamJsonRpcResponse(
  result: Promise<JsonRpcMessage>,
  options: StreamResponseOptions,
): Response {
  return createEventStream(result, options, `id: ${streamEventId(options.streamId, 0)}\ndata:\n\n`);
}

export function resumeJsonRpcResponse(
  result: Promise<JsonRpcMessage> | null,
  options: StreamResponseOptions,
): Response {
  if (!result) return closedEventStreamResponse();
  return createEventStream(result, options, ": resumed\n\n");
}

function createEventStream(
  result: Promise<JsonRpcMessage>,
  options: StreamResponseOptions,
  initialFrame: string,
): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const scheduler = options.scheduler ?? { setInterval, clearInterval };
  let interval: IntervalHandle | undefined;
  let writable = true;

  const completion = result.then(() => undefined, () => undefined);
  options.keepAlive?.(completion);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (value: string): boolean => {
        if (!writable) return false;
        try {
          controller.enqueue(encoder.encode(value));
          return true;
        } catch {
          writable = false;
          return false;
        }
      };
      const stop = () => {
        if (interval !== undefined) scheduler.clearInterval(interval);
        interval = undefined;
      };
      const close = () => {
        stop();
        if (!writable) return;
        writable = false;
        try { controller.close(); } catch { /* Client disconnect is not MCP cancellation. */ }
      };

      enqueue(initialFrame);
      interval = scheduler.setInterval(() => {
        enqueue(": keepalive\n\n");
      }, heartbeatMs);

      void result.then(
        (message) => {
          if (message !== null) {
            enqueue(`id: ${streamEventId(options.streamId, 1)}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
          }
          close();
        },
        () => close(),
      );
    },
    cancel() {
      writable = false;
      if (interval !== undefined) scheduler.clearInterval(interval);
      interval = undefined;
      // Streamable HTTP disconnect is not cancellation. The operation remains
      // alive through keepAlive and can only be cancelled by MCP notification.
    },
  });

  return eventStreamResponse(body);
}

function closedEventStreamResponse(): Response {
  return eventStreamResponse(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
}

function eventStreamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
