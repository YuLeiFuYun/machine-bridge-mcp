import relayContract from "../shared/relay-contract.json" with { type: "json" };
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { MCP_DISCOVERY_TTL_MS, MCP_TOOL_LIST_TTL_MS } from "./worker-mcp-config.ts";
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "./mcp-subscription-contract.ts";
import { MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT } from "./pending-call-capacity.ts";

export function remoteToolDeliveryContract(
  serverVersion: string,
  subscription: Readonly<{ activeForAccount?: number; openedForAccount?: boolean }> = {},
): Record<string, unknown> {
  return {
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    tool_schema_server_version: String(serverVersion),
    discovery_ttl_ms: MCP_DISCOVERY_TTL_MS,
    tool_list_ttl_ms: MCP_TOOL_LIST_TTL_MS,
    host_visible_schema_known_to_server: false,
    host_schema_refresh_required_on_generation_change: true,
    tools_list_change_subscription_supported: true,
    tools_list_change_subscription_active_for_account: Math.max(0, Number(subscription.activeForAccount) || 0),
    tools_list_change_subscription_opened_for_account: subscription.openedForAccount === true,
    tools_list_change_subscription_client_receipt_observable: false,
    tools_list_change_subscription_lease_ms: MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS,
    host_turn_deadline_observable: false,
    managed_jobs_detached_from_mcp_response: true,
    remote_foreground_execution_max_ms: relayContract.maximumInteractiveExecutionTimeoutMs,
    remote_process_session_start_execution_max_ms: relayContract.processSessionStartExecutionTimeoutMs,
    remote_process_delivery_mode: "durable_job",
    remote_process_acceptance_max_ms: relayContract.durableProcessAcceptanceTimeoutMs,
    remote_process_execution_timeout_max_ms: relayContract.maximumDurableProcessExecutionTimeoutMs,
    managed_job_resource_admission_wait_max_ms: relayContract.maximumManagedJobResourceAdmissionWaitMs,
    remote_managed_job_read_wait_default_ms: relayContract.defaultManagedJobReadWaitMs,
    remote_managed_job_read_wait_max_ms: relayContract.maximumManagedJobReadWaitMs,
    remote_managed_job_read_nonterminal_progress_minimum_ms: relayContract.managedJobReadNonterminalProgressMinimumMs,
    remote_managed_job_read_concurrency_max_per_account: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT,
    remote_default_tool_execution_max_ms: relayContract.defaultRemoteToolExecutionTimeoutMs,
    remote_process_blocking_poll_wait_max_ms: relayContract.maximumProcessReadWaitMs,
    remote_process_blocking_poll_cooldown_ms: relayContract.remoteProcessBlockingPollCooldownMs,
    worker_settlement_overhead_ms: relayContract.workerSettlementOverheadMs,
  };
}

export function compactRemoteToolDeliveryContract(
  serverVersion: string,
  subscription: Readonly<{ activeForAccount?: number; openedForAccount?: boolean }> = {},
): Record<string, unknown> {
  const compact = { ...remoteToolDeliveryContract(serverVersion, subscription) };
  delete compact.remote_managed_job_read_nonterminal_progress_minimum_ms;
  return compact;
}
