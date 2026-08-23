import relayContract from "../shared/relay-contract.json" with { type: "json" };

export function managedJobReadTimeoutBudget(args: Record<string, unknown>): Readonly<{
  executionTimeoutMs: number;
  settlementTimeoutMs: number;
}> {
  const requestedWaitMs = typeof args.wait_ms === "number" && Number.isSafeInteger(args.wait_ms)
    ? args.wait_ms
    : relayContract.defaultManagedJobReadWaitMs;
  const waitMs = Math.max(0, Math.min(requestedWaitMs, relayContract.maximumManagedJobReadWaitMs));
  const executionTimeoutMs = waitMs + relayContract.managedJobReadExecutionHeadroomMs;
  const settlementTimeoutMs = Math.min(
    executionTimeoutMs + relayContract.workerSettlementOverheadMs,
    relayContract.maximumRelayToolTimeoutMs,
  );
  return Object.freeze({ executionTimeoutMs, settlementTimeoutMs });
}

export function managedJobReadArgumentsWithinExecutionBudget(
  args: Record<string, unknown>,
  executionTimeoutMs: number,
): Record<string, unknown> {
  const requestedWaitMs = typeof args.wait_ms === "number" && Number.isSafeInteger(args.wait_ms)
    ? Math.max(0, Math.min(args.wait_ms, relayContract.maximumManagedJobReadWaitMs))
    : relayContract.defaultManagedJobReadWaitMs;
  const executionMs = Number.isSafeInteger(executionTimeoutMs) ? Math.max(0, executionTimeoutMs) : 0;
  const availableWaitMs = Math.max(0, Math.min(
    relayContract.maximumManagedJobReadWaitMs,
    executionMs - relayContract.managedJobReadExecutionHeadroomMs,
  ));
  return requestedWaitMs <= availableWaitMs ? args : { ...args, wait_ms: availableWaitMs };
}

export function managedJobReadExecutionBudgetHasHeadroom(executionTimeoutMs: number): boolean {
  return Number.isSafeInteger(executionTimeoutMs)
    && executionTimeoutMs >= relayContract.managedJobReadExecutionHeadroomMs;
}
