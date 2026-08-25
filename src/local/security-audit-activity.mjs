const WINDOWS_MS = Object.freeze({ one: 60_000, five: 5 * 60_000, fifteen: 15 * 60_000, sixty: 60 * 60_000 });
const PROCESS_HELPERS = new Set(["exec_command", "run_process", "run_local_command"]);

export function securityAuditRecentActivity(state = {}) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const endMs = Date.parse(String(events.at(-1)?.timestamp || ""));
  if (!Number.isFinite(endMs)) return emptyActivity();
  const recent = (windowMs) => events.filter((event) => eventAgeMs(event, endMs) <= windowMs);
  const last15 = recent(WINDOWS_MS.fifteen);
  const toolCounts = new Map();
  const minuteCounts = new Map();
  for (const event of last15) {
    const tool = String(event?.tool || "unknown");
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    const bucket = Math.floor(eventAgeMs(event, endMs) / 60_000);
    minuteCounts.set(bucket, (minuteCounts.get(bucket) || 0) + 1);
  }
  const topTools = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8).map(([tool, count]) => ({ tool, count }));
  return {
    coverage: "daemon_reached_relay_tool_calls_only",
    host_side_events_observable: false,
    window_end_at: new Date(endMs).toISOString(),
    calls_last_1m: recent(WINDOWS_MS.one).length,
    calls_last_5m: recent(WINDOWS_MS.five).length,
    calls_last_15m: last15.length,
    calls_last_60m: recent(WINDOWS_MS.sixty).length,
    failures_last_15m: last15.filter((event) => event?.outcome !== "completed").length,
    process_helper_calls_last_15m: last15.filter((event) => PROCESS_HELPERS.has(String(event?.tool || ""))).length,
    read_job_calls_last_15m: last15.filter((event) => event?.tool === "read_job").length,
    start_job_calls_last_15m: last15.filter((event) => event?.tool === "start_job").length,
    peak_calls_per_minute_last_15m: Math.max(0, ...minuteCounts.values()),
    distinct_tools_last_15m: toolCounts.size,
    top_tools_last_15m: topTools,
  };
}

function eventAgeMs(event, endMs) {
  const timestamp = Date.parse(String(event?.timestamp || ""));
  return Number.isFinite(timestamp) ? Math.max(0, endMs - timestamp) : Number.POSITIVE_INFINITY;
}

function emptyActivity() {
  return {
    coverage: "daemon_reached_relay_tool_calls_only", host_side_events_observable: false,
    window_end_at: null, calls_last_1m: 0, calls_last_5m: 0, calls_last_15m: 0, calls_last_60m: 0,
    failures_last_15m: 0, process_helper_calls_last_15m: 0, read_job_calls_last_15m: 0, start_job_calls_last_15m: 0,
    peak_calls_per_minute_last_15m: 0, distinct_tools_last_15m: 0, top_tools_last_15m: [],
  };
}
