import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "./errors.ts";
import type { PendingCallRecord } from "./pending-call-contract.ts";
import type { DaemonToolTimeoutBudget } from "./tool-timeout.ts";

export function daemonToolTimeoutBudgetAfterDelay(budget: DaemonToolTimeoutBudget, elapsedMs: number): DaemonToolTimeoutBudget {
  const elapsed = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  const settlementTimeoutMs = Math.max(0, budget.settlementTimeoutMs - elapsed);
  const executionTimeoutMs = Math.min(budget.executionTimeoutMs, settlementTimeoutMs - relayContract.workerSettlementOverheadMs);
  if (executionTimeoutMs < 1) {
    throw new WorkerToolError("unavailable", "local daemon recovery consumed the tool execution window; retry the call", true, { side_effects_started: false });
  }
  return Object.freeze({ executionTimeoutMs: Math.floor(executionTimeoutMs), settlementTimeoutMs: Math.floor(settlementTimeoutMs) });
}

export function daemonReconnectExpiry(record: Pick<PendingCallRecord, "remainingTimeoutMs">, reconnectGraceMs: number) {
  const grace = Math.min(relayContract.reconnectGraceMs, Math.max(1, Math.floor(reconnectGraceMs)));
  return record.remainingTimeoutMs < grace
    ? { reason: "original_call_deadline_expired_during_reconnect", message: "original call deadline expired during reconnect" }
    : { reason: "reconnect_grace_expired", message: "reconnect grace expired" };
}
