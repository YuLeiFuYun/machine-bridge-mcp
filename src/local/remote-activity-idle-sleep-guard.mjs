import { MacosIdleSleepAssertion } from "./macos-idle-sleep-assertion.mjs";
import { RemoteActivityIdleSleepTimeline } from "./remote-activity-idle-sleep-timeline.mjs";

export const DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS = 30 * 60_000;

export class RemoteActivityIdleSleepGuard {
  constructor({ platform = process.platform, daemonPid = process.pid, graceMs = DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS,
    spawnProcess, setTimer = setTimeout, clearTimer = clearTimeout, wallNow = Date.now, logger = console } = {}) {
    this.assertion = new MacosIdleSleepAssertion({ platform, processId: daemonPid, spawnProcess, logger });
    this.enabled = this.assertion.supported && Number.isSafeInteger(graceMs) && graceMs > 0;
    this.graceMs = this.enabled ? graceMs : 0;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.timeline = new RemoteActivityIdleSleepTimeline({ wallNow }); this.releaseTimer = null; this.activeActivities = 0;
  }

  beginActivity() {
    if (!this.enabled) return false;
    this.timeline.activityStarted(); this.activeActivities += 1;
    this.cancelReleaseTimer();
    return this.assertion.acquire();
  }

  endActivity() {
    if (!this.enabled) return false;
    if (this.activeActivities <= 0) return this.assertion.snapshot().active;
    this.timeline.activityEnded(); this.activeActivities -= 1;
    if (this.activeActivities > 0 || !this.assertion.snapshot().active) return this.assertion.snapshot().active;
    try {
      this.armReleaseTimer();
      return true;
    } catch (error) {
      this.release();
      this.assertion.reportUnavailable(error);
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
    const wasActive = this.assertion.snapshot().active;
    this.cancelReleaseTimer(); this.assertion.release();
    if (wasActive) this.timeline.released(reason);
  }

  stop() {
    this.activeActivities = 0;
    this.release("runtime_stop");
  }

  snapshot() {
    const assertion = this.assertion.snapshot();
    return {
      supported: assertion.supported, enabled: this.enabled,
      active: assertion.active,
      requests_system_sleep_prevention_on_ac: assertion.requests_system_sleep_prevention_on_ac,
      active_activities: this.activeActivities,
      grace_ms: this.graceMs,
      ...this.timeline.snapshot(),
      last_error_class: assertion.last_error_class,
    };
  }
}
