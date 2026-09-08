import { RemoteActivityIdleSleepTimeline } from "./remote-activity-idle-sleep-timeline.mjs";
import { RemoteIdleSleepAssertions } from "./remote-idle-sleep-assertions.mjs";
export const DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS = 30 * 60_000;
export class RemoteActivityIdleSleepGuard {
  constructor({ platform = process.platform, daemonPid = process.pid, graceMs = DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS,
    mode = "activity", spawnProcess, setTimer = setTimeout, clearTimer = clearTimeout, wallNow = Date.now, logger = console } = {}) {
    this.assertions = new RemoteIdleSleepAssertions({ mode, platform, processId: daemonPid, spawnProcess, setTimer, clearTimer, wallNow, logger });
    this.enabled = this.assertions.supported && Number.isSafeInteger(graceMs) && graceMs > 0;
    this.graceMs = this.enabled ? graceMs : 0;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.timeline = new RemoteActivityIdleSleepTimeline({ wallNow }); this.releaseTimer = null; this.activeActivities = 0;
  }
  start() { return this.enabled ? this.assertions.start() : false; }
  beginActivity() {
    if (!this.enabled) return false;
    this.timeline.activityStarted(); this.activeActivities += 1;
    this.cancelReleaseTimer();
    return this.assertions.beginActivity();
  }
  endActivity() {
    if (!this.enabled) return false;
    if (this.activeActivities <= 0) return this.assertions.snapshot().active;
    this.timeline.activityEnded(); this.activeActivities -= 1;
    if (!this.assertions.usesActivityGrace()) return this.assertions.snapshot().active;
    if (this.activeActivities > 0 || !this.assertions.activityActive()) return this.assertions.snapshot().active;
    try {
      this.armReleaseTimer();
      return true;
    } catch (error) {
      this.release();
      this.assertions.reportUnavailable(error);
      return false;
    }
  }
  cancelReleaseTimer() {
    const timer = this.releaseTimer;
    this.releaseTimer = null; this.timeline.graceCancelled();
    if (!timer) return;
    try { this.clearTimer(timer); } catch { /* Stale timer callbacks also check identity before release. */ }
  }
  armReleaseTimer() {
    this.cancelReleaseTimer(); this.timeline.graceArmed(this.graceMs);
    const timer = this.setTimer(() => {
      if (this.releaseTimer !== timer || this.activeActivities > 0) return;
      this.releaseTimer = null; this.timeline.graceCancelled();
      this.release("inactivity_grace_expired");
    }, this.graceMs);
    timer?.unref?.();
    this.releaseTimer = timer;
  }
  release(reason = "explicit_release") {
    const wasActive = this.assertions.activityActive();
    this.cancelReleaseTimer(); this.assertions.releaseActivity();
    if (wasActive) this.timeline.released(reason);
  }
  stop() {
    this.activeActivities = 0;
    this.release("runtime_stop");
    this.assertions.stop();
  }
  snapshot() {
    const assertion = this.assertions.snapshot();
    return {
      supported: assertion.supported, enabled: this.enabled, mode: assertion.mode,
      active: assertion.active,
      requests_idle_sleep_prevention: assertion.requests_idle_sleep_prevention,
      requests_system_sleep_prevention_on_ac: assertion.requests_system_sleep_prevention_on_ac,
      active_activities: this.activeActivities,
      grace_ms: this.graceMs,
      ...this.timeline.snapshot(),
      last_error_class: assertion.last_error_class,
      assertion_generation: assertion.assertion_generation,
      restart_count: assertion.restart_count,
      recovery_pending: assertion.recovery_pending,
      unprotected_duration_ms: assertion.unprotected_duration_ms,
      last_unprotected_duration_ms: assertion.last_unprotected_duration_ms,
    };
  }
}
