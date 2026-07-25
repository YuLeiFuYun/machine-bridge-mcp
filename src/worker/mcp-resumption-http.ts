import type { AuthorizedToken } from "./oauth-controller.ts";
import { resolveMcpSession } from "./mcp-session.ts";
import { acceptsEventStream, resumeJsonRpcResponse } from "./mcp-stream.ts";
import type { McpResumptionStore } from "./mcp-resumption.ts";
import { json } from "./http.ts";

export async function handleMcpResumptionRequest(input: {
  request: Request;
  authorized: AuthorizedToken;
  identityKey: string;
  supportedVersions: readonly string[];
  resumption: McpResumptionStore;
  keepAlive: (promise: Promise<void>) => void;
}): Promise<Response> {
  if (!acceptsEventStream(input.request)) return json({ error: "event_stream_required" }, 406);
  const protocolVersion = input.request.headers.get("MCP-Protocol-Version");
  if (protocolVersion && !input.supportedVersions.includes(protocolVersion)) {
    return json({
      error: "unsupported_protocol_version",
      requested: protocolVersion,
      supported: [...input.supportedVersions],
    }, 400);
  }
  const session = await resolveMcpSession(
    input.request,
    "stream/resume",
    input.identityKey,
    input.authorized.tokenKey,
  );
  if (session.kind === "invalid") return json({ error: "mcp_session_not_found" }, 404);
  const resumed = await input.resumption.resume({
    lastEventId: input.request.headers.get("Last-Event-ID")?.trim() ?? "",
    tokenKey: input.authorized.tokenKey,
    sessionId: session.sessionId,
  });
  switch (resumed.kind) {
    case "invalid": return json({ error: "invalid_last_event_id" }, 400);
    case "not_found": return json({ error: "stream_not_found" }, 404);
    case "expired": return json({ error: "stream_expired" }, 410);
    case "complete": return resumeJsonRpcResponse(null, { streamId: resumed.streamId });
    case "message": return resumeJsonRpcResponse(resumed.message, {
      streamId: resumed.streamId,
      keepAlive: input.keepAlive,
    });
  }
}
