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
import { callIdForStreamId } from "./mcp-stream-call-identity.ts";
import type { TransactionAlarmMutation } from "./mcp-transaction-alarm.ts";
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
  createStream?: { tokenKey: string; sessionId: string };
};

export type StartStreamCallResult = Readonly<{
  kind: "initial" | "resume" | "conflict";
  streamId: string;
  operationDeadlineAt?: number;
  alarmMutation?: TransactionAlarmMutation;
}>;

type ImmediateOutcomeInput = {
  resumption: McpResumptionStore;
  observability: WorkerObservability;
  streamId: string;
  requestId: string | number;
  outcome: PendingCallOutcome;
  transformResult?: (value: unknown) => unknown;
};

export async function startEventDrivenStreamCall(input: StartStreamCallInput): Promise<StartStreamCallResult> {
  const callId = callIdForStreamId(input.streamId);
  let operationDeadlineAt: number | undefined;
  let alarmMutation: TransactionAlarmMutation | undefined;
  try {
    if (input.createStream) {
      const started = await input.resumption.beginCall({
        streamId: input.streamId, tokenKey: input.createStream.tokenKey, sessionId: input.createStream.sessionId, requestId: input.requestId,
        ...(input.clientRequestKey ? {
          clientRequestKey: input.clientRequestKey, requestFingerprint: input.requestFingerprint, tool: input.tool,
        } : {}),
        callId, daemonInstanceId: input.daemonInstanceId, connectionId: input.connectionId,
        tool: input.tool, timeoutMs: input.settlementTimeoutMs, transform: input.transform,
        transientSnapshot: input.transientSnapshot, maximumPendingCalls: input.maximumPendingCalls,
        reservedPendingCalls: input.reservedPendingCalls,
      });
      if (started.kind !== "initial") return started;
      operationDeadlineAt = started.operationDeadlineAt;
      alarmMutation = started.alarmMutation;
    } else {
      operationDeadlineAt = await input.resumption.calls.activate({
        streamId: input.streamId, callId, daemonInstanceId: input.daemonInstanceId, connectionId: input.connectionId,
        clientRequestKey: input.clientRequestKey, requestFingerprint: input.requestFingerprint, tool: input.tool,
        timeoutMs: input.settlementTimeoutMs, transform: input.transform, transientSnapshot: input.transientSnapshot,
        maximumPendingCalls: input.maximumPendingCalls, reservedPendingCalls: input.reservedPendingCalls,
      });
    }
  } catch (error) {
    if (error instanceof McpPendingCallLimitError) throw new WorkerToolError("limit_exceeded", error.message, true);
    if (error instanceof McpPendingCallConflictError) throw new WorkerToolError("conflict", error.message);
    throw error;
  }
  input.observability.callStarted(input.tool);
  try {
    input.socket.send(JSON.stringify({
      type: "tool_call", id: callId, tool: input.tool, arguments: input.arguments, timeout_ms: input.executionTimeoutMs,
      authorization: input.authorization,
    }));
  } catch {
    const error = new WorkerToolError("network_error", "failed to send daemon tool call", true);
    await input.resumption.calls.complete(callId, input.connectionId, streamTerminalMessage(input.requestId, { ok: false, error }));
    input.observability.callFinished(input.tool, error.code);
    await input.onSendFailure();
  }
  return { kind: "initial", streamId: input.streamId, operationDeadlineAt, alarmMutation };
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
