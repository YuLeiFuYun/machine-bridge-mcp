export class RelayProbeDeadline {
  constructor(enabled = false) {
    this.enabled = enabled === true;
    this.sentAt = null;
    this.lastResponseMs = 0;
    this.maxResponseMs = 0;
    this.lastTimeoutAgeMs = 0;
  }

  reset() { this.sentAt = null; }
  outstanding() { return this.enabled && Number.isFinite(this.sentAt); }
  age(now) { return this.outstanding() ? Math.max(0, Number(now) - this.sentAt) : 0; }

  sent(now, accepted) {
    if (this.enabled && accepted !== false && Number.isFinite(Number(now))) this.sentAt = Number(now);
  }

  observe(now) {
    if (!this.outstanding()) return;
    const responseMs = this.age(now);
    this.lastResponseMs = responseMs;
    this.maxResponseMs = Math.max(this.maxResponseMs, responseMs);
    this.sentAt = null;
  }

  timeout(now) {
    const age = this.age(now);
    this.lastTimeoutAgeMs = age;
    this.sentAt = null;
    return age;
  }

  snapshot(now) {
    if (!this.enabled) return {};
    return {
      probe_timeout_from_dispatch: true,
      probe_outstanding: this.outstanding(),
      probe_age_ms: this.age(now),
      last_probe_response_ms: this.lastResponseMs,
      max_probe_response_ms: this.maxResponseMs,
      last_probe_timeout_age_ms: this.lastTimeoutAgeMs,
    };
  }
}
