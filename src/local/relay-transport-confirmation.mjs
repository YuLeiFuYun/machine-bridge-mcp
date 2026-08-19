import { RelayProbeDeadline } from "./relay-probe-deadline.mjs";
import { RelayProbeDispatch } from "./relay-probe-dispatch.mjs";

export class RelayTransportConfirmation {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000);
    this.dispatchTimeoutMs = positiveInteger(options.dispatchTimeoutMs, 30_000);
    this.sendConfirmation = typeof options.sendConfirmation === "function" ? options.sendConfirmation : () => false;
    this.onSuspect = typeof options.onSuspect === "function" ? options.onSuspect : () => {};
    this.onRecovered = typeof options.onRecovered === "function" ? options.onRecovered : () => {};
    this.dispatch = new RelayProbeDispatch(this.enabled); this.deadline = new RelayProbeDeadline(this.enabled); this.startedAt = null;
  }
  begin(now, details = {}) {
    if (!this.enabled || this.pending()) return false;
    const current = Number(now); if (!Number.isFinite(current)) return false;
    this.startedAt = current; const token = this.dispatch.begin(current);
    this.onSuspect({ ...details, confirmation_timeout_ms: this.timeoutMs,
      confirmation_dispatch_timeout_ms: this.dispatchTimeoutMs });
    let requested = false;
    try {
      requested = this.sendConfirmation(current, (error, dispatchedAt) => {
        if (error) {
          if (this.dispatch.cancel(token)) this.startedAt = null;
          return;
        }
        const completed = this.dispatch.complete(token, dispatchedAt);
        if (completed && !completed.satisfiedByProof) this.deadline.sent(dispatchedAt, true);
      }) !== false;
    } catch { requested = false; }
    if (!requested) this.reset();
    return requested;
  }
  observe(now) {
    if (!this.pending()) return false;
    this.dispatch.observeProof();
    const responseMs = this.deadline.age(now); const totalMs = this.totalAge(now);
    this.deadline.observe(now); this.resetPending();
    this.onRecovered({ confirmation_ms: responseMs, confirmation_total_ms: totalMs,
      reason: "inbound_confirmation", confirmed: true });
    return true;
  }
  pending() { return this.dispatch.pending() || this.deadline.outstanding(); }
  dispatchPending() { return this.dispatch.pending(); }
  responsePending() { return this.deadline.outstanding(); }
  dispatchAge(now) { return this.dispatch.age(now); }
  age(now) { return this.deadline.age(now); }
  totalAge(now) { return this.startedAt === null ? 0 : Math.max(0, Number(now) - this.startedAt); }
  dispatchExpired(now) { return this.dispatchPending() && this.dispatchAge(now) >= this.dispatchTimeoutMs; }
  expired(now) { return this.responsePending() && this.age(now) >= this.timeoutMs; }
  dispatchTimeout(now) { const age = this.dispatch.timeout(now); this.startedAt = null; return age; }
  timeout(now) { const age = this.deadline.timeout(now); this.startedAt = null; return age; }
  cancel(now, reason = "cancelled") {
    if (!this.pending()) return false;
    const responseMs = this.age(now); const totalMs = this.totalAge(now); this.resetPending();
    this.onRecovered({ confirmation_ms: responseMs, confirmation_total_ms: totalMs, reason, confirmed: false });
    return true;
  }
  reset() { this.resetPending(); }
  resetPending() { this.dispatch.reset(); this.deadline.reset(); this.startedAt = null; }
  snapshot(now) {
    if (!this.enabled) return {};
    const metrics = this.dispatch.metricsSnapshot(); const response = this.deadline.snapshot(now);
    return {
      transport_confirmation_pending: this.pending(), transport_confirmation_dispatch_pending: this.dispatchPending(),
      transport_confirmation_dispatch_age_ms: this.dispatchAge(now), transport_confirmation_dispatch_timeout_ms: this.dispatchTimeoutMs,
      transport_confirmation_age_ms: this.age(now), transport_confirmation_timeout_ms: this.timeoutMs,
      last_transport_confirmation_dispatch_ms: metrics.last_probe_dispatch_ms,
      max_transport_confirmation_dispatch_ms: metrics.max_probe_dispatch_ms,
      last_transport_confirmation_dispatch_timeout_age_ms: metrics.last_probe_dispatch_timeout_age_ms,
      last_transport_confirmation_ms: response.last_probe_response_ms, max_transport_confirmation_ms: response.max_probe_response_ms,
      last_transport_confirmation_timeout_age_ms: response.last_probe_timeout_age_ms,
    };
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
