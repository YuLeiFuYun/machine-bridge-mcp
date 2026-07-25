import type { PendingCallOutcome, PendingCallRecord } from "./pending-call-contract.ts";
import { PendingCallRegistrationError, PendingCallRegistry } from "./pending-calls.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { workerErrorClass } from "./http.ts";
import { rpcResult, textToolResult } from "./mcp-jsonrpc.ts";
import type { JsonRpcMessage, McpResumptionStore } from "./mcp-resumption.ts";
import { randomToken } from "./oauth-state.ts";
import type { WorkerObservability } from "./observability.ts";

export type StreamCallAuthorization = {
  account_id: string;
  account_version: number;
  client_id: string;
  family_id: string;
  role: string;
};

type StartStreamCallInput = {
  pending: PendingCallRegistry;
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  streamId: string;
  requestId: string | number;
  clientRequestKey?: string;
  tool: string;
  arguments: Record<string, unknown>;
  socket: WebSocket;
  daemonInstanceId: string;
  timeoutMs: number;
  authorization: StreamCallAuthorization;
  onTimeout: (record: PendingCallRecord) => Error;
  onSendFailure: () => void | Promise<void>;
  transformResult?: (value: unknown) => unknown;
};

type ImmediateOutcomeInput = {
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  streamId: string;
  requestId: string | number;
  outcome: PendingCallOutcome;
  transformResult?: (value: unknown) => unknown;
};

export function buildServerInfoResult(input: {
  serverName: string;
  serverVersion: string;
  base: string;
  oauth: Record<string, unknown>;
  authorization: Record<string, any>;
  daemon: Record<string, any>;
  tools: string[];
  pending: PendingCallRegistry;
  daemonRegistry: DaemonSocketRegistry;
  observability: WorkerObservability;
}): Record<string, unknown> {
  const probing = input.daemonRegistry.probingSockets().length;
  const ready = input.daemonRegistry.readySockets().length;
  const candidates = input.daemonRegistry.candidateSockets().length;
  return {
    name: input.serverName,
    version: input.serverVersion,
    mcp_url: `${input.base}/mcp`,
    oauth: input.oauth,
    account: input.authorization.account,
    authorization: input.authorization,
    authority_summary: input.authorization.summary,
    daemon: input.daemon,
    worker: {
      pending_calls: input.pending.snapshot(),
      daemon_candidates: candidates,
      daemon_probes: probing,
      sockets_live: {
        authenticated: input.daemonRegistry.readyRoleSockets().length + probing,
        ready,
        probing,
        candidates,
      },
      observability: input.observability.snapshot(),
    },
    tools: input.tools,
    tools_scope: "authenticated_account_effective_tools_before_host_filtering",
    tool_delivery: {
      full_profile_scope: "daemon-capability-ceiling-before-account-filtering",
      daemon_advertised_tool_count: input.daemon.tool_count,
      relay_advertised_tool_count: input.tools.length,
      effective_account_tool_count: input.tools.length,
      relay_advertised_scope: "authenticated_account_effective_tools_before_host_filtering",
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
    },
  };
}

export async function startEventDrivenStreamCall(input: StartStreamCallInput): Promise<void> {
  const callId = randomToken("call");
  const settle = createStreamSettlement({
    resumption: input.resumption,
    observability: input.observability,
    streamId: input.streamId,
    requestId: input.requestId,
    tool: input.tool,
    transformResult: input.transformResult,
  });
  try {
    input.pending.registerEvent({
      id: callId,
      socket: input.socket,
      daemonInstanceId: input.daemonInstanceId,
      clientRequestKey: input.clientRequestKey,
      tool: input.tool,
      timeoutMs: input.timeoutMs,
      onTimeout: input.onTimeout,
      settle,
    });
  } catch (error) {
    if (error instanceof PendingCallRegistrationError) throw new WorkerToolError(error.code, error.message, error.retryable);
    throw error;
  }
  input.resumption.activate(input.streamId);
  input.observability.callStarted(input.tool);
  try {
    input.socket.send(JSON.stringify({
      type: "tool_call",
      id: callId,
      tool: input.tool,
      arguments: input.arguments,
      timeout_ms: input.timeoutMs,
      authorization: input.authorization,
    }));
  } catch {
    await input.pending.reject(callId, new WorkerToolError("network_error", "failed to send daemon tool call", true), input.socket);
    await input.onSendFailure();
  }
}

export async function persistImmediateStreamOutcome(input: ImmediateOutcomeInput): Promise<void> {
  const message = streamTerminalMessage(input.requestId, input.outcome, input.transformResult);
  try {
    await input.resumption.complete(input.streamId, message);
  } catch (error) {
    input.observability.event("error", "mcp.stream.persist.failed", { error_class: workerErrorClass(error) });
  }
}

function createStreamSettlement(input: {
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  streamId: string;
  requestId: string | number;
  tool: string;
  transformResult?: (value: unknown) => unknown;
}): (outcome: PendingCallOutcome) => Promise<void> {
  return async (outcome) => {
    const normalized = normalizeOutcome(outcome, input.transformResult);
    const code = normalized.ok ? "" : publicWorkerToolError(normalized.error).code;
    const message = streamTerminalMessage(input.requestId, normalized);
    try {
      await input.resumption.complete(input.streamId, message);
    } catch (error) {
      input.observability.event("error", "mcp.stream.persist.failed", { error_class: workerErrorClass(error) });
    }
    input.observability.callFinished(input.tool, code);
  };
}

function streamTerminalMessage(
  requestId: string | number,
  outcome: PendingCallOutcome,
  transformResult?: (value: unknown) => unknown,
): JsonRpcMessage {
  const normalized = normalizeOutcome(outcome, transformResult);
  const result = normalized.ok
    ? textToolResult(normalized.value)
    : textToolResult({ error: publicWorkerToolError(normalized.error) }, true);
  const message = rpcResult(requestId, result);
  if (!message) throw new Error("streamed tool call requires a response id");
  return message;
}

function normalizeOutcome(outcome: PendingCallOutcome, transformResult?: (value: unknown) => unknown): PendingCallOutcome {
  if (!outcome.ok || !transformResult) return outcome;
  try { return { ok: true, value: transformResult(outcome.value) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error : new Error("stream result transformation failed") }; }
}
