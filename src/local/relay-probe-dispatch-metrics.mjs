export class RelayProbeDispatchMetrics {
  constructor() {
    this.lastDelayMs = 0;
    this.maxDelayMs = 0;
    this.lastTimeoutAgeMs = 0;
  }

  complete(delay) {
    this.lastDelayMs = delay;
    this.maxDelayMs = Math.max(this.maxDelayMs, delay);
  }

  timeout(age) { this.lastTimeoutAgeMs = age; }

  snapshot() {
    return {
      last_probe_dispatch_ms: this.lastDelayMs,
      max_probe_dispatch_ms: this.maxDelayMs,
      last_probe_dispatch_timeout_age_ms: this.lastTimeoutAgeMs,
    };
  }
}
