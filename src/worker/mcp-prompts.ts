import { resolveSharedPromptOperation } from "../shared/prompt-projection.mjs";
import type { AuthorizedToken } from "./access.ts";
import { publicWorkerToolError } from "./errors.ts";
import { completeResult } from "../shared/mcp-protocol.mjs";
import { rpcError, rpcResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";

export type PromptToolInvoker = (input: {
  name: string;
  args: Record<string, unknown>;
  base: string;
  authorized: AuthorizedToken;
  signal: AbortSignal;
  requestKey?: string;
}) => Promise<unknown>;

export async function dispatchWorkerPromptOperation(
  request: JsonRpcRequest,
  invoker: PromptToolInvoker,
  base: string,
  authorized: AuthorizedToken,
  signal: AbortSignal,
  requestKey?: string,
  serverInfo?: Record<string, unknown>,
): Promise<{ status: number; message: Record<string, unknown> } | null> {
  const method = request.method;
  if (method !== "prompts/list" && method !== "prompts/get") return null;
  try {
    const resolved = await resolveSharedPromptOperation(
      method,
      request.params,
      (name, args) => invoker({ name, args, base, authorized, signal, requestKey }),
    );
    if (!resolved.ok) {
      return { status: 200, message: rpcError(request.id, resolved.code, resolved.message) };
    }
    return { status: 200, message: rpcResult(request.id, completeResult(resolved.value, serverInfo))! };
  } catch (error) {
    return { status: 200, message: rpcError(request.id, -32603, "Prompt operation failed", publicWorkerToolError(error)) };
  }
}
