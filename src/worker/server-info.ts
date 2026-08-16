import relayContract from "../shared/relay-contract.json" with { type: "json" };
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import type { WorkerObservability } from "./observability.ts";
import { hiddenWorkerActivity, hiddenWorkerPending, projectDaemonStatus, workerGlobalActivityVisible } from "./server-info-activity.ts";
export type ServerInfoDetail = "summary" | "full";

type ServerInfoInput = {
  serverName: string;
  serverVersion: string;
  base: string;
  oauth: Record<string, unknown>;
  authorization: Record<string, unknown>;
  daemon: Record<string, unknown>;
  effectiveTools: string[];
  advertisedTools: string[];
  pendingSnapshot: Record<string, unknown>;
  daemonRegistry: DaemonSocketRegistry;
  observability: WorkerObservability;
};

export function serverInfoDetail(args: Record<string, unknown> = {}): ServerInfoDetail {
  return args.detail === "summary" ? "summary" : "full";
}

export function buildServerInfoResult(input: ServerInfoInput, detail: ServerInfoDetail = "full"): Record<string, unknown> {
  const socketsLive = liveSocketSnapshot(input.daemonRegistry);
  const globalActivityVisible = workerGlobalActivityVisible(input.authorization);
  const daemon = projectDaemonStatus(input.daemon, globalActivityVisible);
  if (detail === "summary") return buildServerInfoSummary(input, socketsLive, globalActivityVisible);
  return {
    name: input.serverName,
    version: input.serverVersion,
    mcp_url: `${input.base}/mcp`,
    oauth: input.oauth,
    account: input.authorization.account,
    authorization: input.authorization,
    authority_summary: input.authorization.summary,
    daemon,
    worker: globalActivityVisible ? {
      pending_calls: input.pendingSnapshot,
      daemon_candidates: socketsLive.candidates,
      daemon_probes: socketsLive.probing,
      sockets_live: socketsLive,
      observability: input.observability.snapshot(),
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
): Record<string, unknown> {
  const authorization = input.authorization;
  return {
    detail: "summary",
    name: input.serverName,
    version: input.serverVersion,
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
      remote_foreground_execution_max_ms: relayContract.maximumInteractiveExecutionTimeoutMs,
      remote_process_foreground_execution_max_ms: relayContract.maximumProcessForegroundExecutionTimeoutMs,
      remote_default_tool_execution_max_ms: relayContract.defaultRemoteToolExecutionTimeoutMs, remote_process_poll_wait_max_ms: relayContract.maximumProcessReadWaitMs,
      worker_settlement_overhead_ms: relayContract.workerSettlementOverheadMs,
    },
  };
}

function liveSocketSnapshot(registry: DaemonSocketRegistry) {
  const probing = registry.probingSockets().length;
  const ready = registry.readySockets().length;
  const candidates = registry.candidateSockets().length;
  return {
    authenticated: registry.readyRoleSockets().length + probing,
    ready,
    probing,
    candidates,
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
    remote_foreground_execution_max_ms: relayContract.maximumInteractiveExecutionTimeoutMs,
    remote_process_foreground_execution_max_ms: relayContract.maximumProcessForegroundExecutionTimeoutMs,
    remote_default_tool_execution_max_ms: relayContract.defaultRemoteToolExecutionTimeoutMs, remote_process_poll_wait_max_ms: relayContract.maximumProcessReadWaitMs,
    worker_settlement_overhead_ms: relayContract.workerSettlementOverheadMs,
    daemon_execution_and_worker_settlement_deadlines_separate: true,
    host_terminal_receipt_observable: false,
  };
}
