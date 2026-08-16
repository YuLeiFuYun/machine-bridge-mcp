import relayContract from "../shared/relay-contract.json" with { type: "json" };

export function remoteToolDeliveryContract(): Record<string, unknown> {
  return {
    remote_foreground_execution_max_ms: relayContract.maximumInteractiveExecutionTimeoutMs,
    remote_process_foreground_execution_max_ms: relayContract.maximumProcessForegroundExecutionTimeoutMs,
    remote_process_delivery_mode: "durable_job",
    remote_process_acceptance_max_ms: relayContract.durableProcessAcceptanceTimeoutMs,
    remote_process_execution_timeout_max_ms: relayContract.maximumDurableProcessExecutionTimeoutMs,
    remote_default_tool_execution_max_ms: relayContract.defaultRemoteToolExecutionTimeoutMs,
    remote_process_poll_wait_max_ms: relayContract.maximumProcessReadWaitMs,
    worker_settlement_overhead_ms: relayContract.workerSettlementOverheadMs,
  };
}
