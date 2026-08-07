import { json, workerErrorClass } from "./http.ts";
import { inspectWorkerToolCall } from "./mcp-tool-call-input.ts";
import { rpcError, type JsonRpcRequest } from "./mcp-jsonrpc.ts";
import { workerToolRequestFingerprint } from "./mcp-request-fingerprint.ts";
import { legacyMcpClientRequestKey } from "./mcp-session.ts";
import {
  persistImmediateStreamOutcome,
} from "./mcp-stream-dispatch.ts";
import { mcpStreamDescriptorResponse, type StreamProxyMode } from "./mcp-stream-proxy.ts";
import { McpStreamLimitError, type McpResumptionStore } from "./mcp-resumption.ts";
import { randomToken } from "./oauth-state.ts";
import type { AuthorizedToken } from "./oauth-controller.ts";
import type { WorkerObservability } from "./observability.ts";
import type { PendingAdmissionGate } from "./pending-admission.ts";

export type LegacyWorkspaceStreamCallInput = Readonly<{
  streamId: string;
  requestId: string | number;
  requestKey?: string;
  requestFingerprint: string;
  name: string;
  args: Record<string, unknown>;
  authorized: AuthorizedToken;
}>;

type PrepareDependencies = Readonly<{
  advertisedTools: readonly Readonly<{ name?: unknown }>[];
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  admission: PendingAdmissionGate;
  serverInfo: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  dispatchWorkspaceCall: (input: LegacyWorkspaceStreamCallInput) => Promise<void>;
}>;

export async function prepareLegacyStreamedToolCall(
  input: Readonly<{
    body: JsonRpcRequest;
    authorized: AuthorizedToken;
    sessionId: string;
    proxyMode: StreamProxyMode;
  }>,
  dependencies: PrepareDependencies,
): Promise<Response> {
  const { body, authorized, sessionId, proxyMode } = input;
  if (proxyMode !== "prepare") return json(rpcError(body.id, -32603, "MCP stream proxy is unavailable"), 500);
  if (body.id === undefined || body.id === null) {
    return json(rpcError(null, -32600, "tools/call requires a non-null request id"), 400);
  }

  const requestId = body.id;
  const inspected = inspectWorkerToolCall(body.params, dependencies.advertisedTools);
  if (!inspected.ok) return invalidToolCallResponse(requestId, inspected);
  const { name, args } = inspected;
  const requestKey = legacyMcpClientRequestKey(authorized.tokenKey, sessionId, requestId);
  const requestFingerprint = await workerToolRequestFingerprint(name, args);

  try {
    const prepared = await dependencies.admission.run(async (): Promise<
      { kind: "initial" | "resume"; streamId: string } | { kind: "conflict" }
    > => {
      const existing = requestKey ? await dependencies.resumption.findByRequestKey(requestKey) : undefined;
      if (existing) {
        const compatible = existing.tool === name
          && (!existing.requestFingerprint || existing.requestFingerprint === requestFingerprint);
        return compatible ? { kind: "resume", streamId: existing.streamId } : { kind: "conflict" };
      }

      const streamId = randomToken("stream");
      await dependencies.resumption.begin({
        streamId,
        tokenKey: authorized.tokenKey,
        sessionId,
        requestId,
        ...(requestKey ? {
          clientRequestKey: requestKey,
          requestFingerprint,
          tool: name,
        } : {}),
      });
      try {
        if (name === "server_info") {
          await persistImmediateStreamOutcome({
            resumption: dependencies.resumption,
            observability: dependencies.observability,
            streamId,
            requestId,
            outcome: { ok: true, value: await dependencies.serverInfo(args) },
          });
        } else {
          await dependencies.dispatchWorkspaceCall({
            streamId,
            requestId,
            requestKey,
            requestFingerprint,
            name,
            args,
            authorized,
          });
        }
      } catch (error) {
        await persistImmediateStreamOutcome({
          resumption: dependencies.resumption,
          observability: dependencies.observability,
          streamId,
          requestId,
          outcome: { ok: false, error: error instanceof Error ? error : new Error("streamed tool call failed") },
        });
      }
      return { kind: "initial", streamId };
    });

    if (prepared.kind === "conflict") {
      return json(rpcError(requestId, -32600, "request id is already active with different tool arguments", {
        side_effects_started: true,
        retryable: false,
      }), 409);
    }
    return mcpStreamDescriptorResponse(prepared.kind, prepared.streamId);
  } catch (error) {
    return streamPreparationFailure(requestId, error, dependencies.observability);
  }
}

function invalidToolCallResponse(
  requestId: string | number,
  inspected: Exclude<ReturnType<typeof inspectWorkerToolCall>, { ok: true }>,
): Response {
  const message = inspected.reason === "missing_name" ? "tools/call requires a tool name"
    : inspected.reason === "unknown_tool" ? "Unknown tool"
      : "Tool arguments do not match the input schema";
  return json(rpcError(requestId, -32602, message, inspected.issues ? {
    side_effects_started: false,
    validation_issues: [...inspected.issues],
  } : undefined), 400);
}

function streamPreparationFailure(
  requestId: string | number,
  error: unknown,
  observability: WorkerObservability,
): Response {
  if (error instanceof McpStreamLimitError) return json(rpcError(requestId, -32004, error.message), 429);
  observability.event("error", "mcp.stream.begin.failed", { error_class: workerErrorClass(error) });
  return json(rpcError(requestId, -32603, "Resumable stream storage is unavailable"), 503);
}
