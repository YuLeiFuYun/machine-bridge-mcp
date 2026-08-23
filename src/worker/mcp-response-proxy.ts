import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { MCP_PROTOCOL_VERSION } from "../shared/mcp-protocol.mjs";
import { cancelMcpResponseStream } from "./mcp-response-cancel.ts";
import { randomToken } from "./oauth-state.ts";
import { acceptsEventStream } from "./mcp-http-accept.ts";
import {
  withProxyHeaders, type BridgeFetcher, type StreamExecutionContext,
} from "./mcp-stream-proxy-contract.ts";

const HEARTBEAT_MS = Number(relayContract.streamHeartbeatMs);
const HEARTBEAT = new TextEncoder().encode(": heartbeat\n\n");

export async function proxyMcpResponseStream(input: {
  request: Request;
  bridge: BridgeFetcher;
  ctx: StreamExecutionContext;
}): Promise<Response | null> {
  const version = input.request.headers.get("MCP-Protocol-Version")?.trim() ?? "";
  if (version !== MCP_PROTOCOL_VERSION
    || input.request.method !== "POST"
    || !acceptsEventStream(input.request)) return null;

  const streamId = randomToken("stream");
  const upstreamController = new AbortController();
  let earlyAbortReason: unknown;
  const earlyAbort = () => {
    earlyAbortReason = input.request.signal.reason ?? "client request aborted";
    upstreamController.abort(earlyAbortReason);
  };
  input.request.signal.addEventListener("abort", earlyAbort, { once: true });
  if (input.request.signal.aborted) earlyAbort();

  let upstream: Response;
  try {
    upstream = await input.bridge.fetch(withProxyHeaders(
      input.request, "direct", streamId, upstreamController.signal,
    ));
  } catch (error) {
    input.request.signal.removeEventListener("abort", earlyAbort);
    if (earlyAbortReason !== undefined) input.ctx.waitUntil(cancelMcpResponseStream(input.bridge, input.request, streamId));
    throw error;
  }
  if (!upstream.body || !upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    input.request.signal.removeEventListener("abort", earlyAbort);
    if (earlyAbortReason !== undefined) input.ctx.waitUntil(cancelMcpResponseStream(input.bridge, input.request, streamId));
    return upstream;
  }

  const reader = upstream.body.getReader();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let publicTarget: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  const finish = () => {
    if (closed) return false;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    input.request.signal.removeEventListener("abort", abort);
    return true;
  };
  const closePublic = () => {
    if (!publicTarget) return;
    try { publicTarget.close(); } catch { /* The public response already closed. */ }
  };
  const cancel = (reason: unknown, closeResponse = true): boolean => {
    if (!finish()) return false;
    upstreamController.abort(reason);
    cancellation = Promise.allSettled([reader.cancel(reason), cancelMcpResponseStream(input.bridge, input.request, streamId)])
      .then(() => undefined)
      .finally(() => {
        releaseReaderQuietly(reader);
        if (closeResponse) closePublic();
      });
    input.ctx.waitUntil(cancellation);
    return true;
  };
  const abort = () => cancel(input.request.signal.reason ?? "client request aborted");
  input.request.signal.removeEventListener("abort", earlyAbort);
  input.request.signal.addEventListener("abort", abort, { once: true });
  if (earlyAbortReason !== undefined) cancel(earlyAbortReason);

  const body = new ReadableStream<Uint8Array>({
    start(target) {
      publicTarget = target;
      if (closed) {
        target.close();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed) return;
        try { target.enqueue(HEARTBEAT); }
        catch { cancel("public response stream closed"); }
      }, HEARTBEAT_MS);
      void pumpUpstream(reader, target, finish, (reason) => cancel(reason, false));
    },
    cancel(reason) { cancel(reason); return cancellation; },
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

async function pumpUpstream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: ReadableStreamDefaultController<Uint8Array>,
  finish: () => boolean,
  cancel: (reason: unknown) => boolean,
): Promise<void> {
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (finish()) target.close();
        return;
      }
      target.enqueue(chunk.value);
    }
  } catch (error) {
    if (!cancel(error)) return;
    try { target.error(error); } catch { /* The public response already closed. */ }
  } finally {
    releaseReaderQuietly(reader);
  }
}

function releaseReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { reader.releaseLock(); } catch { /* The reader may already be released by cancellation cleanup. */ }
}
