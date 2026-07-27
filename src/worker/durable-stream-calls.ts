import { daemonLastSeenMs } from "./daemon-liveness.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import { publicWorkerToolError, WorkerToolError } from "./errors.ts";
import { workerErrorClass } from "./http.ts";
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import type { McpPendingCallStore, PendingStreamCallView } from "./mcp-pending-call-store.ts";
import { streamTerminalMessage } from "./mcp-stream-dispatch.ts";
import { transformDurableStreamOutcome } from "./durable-stream-result.ts";
import type { WorkerObservability } from "./observability.ts";
import { sendWebSocketQuietly } from "./websocket-protocol.ts";

type InvalidateDaemonSocket = (
  socket: WebSocket,
  message: string,
  closeReason: string,
  errorCode?: string,
) => Promise<void>;

type TransientPendingSnapshot = {
  active: number;
  detached: number;
  request_keys: number;
  oldest_ms: number;
  by_tool: Record<string, number>;
};

export class DurableStreamCallCoordinator {
  private readonly calls: McpPendingCallStore;
  private readonly daemonRegistry: DaemonSocketRegistry;
  private readonly observability: WorkerObservability;
  private readonly maximumPendingCalls: number;
  private readonly invalidateDaemonSocket: InvalidateDaemonSocket;

  constructor(
    calls: McpPendingCallStore,
    daemonRegistry: DaemonSocketRegistry,
    observability: WorkerObservability,
    maximumPendingCalls: number,
    invalidateDaemonSocket: InvalidateDaemonSocket,
  ) {
    this.calls = calls;
    this.daemonRegistry = daemonRegistry;
    this.observability = observability;
    this.maximumPendingCalls = maximumPendingCalls;
    this.invalidateDaemonSocket = invalidateDaemonSocket;
  }

  async snapshot(transient: TransientPendingSnapshot): Promise<Record<string, unknown>> {
    const durable = await this.calls.snapshot(this.maximumPendingCalls);
    const byTool = Object.assign(Object.create(null) as Record<string, number>, transient.by_tool);
    for (const [tool, count] of Object.entries(durable.by_tool)) byTool[tool] = (byTool[tool] ?? 0) + count;
    return {
      active: transient.active + durable.active,
      detached: transient.detached + durable.detached,
      request_keys: transient.request_keys + durable.request_keys,
      maximum: this.maximumPendingCalls,
      oldest_ms: Math.max(transient.oldest_ms, durable.oldest_ms),
      by_tool: byTool,
      transient: transient.active,
      durable_streams: durable.active,
    };
  }

  async settle(
    callId: string,
    connectionId: string,
    outcome: PendingCallOutcome,
    knownCall?: PendingStreamCallView,
  ): Promise<boolean> {
    const call = knownCall ?? await this.calls.get(callId);
    if (!call || call.connection_id !== connectionId) return false;
    const normalized = transformDurableStreamOutcome(call, outcome);
    const code = normalized.ok ? "" : publicWorkerToolError(normalized.error).code;
    try {
      const completed = await this.calls.complete(
        callId,
        connectionId,
        streamTerminalMessage(call.requestId, normalized),
      );
      if (!completed) return false;
    } catch (error) {
      this.observability.event("error", "mcp.stream.persist.failed", { error_class: workerErrorClass(error) });
    }
    this.observability.callFinished(call.tool, code);
    return true;
  }

  async expire(call: PendingStreamCallView): Promise<void> {
    const socket = call.state === "attached" ? this.daemonRegistry.socketForConnectionId(call.connection_id) : undefined;
    if (socket) {
      sendWebSocketQuietly(socket, { type: "cancel_call", id: call.call_id });
      const silentForMs = Date.now() - daemonLastSeenMs(this.daemonRegistry.readyAttachment(socket));
      if (!Number.isFinite(silentForMs) || silentForMs > 45_000) {
        void this.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout");
      }
    }
    const error = call.state === "attached"
      ? new WorkerToolError("timeout", `daemon tool timed out: ${call.tool}`, true)
      : new WorkerToolError("unavailable", "daemon disconnected; reconnect grace expired", true);
    await this.settle(call.call_id, call.connection_id, { ok: false, error }, call);
  }

  async expireDue(now = Date.now()): Promise<number> {
    const due = await this.calls.due(now);
    for (const call of due) await this.expire(call);
    return due.length;
  }

  async cancel(requestKey: string): Promise<boolean> {
    const call = await this.calls.getByRequestKey(requestKey);
    if (!call) return false;
    const socket = call.state === "attached" ? this.daemonRegistry.socketForConnectionId(call.connection_id) : undefined;
    if (socket) sendWebSocketQuietly(socket, { type: "cancel_call", id: call.call_id });
    return this.settle(
      call.call_id,
      call.connection_id,
      { ok: false, error: new WorkerToolError("cancelled", "tool call cancelled by client") },
      call,
    );
  }

  detach(connectionId: string, graceMs: number): Promise<number> {
    return this.calls.detach(connectionId, graceMs);
  }

  rebind(daemonInstanceId: string, connectionId: string): Promise<string[]> {
    return this.calls.rebind(daemonInstanceId, connectionId);
  }
}
