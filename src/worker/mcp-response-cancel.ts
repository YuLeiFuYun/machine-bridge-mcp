import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { withProxyHeaders, type BridgeFetcher } from "./mcp-stream-proxy-contract.ts";

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
