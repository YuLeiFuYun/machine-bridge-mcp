import { MacosIdleSleepAssertion } from "./macos-idle-sleep-assertion.mjs";

export const DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS = 30 * 60_000;

export class RemoteActivityIdleSleepGuard {
  constructor({ platform = process.platform, daemonPid = process.pid, graceMs = DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS,
    spawnProcess, setTimer = setTimeout, clearTimer = clearTimeout, logger = console } = {}) {
    this.assertion = new MacosIdleSleepAssertion({ platform, processId: daemonPid, spawnProcess, logger });
    this.enabled = this.assertion.supported && Number.isSafeInteger(graceMs) && graceMs > 0;
    this.graceMs = this.enabled ? graceMs : 0;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.releaseTimer = null;
    this.activeActivities = 0;
  }

  beginActivity() {
    if (!this.enabled) return false;
    this.activeActivities += 1;
    this.cancelReleaseTimer();
    return this.assertion.acquire();
  }

  endActivity() {
    if (!this.enabled) return false;
    if (this.activeActivities <= 0) return this.assertion.snapshot().active;
    this.activeActivities -= 1;
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
    this.releaseTimer = null;
    if (!timer) return;
    try { this.clearTimer(timer); } catch { /* Stale timer callbacks also check identity before release. */ }
  }

  armReleaseTimer() {
    this.cancelReleaseTimer();
    const timer = this.setTimer(() => {
      if (this.releaseTimer !== timer || this.activeActivities > 0) return;
      this.releaseTimer = null;
      this.assertion.release();
    }, this.graceMs);
    timer?.unref?.();
    this.releaseTimer = timer;
  }

  release() {
    this.cancelReleaseTimer();
    this.assertion.release();
  }

  stop() {
    this.activeActivities = 0;
    this.release();
  }

  snapshot() {
    const assertion = this.assertion.snapshot();
    return {
      supported: assertion.supported,
      enabled: this.enabled,
      active: assertion.active,
      grace_ms: this.graceMs,
      last_error_class: assertion.last_error_class,
    };
  }
}
