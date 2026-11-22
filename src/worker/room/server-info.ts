import type { DaemonRegistry } from "../daemon/registry.ts";
import { readyDaemonChannels } from "../daemon/channel.ts";
import type { WorkerObservability } from "./observability.ts";
import type { WorkerContinuityEvidence } from "../daemon/continuity-evidence.ts";
import { NATIVE_MCP_PATH, type McpResourcePath } from "./http.ts";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../mcp/subscriptions.ts";
import { MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT } from "./pending-calls.ts";
import { serverImplementation } from "../../shared/mcp-protocol.mjs";
import { MCP_TASK_EXTENSION_ID } from "../../shared/mcp-task-contract.mjs";
import { MCP_APP_MIME_TYPE, MCP_UI_EXTENSION_ID } from "../mcp/job-monitor.ts";

export type ServerInfoDetail = "summary" | "full";

type ServerInfoInput = {
  serverName: string;
  serverVersion: string;
  base: string;
  mcpPath?: McpResourcePath;
  subscriptionsSupported?: boolean;
  oauth: Record<string, unknown>;
  authorization: Record<string, unknown>;
  daemon: Record<string, unknown>;
  effectiveTools: string[];
  advertisedTools: string[];
  pendingSnapshot: Record<string, unknown>;
  toolListSubscription: Readonly<{ activeForAccount?: number; openedForAccount?: boolean }>;
  daemonRegistry: DaemonRegistry;
  observability: WorkerObservability; continuityEvidence?: WorkerContinuityEvidence;
  clientToolSchemaGeneration?: unknown;
};

export function serverInfoDetail(args: Record<string, unknown> = {}): ServerInfoDetail {
  return args.detail === "summary" ? "summary" : "full";
}

function buildWorkerSchemaDrift(clientGeneration: unknown): Record<string, unknown> | null {
  if (typeof clientGeneration !== "number" || !Number.isSafeInteger(clientGeneration) || clientGeneration < 1) {
    return null;
  }
  const serverGeneration = Number(serverMetadata.toolSchemaGeneration);
  return {
    client_generation: clientGeneration,
    server_generation: serverGeneration,
    drifted: clientGeneration !== serverGeneration,
  };
}

function buildWorkerAuthorityDelta(input: ServerInfoInput, globalActivityVisible: boolean): Record<string, unknown> {
  const effectiveSet = new Set(input.effectiveTools);
  const daemonTools = Array.isArray(input.daemon.tools) ? input.daemon.tools.map(String) : [];
  const omitted = daemonTools.filter((name) => !effectiveSet.has(name));
  const daemonToolCount = typeof input.daemon.tool_count === "number" ? input.daemon.tool_count : daemonTools.length;
  const effectiveDaemonToolCount = Array.isArray(input.daemon.tools)
    ? input.effectiveTools.filter((name) => daemonTools.includes(name)).length
    : input.effectiveTools.filter((name) => name !== "server_info" && !name.endsWith("_job_monitor")).length;
  const omittedCount = Array.isArray(input.daemon.tools)
    ? omitted.length
    : Math.max(0, daemonToolCount - effectiveDaemonToolCount);
  return {
    daemon_tool_count: daemonToolCount,
    effective_tool_count: input.effectiveTools.length,
    omitted_count: omittedCount,
    ...(globalActivityVisible
      ? { omitted_sample: omitted.slice(0, 16) }
      : { omitted_sample_hidden_by_authority: omittedCount > 0 }),
  };
}

export function buildServerInfoResult(input: ServerInfoInput, detail: ServerInfoDetail = "full"): Record<string, unknown> {
  const socketsLive = liveSocketSnapshot(input.daemonRegistry);
  const globalActivityVisible = workerGlobalActivityVisible(input.authorization);
  const daemon = projectDaemonStatus(input.daemon, globalActivityVisible);
  const schemaDrift = buildWorkerSchemaDrift(input.clientToolSchemaGeneration);
  const authorityDelta = buildWorkerAuthorityDelta(input, globalActivityVisible);
  if (detail === "summary") return buildServerInfoSummary(input, socketsLive, globalActivityVisible, schemaDrift, authorityDelta);
  return {
    name: input.serverName,
    version: input.serverVersion,
    mcp_url: `${input.base}${input.mcpPath ?? NATIVE_MCP_PATH}`,
    oauth: input.oauth,
    account: input.authorization.account,
    authorization: input.authorization,
    authority_summary: input.authorization.summary,
    authority_delta: authorityDelta,
    ...(schemaDrift ? { schema_drift: schemaDrift } : {}),
    daemon,
    worker: globalActivityVisible ? {
      pending_calls: input.pendingSnapshot,
      daemon_candidates: socketsLive.candidates,
      daemon_probes: socketsLive.probing,
      sockets_live: socketsLive,
      observability: input.observability.snapshot(), continuity_evidence: input.continuityEvidence ?? null,
    } : {
      pending_calls: hiddenWorkerPending(input.pendingSnapshot),
      sockets_live: hiddenWorkerActivity(),
      observability: hiddenWorkerActivity(),
    },
    tools: input.effectiveTools,
    tools_scope: "authenticated_account_effective_tools_before_host_filtering",
    tool_delivery: fullToolDelivery(input),
  };
}

function buildServerInfoSummary(
  input: ServerInfoInput,
  socketsLive: ReturnType<typeof liveSocketSnapshot>,
  globalActivityVisible: boolean,
  schemaDrift: Record<string, unknown> | null,
  authorityDelta: Record<string, unknown>,
): Record<string, unknown> {
  const authorization = input.authorization;
  const summaryAuthorityDelta = Number(authorityDelta.omitted_count) > 0
    ? {
      omitted_count: authorityDelta.omitted_count,
      ...(globalActivityVisible ? {} : { omitted_sample_hidden_by_authority: true }),
    }
    : null;
  return {
    detail: "summary",
    name: input.serverName,
    version: input.serverVersion,
    ...(summaryAuthorityDelta ? { authority_delta: summaryAuthorityDelta } : {}),
    ...(schemaDrift ? { schema_drift: schemaDrift } : {}),
    authorization: {
      account: compactAccount(authorization.account),
      effective_policy: authorization.effective_policy ?? null,
      effective_tool_count: authorization.effective_tool_count ?? input.effectiveTools.length,
      account_role_is_owner: authorization.account_role_is_owner === true,
      effective_profile_is_full: authorization.effective_profile_is_full === true,
      execution_model: compactExecutionModel(authorization.execution_model),
    },
    daemon: compactDaemon(input.daemon),
    worker: globalActivityVisible ? {
      pending_calls: compactPending(input.pendingSnapshot),
      sockets_live: socketsLive,
    } : {
      pending_calls: hiddenWorkerPending(input.pendingSnapshot),
      sockets_live: hiddenWorkerActivity(),
    },
    tool_delivery: {
      effective_account_tool_count: input.effectiveTools.length,
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
      ...compactRemoteToolDeliveryContract(input.serverVersion, input.toolListSubscription, {
        subscriptionsSupported: input.subscriptionsSupported,
      }),
    },
  };
}

function liveSocketSnapshot(registry: DaemonRegistry) {
  const probing = registry.probingSockets().length;
  const httpReady = typeof registry.httpReadyChannels === "function" ? registry.httpReadyChannels().length : 0;
  const ready = readyDaemonChannels(registry).length;
  const httpCandidates = typeof registry.httpCandidates === "function" ? registry.httpCandidates().length : 0;
  const candidates = registry.candidateSockets().length + httpCandidates;
  return {
    authenticated: registry.readyRoleSockets().length + httpReady + probing + httpCandidates,
    ready,
    probing,
    candidates,
    https_fallback_ready: httpReady,
    https_fallback_candidates: httpCandidates,
  };
}

function compactAccount(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const account = value as Record<string, unknown>;
  return { role: account.role ?? null, version: account.version ?? null };
}

function compactExecutionModel(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  return {
    within_effective_authority: model.within_effective_authority ?? null,
    owner_ambient_authority: model.owner_ambient_authority ?? null,
  };
}

function compactDaemon(value: Record<string, unknown>): Record<string, unknown> {
  return {
    connected: value.connected === true,
    count: value.count ?? 0,
    tool_count: value.tool_count ?? 0,
    connected_at: value.connected_at ?? null,
    last_seen_at: value.last_seen_at ?? null,
    readiness_verified: value.readiness_verified === true,
    readiness_timeout_ms: value.readiness_timeout_ms ?? null,
    liveness_timeout_ms: value.liveness_timeout_ms ?? null,
    relay_transport: value.relay_transport ?? null,
  };
}

function compactPending(value: Record<string, unknown>): Record<string, unknown> {
  return {
    active: value.active ?? 0,
    pre_dispatch_waiters: value.pre_dispatch_waiters ?? 0,
    capacity_active: value.capacity_active ?? value.active ?? 0,
    maximum: value.maximum ?? 0,
    ordinary_capacity: value.ordinary_capacity ?? 0,
    reserved_capacity: value.reserved_capacity ?? 0,
    active_ordinary: value.active_ordinary ?? 0,
    active_reserved: value.active_reserved ?? 0,
    capacity_active_ordinary: value.capacity_active_ordinary ?? value.active_ordinary ?? 0,
    capacity_active_reserved: value.capacity_active_reserved ?? value.active_reserved ?? 0,
    detached: value.detached ?? 0,
    oldest_ms: value.oldest_ms ?? 0,
  };
}

function fullToolDelivery(input: ServerInfoInput): Record<string, unknown> {
  return {
    full_profile_scope: "daemon-capability-ceiling-before-account-filtering",
    daemon_advertised_tool_count: input.daemon.tool_count,
    relay_advertised_tool_count: input.advertisedTools.length,
    effective_account_tool_count: input.effectiveTools.length,
    relay_advertised_scope: "stable_authenticated_account_catalog_before_host_filtering",
    effective_scope: "live_daemon_and_account_intersection_before_host_filtering",
    host_exposed_tools_known_to_server: false,
    host_may_expose_subset: true,
    ...remoteToolDeliveryContract(input.serverVersion, input.toolListSubscription, {
      subscriptionsSupported: input.subscriptionsSupported,
    }),
    daemon_execution_and_worker_settlement_deadlines_separate: true,
    host_terminal_receipt_observable: false,
  };
}
export function remoteToolDeliveryContract(
  serverVersion: string,
  subscription: Readonly<{ activeForAccount?: number; openedForAccount?: boolean }> = {},
  options: Readonly<{ subscriptionsSupported?: boolean }> = {},
): Record<string, unknown> {
  return {
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    tool_schema_server_version: String(serverVersion),
    discovery_ttl_ms: MCP_DISCOVERY_TTL_MS,
    tool_list_ttl_ms: MCP_TOOL_LIST_TTL_MS,
    host_visible_schema_known_to_server: false,
    host_schema_refresh_required_on_generation_change: true,
    tools_list_change_subscription_supported: options.subscriptionsSupported !== false,
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
    remote_process_initial_settlement_wait_ms: relayContract.durableProcessInitialSettlementWaitMs,
    remote_managed_job_initial_settlement_wait_ms: relayContract.durableProcessInitialSettlementWaitMs,
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
  options: Readonly<{ subscriptionsSupported?: boolean }> = {},
): Record<string, unknown> {
  const compact = { ...remoteToolDeliveryContract(serverVersion, subscription, options) };
  delete compact.remote_managed_job_read_nonterminal_progress_minimum_ms;
  delete compact.remote_process_initial_settlement_wait_ms;
  delete compact.remote_managed_job_initial_settlement_wait_ms;
  delete compact.remote_process_blocking_poll_wait_max_ms;
  return compact;
}
function workerGlobalActivityVisible(authorization: { account_role_is_owner?: unknown }): boolean {
  return authorization.account_role_is_owner === true;
}

function hiddenWorkerPending(value: Record<string, unknown>): Record<string, unknown> {
  return {
    maximum: value.maximum ?? 0,
    ordinary_capacity: value.ordinary_capacity ?? 0,
    reserved_capacity: value.reserved_capacity ?? 0,
    activity_hidden_by_authority: true,
  };
}

function hiddenWorkerActivity(): Record<string, unknown> {
  return { activity_hidden_by_authority: true };
}

function projectDaemonStatus(value: Record<string, unknown>, fullToolNamesVisible: boolean): Record<string, unknown> {
  if (fullToolNamesVisible) return value;
  return {
    connected: value.connected ?? false,
    count: value.count ?? 0,
    tool_count: value.tool_count ?? 0,
    connected_at: value.connected_at ?? null,
    last_seen_at: value.last_seen_at ?? null,
    readiness_verified: value.readiness_verified ?? false,
    readiness_timeout_ms: value.readiness_timeout_ms ?? null,
    liveness_timeout_ms: value.liveness_timeout_ms ?? null,
    policy: value.policy ?? null,
    policy_scope: value.policy_scope ?? "daemon_capability_ceiling_not_account_authority",
    tools: [],
    tools_scope: value.tools_scope ?? "daemon_advertised_before_account_role_filtering",
    tools_hidden_by_authority: true,
    relay_transport: value.relay_transport ?? null,
  };
}
export const SERVER_NAME = String(serverMetadata.name);

export const MCP_PROTOCOL_VERSIONS = Object.freeze(
  serverMetadata.supportedProtocolVersions.map((value) => String(value)),
);

export const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");

export const MCP_SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({ listChanged: true }),
  prompts: Object.freeze({ listChanged: false }),
  resources: Object.freeze({}),
  extensions: Object.freeze({
    [MCP_TASK_EXTENSION_ID]: Object.freeze({}),
    [MCP_UI_EXTENSION_ID]: Object.freeze({ mimeTypes: Object.freeze([MCP_APP_MIME_TYPE]) }),
  }),
});

export const MCP_DISCOVERY_TTL_MS = 0;

// Tool descriptions carry execution/orchestration semantics. Do not advertise a
// reusable tools/list cache across package/Worker replacement; a host that asks
// again should always receive the current schema/description set.
export const MCP_TOOL_LIST_TTL_MS = 0;

export function mcpServerInfo(version: string): Readonly<Record<string, unknown>> {
  return Object.freeze(serverImplementation({
    name: SERVER_NAME,
    title: "Machine Bridge MCP",
    version,
    description: "Workspace-scoped local coding tools over authenticated remote relay.",
  }));
}
