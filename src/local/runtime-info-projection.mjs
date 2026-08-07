// @ts-check

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
      daemon_advertised_tool_count: delivery.daemon_advertised_tool_count ?? 0,
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
    },
    runtime: {
      lifecycle: runtime.lifecycle ?? null,
      relay: runtime.relay ?? null,
      processes: compactProcesses(runtime.processes),
      process_sessions: compactCapacity(runtime.process_sessions),
      managed_jobs: compactCapacity(runtime.managed_jobs),
    },
  };
}

function compactProcesses(value) {
  const source = record(value);
  return {
    active_processes: source.active_processes ?? 0,
    draining_processes: source.draining_processes ?? 0,
  };
}

function compactCapacity(value) {
  const source = record(value);
  return {
    active: source.active ?? 0,
    retained: source.retained ?? 0,
    maximum: source.maximum ?? 0,
    ...(source.staged === undefined ? {} : { staged: source.staged }),
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
