// @ts-check
import { compactRuntimeRelay } from "./runtime-info-relay-projection.mjs";

export function projectRuntimeInfo(info, detail = "full") {
  if (detail !== "summary") return info;
  const runtime = record(info.runtime);
  const delivery = record(info.tool_delivery);
  const policy = record(info.policy);
  return {
    detail: "summary",
    name: info.name,
    protocol_version: info.protocol_version,
    workspace: info.workspace,
    workspace_name: info.workspace_name,
    policy,
    tool_delivery: {
      effective_tool_count: delivery.effective_tool_count ?? 0,
      daemon_advertised_tool_count: delivery.daemon_advertised_tool_count ?? 0,
      tool_schema_generation: delivery.tool_schema_generation ?? null,
      discovery_ttl_ms: delivery.discovery_ttl_ms ?? null,
      tool_list_ttl_ms: delivery.tool_list_ttl_ms ?? null,
      host_turn_deadline_observable: false,
      managed_jobs_detached_from_mcp_response: delivery.managed_jobs_detached_from_mcp_response === true,
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
    },
    runtime: {
      lifecycle: runtime.lifecycle ?? null,
      relay: compactRuntimeRelay(runtime.relay),
      processes: compactProcesses(runtime.processes),
      process_sessions: compactCapacity(runtime.process_sessions),
      managed_jobs: compactCapacity(runtime.managed_jobs),
    },
  };
}

function compactProcesses(value) {
  const source = record(value);
  if (source.activity_hidden_by_authority === true) return { activity_hidden_by_authority: true };
  return {
    active_processes: source.active_processes ?? 0,
    draining_processes: source.draining_processes ?? 0,
  };
}

function compactCapacity(value) {
  const source = record(value);
  const capacity = source.capacity && typeof source.capacity === "object" && !Array.isArray(source.capacity)
    ? record(source.capacity) : null;
  return {
    active: source.active ?? 0,
    retained: source.retained ?? 0,
    maximum: source.maximum ?? 0,
    ...(source.staged === undefined ? {} : { staged: source.staged }),
    ...(capacity ? { capacity: {
      retained_state: capacity.retained_state ?? 0,
      retired_state: capacity.retired_state ?? 0,
      retired_unreadable: capacity.retired_unreadable ?? 0,
    } } : {}),
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
