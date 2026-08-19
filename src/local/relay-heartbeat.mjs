import { RelayProbeDeadline } from "./relay-probe-deadline.mjs";
import { RelayProbeDispatch } from "./relay-probe-dispatch.mjs";
import { RelayHeartbeatStall } from "./relay-heartbeat-stall.mjs";
import { normalizeRelayHeartbeatTiming } from "./relay-heartbeat-options.mjs";
import { advanceRelayTransportState } from "./relay-heartbeat-transport-state.mjs";
import { RelayTransportConfirmation } from "./relay-transport-confirmation.mjs";

export class RelayHeartbeatMonitor {
  constructor(options = {}) {
    Object.assign(this, normalizeRelayHeartbeatTiming(options));
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.logger = options.logger || console;
    this.isActive = options.isActive;
    this.lastInboundAt = options.lastInboundAt;
    this.sendHeartbeat = options.sendHeartbeat;
    this.onTimeout = options.onTimeout;
    this.probeDeadline = new RelayProbeDeadline(options.timeoutAfterProbe);
    this.probeDispatch = new RelayProbeDispatch(options.timeoutAfterProbe);
    this.confirmation = new RelayTransportConfirmation({ enabled: options.timeoutAfterProbe,
      timeoutMs: options.confirmationTimeoutMs, dispatchTimeoutMs: this.dispatchTimeoutMs,
      sendConfirmation: options.sendConfirmation, onSuspect: options.onSuspect, onRecovered: options.onRecovered });
    this.stall = new RelayHeartbeatStall({ logger: this.logger, timeoutMs: this.timeoutMs, wallNow: options.wallNow });
    this.timer = null; this.expectedAt = 0; this.recoveryUntil = 0;
  }

  start() {
    this.stop();
    this.expectedAt = this.now() + this.intervalMs;
    this.recoveryUntil = 0;
    this.timer = this.scheduler.setInterval(() => this.tick(), this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.expectedAt = 0;
    this.recoveryUntil = 0;
    this.probeDeadline.reset(); this.probeDispatch.reset(); this.confirmation.reset();
  }

  observeInbound() {
    this.probeDispatch.observeProof();
    this.probeDeadline.observe(this.now());
    this.confirmation.observe(this.now());
    this.recoveryUntil = 0;
  }

  snapshot(now = this.now()) {
    const current = Number(now) || 0;
    return {
      interval_ms: this.intervalMs,
      timeout_ms: this.timeoutMs,
      recovery_grace_ms: this.recoveryGraceMs,
      recovery_active: this.recoveryUntil > current,
      recovery_remaining_ms: this.recoveryUntil > current ? this.recoveryUntil - current : 0,
      ...this.stall.snapshot(),
      dispatch_timeout_ms: this.probeDeadline.enabled ? this.dispatchTimeoutMs : 0,
      ...this.probeDispatch.snapshot(current),
      ...this.probeDeadline.snapshot(current),
      ...this.confirmation.snapshot(current),
    };
  }

  tick() {
    const now = this.now();
    const expectedAt = this.expectedAt || now;
    const eventLoopLagMs = Math.max(0, now - expectedAt);
    this.expectedAt = now + this.intervalMs;
    if (!this.isActive()) return;
    this.stall.recordLag(eventLoopLagMs);

    if (eventLoopLagMs >= this.stallThresholdMs) {
      const silentForMs = Math.max(0, now - this.lastInboundAt());
      const staleAfterLongPause = eventLoopLagMs > this.timeoutMs + this.recoveryGraceMs
        && silentForMs > this.timeoutMs;
      this.stall.observe(now, eventLoopLagMs, this.recoveryGraceMs, !staleAfterLongPause);
      if (staleAfterLongPause) {
        this.recoveryUntil = 0;
        this.onTimeout({ silentForMs, eventLoopLagMs, probeAgeMs: this.probeDeadline.age(now) });
        return;
      }
      this.recoveryUntil = Math.max(this.recoveryUntil, now + this.recoveryGraceMs);
      this.probeDeadline.reset(); this.confirmation.cancel(now, "local_event_loop_stall");
      if (!this.probeDispatch.pending()) this.sendProbe(now);
      return;
    }
    if (now < this.recoveryUntil) {
      if (!this.probeDeadline.outstanding() && !this.probeDispatch.pending()) this.sendProbe(now);
      return;
    }

    const silentForMs = Math.max(0, now - this.lastInboundAt());
    if (advanceRelayTransportState(this, now, silentForMs, eventLoopLagMs)) return;
    if (silentForMs >= this.timeoutMs) {
      this.onTimeout({ silentForMs, eventLoopLagMs });
      return;
    }
    this.sendHeartbeat(now);
  }

  sendProbe(now) {
    if (!this.probeDeadline.enabled) return this.sendHeartbeat(now);
    const token = this.probeDispatch.begin(now);
    const sent = this.sendHeartbeat(now, () => {
      const dispatchedAt = this.now();
      const completed = this.probeDispatch.complete(token, dispatchedAt);
      if (completed && !completed.satisfiedByProof) this.probeDeadline.sent(dispatchedAt, true);
    });
    if (sent === false) this.probeDispatch.cancel(token);
    return sent;
  }

}
