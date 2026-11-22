import { spawn } from "node:child_process";
import { classifyOperationalError } from "./log.mjs";

export const IDLE_SLEEP_ASSERTION_RECOVERY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000]);

export class MacosIdleSleepRecovery {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout, wallNow = Date.now, onRetry,
    onTimerError = () => {}, delaysMs = IDLE_SLEEP_ASSERTION_RECOVERY_DELAYS_MS } = {}) {
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.wallNow = wallNow;
    this.onRetry = onRetry; this.onTimerError = onTimerError; this.delaysMs = [...delaysMs];
    this.desired = false; this.timer = null; this.attempt = 0; this.restartCount = 0;
    this.unprotectedSince = null; this.lastUnprotectedMs = 0;
  }

  enable() { this.desired = true; }

  failed() {
    if (!this.desired || this.timer) return;
    if (this.unprotectedSince === null) this.unprotectedSince = this.wallNow();
    const delay = this.delaysMs[Math.min(this.attempt, this.delaysMs.length - 1)] ?? 30_000;
    this.attempt += 1;
    try {
      const timer = this.setTimer(() => {
        if (this.timer !== timer) return;
        this.timer = null;
        if (this.desired) this.onRetry?.();
      }, delay);
      timer?.unref?.(); this.timer = timer;
    } catch (error) { this.onTimerError(error); }
  }

  recovered() {
    if (this.unprotectedSince !== null) {
      this.lastUnprotectedMs = Math.max(0, this.wallNow() - this.unprotectedSince);
      this.unprotectedSince = null; this.restartCount += 1;
    }
    this.attempt = 0; this.cancelTimer();
  }

  stop() { this.desired = false; this.attempt = 0; this.unprotectedSince = null; this.cancelTimer(); }

  cancelTimer() {
    const timer = this.timer; this.timer = null;
    if (!timer) return;
    try { this.clearTimer(timer); } catch { /* A stale callback checks timer identity. */ }
  }

  snapshot() {
    return {
      recovery_pending: Boolean(this.timer), restart_count: this.restartCount,
      unprotected_duration_ms: this.unprotectedSince === null ? 0 : Math.max(0, this.wallNow() - this.unprotectedSince),
      last_unprotected_duration_ms: this.lastUnprotectedMs,
    };
  }
}
export class MacosIdleSleepAssertion {
  constructor({ platform = process.platform, processId = process.pid, spawnProcess = spawn, logger = console, preventIdleSleep = true, preventSystemSleepOnAc = true, setTimer, clearTimer, wallNow } = {}) {
    this.supported = platform === "darwin";
    this.processId = processId;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.preventIdleSleep = Boolean(preventIdleSleep);
    this.preventSystemSleepOnAc = Boolean(preventSystemSleepOnAc);
    this.child = null;
    this.lastErrorClass = null;
    this.generation = 0;
    this.recovery = new MacosIdleSleepRecovery({ setTimer, clearTimer, wallNow, onRetry: () => this.spawnChild(), onTimerError: (error) => this.reportUnavailable(error) });
  }
  acquire() {
    if (!this.supported) return false;
    this.recovery.enable();
    if (this.child) return true;
    return this.spawnChild();
  }
  spawnChild() {
    let child = null;
    try {
      const args = [...(this.preventIdleSleep ? ["-i"] : []), ...(this.preventSystemSleepOnAc ? ["-s"] : []), "-w", String(this.processId)];
      child = this.spawnProcess("/usr/bin/caffeinate", args, {
        stdio: "ignore", shell: false, windowsHide: true,
      });
      this.child = child;
      this.generation += 1;
      child.unref?.();
      child.once?.("error", (error) => this.handleChildFailure(child, error));
      child.once?.("exit", () => this.handleChildFailure(child, new Error("idle-sleep assertion child exited before its owner process")));
      this.lastErrorClass = null;
      this.recovery.recovered();
      return true;
    } catch (error) {
      if (this.child === child) this.child = null;
      try { child?.kill?.("SIGTERM"); } catch { /* Best-effort cleanup after partial child setup. */ }
      this.reportUnavailable(error);
      this.recovery.failed();
      return false;
    }
  }
  handleChildFailure(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.reportUnavailable(error);
    this.recovery.failed();
  }
  reportUnavailable(error) {
    const errorClass = classifyOperationalError(error);
    if (this.lastErrorClass === errorClass) return;
    this.lastErrorClass = errorClass;
    try {
      this.logger.event?.("warn", "runtime.idle_sleep_guard.unavailable", { error_class: errorClass },
        "macOS idle-sleep assertion is unavailable");
    } catch { /* Auxiliary power-management logging must never affect the owning workload. */ }
  }
  release() {
    this.recovery.stop();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed === true) return;
    try { child.kill?.("SIGTERM"); } catch { /* -w binds any survivor to the owner process lifetime. */ }
  }
  snapshot() {
    return {
      supported: this.supported,
      active: Boolean(this.child),
      requests_idle_sleep_prevention: Boolean(this.child) && this.preventIdleSleep,
      requests_system_sleep_prevention_on_ac: Boolean(this.child) && this.preventSystemSleepOnAc,
      last_error_class: this.lastErrorClass,
      assertion_generation: this.generation,
      ...this.recovery.snapshot(),
    };
  }
}
export const IDLE_SLEEP_MODES = Object.freeze(/** @type {const} */ (["activity", "ac-continuous", "continuous"]));

/**
 * @param {string} [value]
 * @returns {string}
 */
export function normalizeIdleSleepMode(value = "activity") {
  const mode = String(value || "activity").trim().toLowerCase();
  if (!/** @type {readonly string[]} */ (IDLE_SLEEP_MODES).includes(mode)) {
    throw new Error(`idle-sleep mode must be one of: ${IDLE_SLEEP_MODES.join(", ")}`);
  }
  return mode;
}

export class RemoteIdleSleepAssertions {
  constructor({ mode = "activity", platform, processId, spawnProcess, setTimer, clearTimer, wallNow, logger } = {}) {
    this.mode = normalizeIdleSleepMode(mode);
    const common = { platform, processId, spawnProcess, setTimer, clearTimer, wallNow, logger };
    this.activity = new MacosIdleSleepAssertion({ ...common, preventIdleSleep: true, preventSystemSleepOnAc: true });
    this.continuous = this.mode === "activity" ? null : new MacosIdleSleepAssertion({ ...common,
      preventIdleSleep: this.mode === "continuous", preventSystemSleepOnAc: true });
    this.supported = this.activity.supported;
  }

  start() { return this.continuous?.acquire() ?? true; }
  usesActivityGrace() { return this.mode !== "continuous"; }
  activityActive() { return this.mode === "continuous" ? Boolean(this.continuous?.snapshot().active) : this.activity.snapshot().active; }
  beginActivity() {
    if (this.mode !== "continuous") return this.activity.acquire();
    return this.continuous.snapshot().active || this.continuous.acquire();
  }
  reportUnavailable(error) { this.activity.reportUnavailable(error); }
  releaseActivity() { if (this.mode !== "continuous") this.activity.release(); }
  stop() { this.activity.release(); this.continuous?.release(); }

  snapshot() {
    const activity = this.activity.snapshot();
    const continuous = this.continuous?.snapshot() ?? null;
    return {
      mode: this.mode, supported: activity.supported,
      active: activity.active || Boolean(continuous?.active),
      requests_idle_sleep_prevention: activity.requests_idle_sleep_prevention || Boolean(continuous?.requests_idle_sleep_prevention),
      requests_system_sleep_prevention_on_ac: activity.requests_system_sleep_prevention_on_ac || Boolean(continuous?.requests_system_sleep_prevention_on_ac),
      last_error_class: activity.last_error_class ?? continuous?.last_error_class ?? null,
      assertion_generation: activity.assertion_generation + (continuous?.assertion_generation ?? 0),
      restart_count: activity.restart_count + (continuous?.restart_count ?? 0),
      recovery_pending: activity.recovery_pending || Boolean(continuous?.recovery_pending),
      unprotected_duration_ms: Math.max(activity.unprotected_duration_ms, continuous?.unprotected_duration_ms ?? 0),
      last_unprotected_duration_ms: Math.max(activity.last_unprotected_duration_ms, continuous?.last_unprotected_duration_ms ?? 0),
    };
  }
}
const POWER_LOG_COMMAND = "/usr/bin/pmset -g log | /usr/bin/grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{4}[[:space:]]+Sleep[[:space:]]{2,}' | /usr/bin/tail -n 120";

const POWER_LOG_TIMEOUT_MS = 15_000;

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
    return unavailableSystemSleepHistory(classifyOperationalError(error));
  }
}

function unavailableSystemSleepHistory(errorClass) {
  return {
    snapshot: { supported: true, available: false, source: "macos_pmset", recent_sleep_intervals: [], error_class: errorClass },
    check: { layer: "system-sleep-history", ok: false, skipped: true, error_class: errorClass },
  };
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

export function correlateRelayOutageWithSystemSleep(relay, snapshot) {
  const completed = relay?.outage_active === true ? null : relay?.recent_outages?.[0];
  const startedAt = Date.parse(String(relay?.outage_active === true
    ? relay?.outage_started_at || relay?.last_disconnected_at || ""
    : completed?.disconnected_at || relay?.last_disconnected_at || ""));
  if (!(startedAt > 0)) return relayOutageProjection("no_recorded_relay_outage");
  const endedAt = Date.parse(String(completed?.ready_at || relay?.last_ready_at || ""));
  if (relay?.outage_active === true || !(endedAt >= startedAt)) {
    return relayOutageProjection("relay_outage_active", {
      outageStartedAt: new Date(startedAt).toISOString(),
    });
  }
  const outageDurationMs = endedAt - startedAt;
  if (snapshot?.supported === false) {
    return relayOutageProjection("unsupported_platform", {
      outageStartedAt: new Date(startedAt).toISOString(), outageEndedAt: new Date(endedAt).toISOString(), outageDurationMs,
    });
  }
  if (snapshot?.available !== true) {
    return relayOutageProjection("system_sleep_history_unavailable", {
      outageStartedAt: new Date(startedAt).toISOString(), outageEndedAt: new Date(endedAt).toISOString(), outageDurationMs,
    });
  }
  const overlap = sleepOverlap(startedAt, endedAt, snapshot.recent_sleep_intervals || []);
  const ratio = outageDurationMs > 0 ? overlap.durationMs / outageDurationMs : 0;
  if (overlap.durationMs <= 0) {
    const wakeBoundaryMatch = wakeBoundarySleepMatch(relay, snapshot.recent_sleep_intervals || [], startedAt);
    if (wakeBoundaryMatch) {
      return relayOutageProjection("wake_boundary_system_sleep_aftermath", {
        outageStartedAt: new Date(startedAt).toISOString(), outageEndedAt: new Date(endedAt).toISOString(), outageDurationMs,
        matchedSleepCount: 1,
      });
    }
  }
  const classification = overlap.durationMs <= 0
    ? "no_matching_recent_system_sleep"
    : ratio >= 0.5 ? "majority_system_sleep_overlap" : "partial_system_sleep_overlap";
  return relayOutageProjection(classification, {
    outageStartedAt: new Date(startedAt).toISOString(),
    outageEndedAt: new Date(endedAt).toISOString(),
    outageDurationMs,
    sleepOverlapMs: overlap.durationMs,
    sleepOverlapRatio: Number(ratio.toFixed(4)),
    matchedSleepCount: overlap.count,
  });
}

function wakeBoundarySleepMatch(relay, intervals, outageStartedAt) {
  const stallAt = Date.parse(String(relay?.heartbeat?.last_event_loop_stall_at || ""));
  const stallLagMs = Number(relay?.heartbeat?.last_event_loop_stall_lag_ms) || 0;
  if (!(stallAt > 0) || stallLagMs <= 0) return null;
  for (const interval of intervals) {
    const sleepStart = Date.parse(String(interval?.started_at || ""));
    const sleepEnd = Date.parse(String(interval?.ended_at || ""));
    const durationMs = Number(interval?.duration_ms) || 0;
    if (!(sleepStart >= 0) || !(sleepEnd > sleepStart) || durationMs <= 0) continue;
    if (Math.abs(sleepEnd - outageStartedAt) > CORRELATION_TOLERANCE_MS) continue;
    if (Math.abs(sleepEnd - stallAt) > CORRELATION_TOLERANCE_MS) continue;
    if (Math.abs(durationMs - stallLagMs) > CORRELATION_TOLERANCE_MS) continue;
    return interval;
  }
  return null;
}

function sleepOverlap(startedAt, endedAt, intervals) {
  const segments = [];
  for (const interval of intervals) {
    const sleepStart = Date.parse(String(interval?.started_at || ""));
    const sleepEnd = Date.parse(String(interval?.ended_at || ""));
    if (!(sleepStart >= 0) || !(sleepEnd > sleepStart)) continue;
    const start = Math.max(startedAt, sleepStart);
    const end = Math.min(endedAt, sleepEnd);
    if (end > start) segments.push([start, end]);
  }
  segments.sort((left, right) => left[0] - right[0]);
  let durationMs = 0; let count = 0; let activeStart = null; let activeEnd = null;
  for (const [start, end] of segments) {
    if (activeStart === null) { activeStart = start; activeEnd = end; count += 1; continue; }
    if (start <= activeEnd) { activeEnd = Math.max(activeEnd, end); continue; }
    durationMs += activeEnd - activeStart; activeStart = start; activeEnd = end; count += 1;
  }
  if (activeStart !== null) durationMs += activeEnd - activeStart;
  return { durationMs, count };
}

function relayOutageProjection(classification, values = {}) {
  return {
    classification,
    outage_started_at: values.outageStartedAt || null,
    outage_ended_at: values.outageEndedAt || null,
    outage_duration_ms: Number(values.outageDurationMs) || 0,
    sleep_overlap_ms: Number(values.sleepOverlapMs) || 0,
    sleep_overlap_ratio: Number(values.sleepOverlapRatio) || 0,
    matched_sleep_count: Number(values.matchedSleepCount) || 0,
  };
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
