import { MacosIdleSleepAssertion } from "./macos-idle-sleep-assertion.mjs";
import { normalizeIdleSleepMode } from "./idle-sleep-mode.mjs";

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
