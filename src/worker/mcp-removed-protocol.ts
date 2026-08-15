import type { JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { rpcError } from "./mcp-jsonrpc.ts";
import { json } from "./http.ts";
import { MCP_REMOVED_PROTOCOL_MESSAGE, requestProtocolVersion } from "../shared/mcp-protocol.mjs";

export function removedProtocolResponse(
  request: Pick<Request, "headers">,
  body: JsonRpcRequest,
  supportedVersions: readonly string[],
): Response | null {
  if (body.method !== "initialize") {
    if (!request.headers.has("Mcp-Session-Id")) return null;
    const declaredVersion = requestProtocolVersion(body);
    if (declaredVersion && !supportedVersions.includes(declaredVersion)) return null;
  }
  return json(rpcError(body.id, -32601, MCP_REMOVED_PROTOCOL_MESSAGE, { supported: [...supportedVersions] }), 400);
}
