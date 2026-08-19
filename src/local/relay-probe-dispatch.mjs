import { RelayProbeDispatchMetrics } from "./relay-probe-dispatch-metrics.mjs";

export class RelayProbeDispatch {
  constructor(enabled = false) {
    this.enabled = enabled === true; this.pendingAt = null; this.token = 0;
    this.metrics = new RelayProbeDispatchMetrics(); this.proofObserved = false;
  }
  begin(now) {
    if (!this.enabled || !Number.isFinite(Number(now))) return 0;
    this.token += 1; this.pendingAt = Number(now); this.proofObserved = false;
    return this.token;
  }
  cancel(token) {
    if (token !== this.token) return false;
    this.pendingAt = null; this.proofObserved = false; return true;
  }
  complete(token, now) {
    if (token !== this.token || !this.pending()) return null;
    const delay = this.age(now); const satisfiedByProof = this.proofObserved;
    this.metrics.complete(delay); this.pendingAt = null; this.proofObserved = false;
    return { delayMs: delay, satisfiedByProof };
  }
  pending() { return this.enabled && Number.isFinite(this.pendingAt); }
  age(now) { return this.pending() ? Math.max(0, Number(now) - this.pendingAt) : 0; }
  observeProof() { if (this.pending()) this.proofObserved = true; }
  timeout(now) {
    const age = this.age(now); this.metrics.timeout(age); this.reset(); return age;
  }
  reset() { this.pendingAt = null; this.proofObserved = false; this.token += 1; }
  metricsSnapshot() { return this.metrics.snapshot(); }
  snapshot(now) {
    if (!this.enabled) return {};
    return {
      probe_dispatch_pending: this.pending(), probe_dispatch_age_ms: this.age(now),
      ...this.metricsSnapshot(),
    };
  }
}
