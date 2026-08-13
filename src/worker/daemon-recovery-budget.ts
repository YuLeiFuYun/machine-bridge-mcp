import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "./errors.ts";
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
