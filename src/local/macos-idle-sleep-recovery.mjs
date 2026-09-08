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
