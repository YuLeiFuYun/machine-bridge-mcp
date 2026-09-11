import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { PendingCallRecord } from "./pending-call-contract.ts";

type ReconnectSettlementRecord = Pick<PendingCallRecord, "originalDeadlineAt" | "deadlineAt">;

export function pendingCallReconnectSettlement(record: ReconnectSettlementRecord, now: number): { deadlineAt: number; remainingTimeoutMs: number } {
  // Execution and redelivery authority are bounded separately by the original execution budget.
  // This deadline only governs terminal-result delivery after reconnect, so the one-time delivery
  // grace may extend beyond the initial settlement ceiling without extending execution authority.
  const recoveryDeadlineAt = record.originalDeadlineAt + relayContract.reconnectResultDeliveryGraceMs;
  const deadlineAt = Math.max(record.deadlineAt, recoveryDeadlineAt);
  return { deadlineAt, remainingTimeoutMs: Math.max(1, Math.ceil(deadlineAt - now)) };
}
