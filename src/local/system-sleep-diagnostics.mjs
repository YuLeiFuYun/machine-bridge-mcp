import { classifyOperationalError } from "./log.mjs";

const POWER_LOG_COMMAND = "/usr/bin/pmset -g log | /usr/bin/grep -E ' (Sleep|DarkWake|Wake)[[:space:]]' | /usr/bin/tail -n 120";
const POWER_LOG_TIMEOUT_MS = 5_000;
const POWER_LOG_MAX_BYTES = 128 * 1024;
const CORRELATION_TOLERANCE_MS = 30_000;

export async function systemSleepDiagnostic({ runFixedInternal, context, workspace, platform = process.platform }) {
  if (platform !== "darwin") return {
    snapshot: { supported: false, available: false, source: null, recent_sleep_intervals: [] },
    check: { layer: "system-sleep-history", ok: false, skipped: true, error_class: "unsupported_platform" },
  };
  try {
    const result = await runFixedInternal("/bin/sh", ["-c", POWER_LOG_COMMAND], POWER_LOG_TIMEOUT_MS,
      true, POWER_LOG_MAX_BYTES, context, workspace);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "pmset log probe failed");
    const intervals = parseSystemSleepIntervals(result.stdout);
    return {
      snapshot: { supported: true, available: true, source: "macos_pmset", recent_sleep_intervals: intervals },
      check: { layer: "system-sleep-history", ok: true, recent_sleep_intervals: intervals.length },
    };
  } catch (error) {
    return {
      snapshot: { supported: true, available: false, source: "macos_pmset", recent_sleep_intervals: [], error_class: classifyOperationalError(error) },
      check: { layer: "system-sleep-history", ok: false, error_class: classifyOperationalError(error) },
    };
  }
}

export function parseSystemSleepIntervals(text, limit = 8) {
  const intervals = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+Sleep\s{2,}(.*)$/);
    if (!match) continue;
    const startedAt = powerTimestamp(match[1]);
    const duration = Number(match[2].match(/\b(\d+)\s+secs\b/)?.[1]);
    if (!startedAt || !Number.isSafeInteger(duration) || duration < 0 || duration > 7 * 24 * 60 * 60) continue;
    const startedMs = Date.parse(startedAt);
    intervals.push({
      started_at: startedAt,
      ended_at: new Date(startedMs + duration * 1000).toISOString(),
      duration_ms: duration * 1000,
      reason: sleepReason(match[2]),
    });
  }
  return intervals.slice(-Math.max(1, Math.min(32, Number(limit) || 8)));
}

export function correlateEventLoopStallWithSystemSleep(relay, snapshot) {
  const heartbeat = relay?.heartbeat;
  const stallAt = Date.parse(String(heartbeat?.last_event_loop_stall_at || ""));
  const lagMs = Number(heartbeat?.last_event_loop_stall_lag_ms) || 0;
  if (!(stallAt > 0) || lagMs <= 0) return { classification: "no_recorded_event_loop_stall", matched_sleep: null };
  if (snapshot?.supported === false) return stallProjection("unsupported_platform", heartbeat, null);
  if (snapshot?.available !== true) return stallProjection("system_sleep_history_unavailable", heartbeat, null);
  const match = (snapshot.recent_sleep_intervals || []).find((interval) => {
    const endedAt = Date.parse(String(interval?.ended_at || ""));
    const durationMs = Number(interval?.duration_ms) || 0;
    return endedAt > 0 && Math.abs(endedAt - stallAt) <= CORRELATION_TOLERANCE_MS
      && Math.abs(durationMs - lagMs) <= CORRELATION_TOLERANCE_MS;
  });
  return stallProjection(match ? "matched_system_sleep" : "no_matching_recent_system_sleep", heartbeat, match || null);
}

function stallProjection(classification, heartbeat, matchedSleep) {
  return {
    classification,
    last_event_loop_stall_at: heartbeat?.last_event_loop_stall_at || null,
    last_event_loop_stall_lag_ms: Number(heartbeat?.last_event_loop_stall_lag_ms) || 0,
    matched_sleep: matchedSleep,
  };
}

function powerTimestamp(value) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sleepReason(detail) {
  const value = String(detail || "").toLowerCase();
  if (value.includes("sleep service back to sleep")) return "sleep_service_back_to_sleep";
  if (value.includes("maintenance sleep")) return "maintenance_sleep";
  if (value.includes("idle sleep")) return "idle_sleep";
  if (value.includes("clamshell")) return "clamshell_sleep";
  return "other";
}
