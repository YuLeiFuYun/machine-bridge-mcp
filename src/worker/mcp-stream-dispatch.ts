import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import type { JsonRpcMessage, McpResumptionStore } from "./mcp-resumption.ts";
import {
  McpPendingCallConflictError,
  McpPendingCallLimitError,
} from "./mcp-pending-call-store.ts";
import type { PendingStreamTransform } from "./mcp-pending-call-records.ts";
import { publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { workerErrorClass } from "./http.ts";
import { rpcResult, textToolResult } from "./mcp-jsonrpc.ts";
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
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  streamId: string;
  requestId: string | number;
  clientRequestKey?: string;
  requestFingerprint?: string;
  tool: string;
  arguments: Record<string, unknown>;
  socket: WebSocket;
  daemonInstanceId: string;
  connectionId: string;
  executionTimeoutMs: number;
  settlementTimeoutMs: number;
  authorization: StreamCallAuthorization;
  transientSnapshot: { active: number; by_tool: Record<string, number> };
  maximumPendingCalls: number;
  reservedPendingCalls?: number;
  transform?: PendingStreamTransform;
  onSendFailure: () => void | Promise<void>;
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
  effectiveTools: string[];
  advertisedTools: string[];
  pendingSnapshot: Record<string, unknown>;
  daemonRegistry: import("./daemon-sockets.ts").DaemonSocketRegistry;
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
      pending_calls: input.pendingSnapshot,
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
    tools: input.effectiveTools,
    tools_scope: "authenticated_account_effective_tools_before_host_filtering",
    tool_delivery: {
      full_profile_scope: "daemon-capability-ceiling-before-account-filtering",
      daemon_advertised_tool_count: input.daemon.tool_count,
      relay_advertised_tool_count: input.advertisedTools.length,
      effective_account_tool_count: input.effectiveTools.length,
      relay_advertised_scope: "stable_authenticated_account_catalog_before_host_filtering",
      effective_scope: "live_daemon_and_account_intersection_before_host_filtering",
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
      remote_foreground_execution_max_ms: relayContract.maximumInteractiveExecutionTimeoutMs,
      worker_settlement_overhead_ms: relayContract.workerSettlementOverheadMs,
      daemon_execution_and_worker_settlement_deadlines_separate: true,
      host_terminal_receipt_observable: false,
      internal_stream_metrics_scope: "legacy resumable Worker-internal storage and subscription transport only",
    },
  };
}

export async function startEventDrivenStreamCall(input: StartStreamCallInput): Promise<void> {
  const callId = randomToken("call");
  try {
    await input.resumption.calls.activate({
      streamId: input.streamId,
      callId,
      daemonInstanceId: input.daemonInstanceId,
      connectionId: input.connectionId,
      clientRequestKey: input.clientRequestKey,
      requestFingerprint: input.requestFingerprint,
      tool: input.tool,
      timeoutMs: input.settlementTimeoutMs,
      transform: input.transform,
      transientSnapshot: input.transientSnapshot,
      maximumPendingCalls: input.maximumPendingCalls,
      reservedPendingCalls: input.reservedPendingCalls,
    });
  } catch (error) {
    if (error instanceof McpPendingCallLimitError) {
      throw new WorkerToolError("limit_exceeded", error.message, true);
    }
    if (error instanceof McpPendingCallConflictError) {
      throw new WorkerToolError("conflict", error.message);
    }
    throw error;
  }
  input.observability.callStarted(input.tool);
  try {
    input.socket.send(JSON.stringify({
      type: "tool_call",
      id: callId,
      tool: input.tool,
      arguments: input.arguments,
      timeout_ms: input.executionTimeoutMs,
      authorization: input.authorization,
    }));
  } catch {
    const error = new WorkerToolError("network_error", "failed to send daemon tool call", true);
    await input.resumption.calls.complete(callId, input.connectionId, streamTerminalMessage(input.requestId, { ok: false, error }));
    input.observability.callFinished(input.tool, error.code);
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

export function streamTerminalMessage(
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

export function normalizeOutcome(
  outcome: PendingCallOutcome,
  transformResult?: (value: unknown) => unknown,
): PendingCallOutcome {
  if (!outcome.ok || !transformResult) return outcome;
  try { return { ok: true, value: transformResult(outcome.value) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error : new Error("stream result transformation failed") }; }
}
