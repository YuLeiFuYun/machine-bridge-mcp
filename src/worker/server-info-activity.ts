export function workerGlobalActivityVisible(authorization: { account_role_is_owner?: unknown }): boolean {
  return authorization.account_role_is_owner === true;
}

export function hiddenWorkerPending(value: Record<string, unknown>): Record<string, unknown> {
  return {
    maximum: value.maximum ?? 0,
    ordinary_capacity: value.ordinary_capacity ?? 0,
    reserved_capacity: value.reserved_capacity ?? 0,
    activity_hidden_by_authority: true,
  };
}

export function hiddenWorkerActivity(): Record<string, unknown> {
  return { activity_hidden_by_authority: true };
}

export function projectDaemonStatus(value: Record<string, unknown>, fullToolNamesVisible: boolean): Record<string, unknown> {
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
