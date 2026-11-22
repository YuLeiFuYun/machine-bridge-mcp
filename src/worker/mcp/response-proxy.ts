import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { MCP_PROTOCOL_VERSION } from "../../shared/mcp-protocol.mjs";
import { randomToken } from "../oauth/state.ts";
import { NATIVE_MCP_PATH } from "../room/http.ts";
import { acceptsEventStream } from "./http-contract.ts";

const HEARTBEAT_MS = Number(relayContract.streamHeartbeatMs);

const HEARTBEAT = new TextEncoder().encode(": heartbeat\n\n");

export async function proxyMcpResponseStream(input: {
  request: Request;
  bridge: BridgeFetcher;
  ctx: StreamExecutionContext;
}): Promise<Response | null> {
  const version = input.request.headers.get("MCP-Protocol-Version")?.trim() ?? "";
  if (new URL(input.request.url).pathname !== NATIVE_MCP_PATH
    || version !== MCP_PROTOCOL_VERSION
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
  let canEmitHeartbeat = true;
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
        if (closed || !canEmitHeartbeat) return;
        try { target.enqueue(HEARTBEAT); }
        catch { cancel("public response stream closed"); }
      }, HEARTBEAT_MS);
      void pumpUpstream(
        reader,
        target,
        finish,
        (reason) => cancel(reason, false),
        (chunk) => {
          if (chunk.byteLength > 0) {
            canEmitHeartbeat = chunkEndsWithSseFrameBoundary(chunk);
          }
        },
      );
    },
    cancel(reason) { cancel(reason); return cancellation; },
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

function chunkEndsWithSseFrameBoundary(chunk: Uint8Array): boolean {
  const len = chunk.byteLength;
  if (len >= 2 && chunk[len - 2] === 0x0a && chunk[len - 1] === 0x0a) return true;
  if (
    len >= 4
    && chunk[len - 4] === 0x0d
    && chunk[len - 3] === 0x0a
    && chunk[len - 2] === 0x0d
    && chunk[len - 1] === 0x0a
  ) return true;
  return false;
}

async function pumpUpstream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: ReadableStreamDefaultController<Uint8Array>,
  finish: () => boolean,
  cancel: (reason: unknown) => boolean,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<void> {
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (finish()) target.close();
        return;
      }
      onChunk?.(chunk.value);
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
const CANCEL_CONTROL_TIMEOUT_MS = Number(relayContract.streamCancelTimeoutMs);

export async function cancelMcpResponseStream(bridge: BridgeFetcher, request: Request, streamId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const control = new Request(request.url, { method: "POST" });
    const pending = Promise.resolve(bridge.fetch(withProxyHeaders(control, "cancel", streamId, controller.signal)))
      .then(() => undefined, () => undefined);
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort("private stream cancellation settlement timed out");
        resolve();
      }, CANCEL_CONTROL_TIMEOUT_MS);
    });
    await Promise.race([pending, deadline]);
  } catch {
    // The daemon call retains its bounded operation timeout if cancellation delivery fails.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const MCP_STREAM_PROXY_MODE_HEADER = "x-machine-bridge-internal-mcp-stream-mode";

export const MCP_STREAM_PROXY_ID_HEADER = "x-machine-bridge-internal-mcp-stream-id";

const STREAM_ID_PATTERN = /^stream_[A-Za-z0-9_-]{43}$/;

export type StreamProxyMode = "direct" | "cancel" | "";

export type BridgeFetcher = { fetch(request: Request): Promise<Response> };

export type StreamExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export function sanitizeBridgeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(MCP_STREAM_PROXY_MODE_HEADER);
  headers.delete(MCP_STREAM_PROXY_ID_HEADER);
  return new Request(request, { headers });
}

export function mcpStreamProxyMode(request: Pick<Request, "headers">): StreamProxyMode {
  const value = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER)?.trim().toLowerCase() ?? "";
  return value === "direct" || value === "cancel" ? value : "";
}

export function mcpStreamProxyId(request: Pick<Request, "headers">): string {
  const value = request.headers.get(MCP_STREAM_PROXY_ID_HEADER)?.trim() ?? "";
  return STREAM_ID_PATTERN.test(value) ? value : "";
}

export function mcpStreamRequestKey(streamId: string): string | undefined {
  return STREAM_ID_PATTERN.test(streamId) ? `stream:${streamId}` : undefined;
}

export function withProxyHeaders(
  request: Request,
  mode: Exclude<StreamProxyMode, "">,
  streamId = "",
  signal?: AbortSignal,
): Request {
  const sanitized = sanitizeBridgeRequest(request);
  const headers = new Headers(sanitized.headers);
  headers.set(MCP_STREAM_PROXY_MODE_HEADER, mode);
  if (streamId) {
    if (!STREAM_ID_PATTERN.test(streamId)) throw new Error("invalid MCP internal stream id");
    headers.set(MCP_STREAM_PROXY_ID_HEADER, streamId);
  }
  return new Request(sanitized, {
    method: mode === "cancel" ? "POST" : sanitized.method,
    headers,
    signal: signal ?? sanitized.signal,
  });
}
