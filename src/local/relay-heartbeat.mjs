export class RelayHeartbeatMonitor {
  constructor(options = {}) {
    this.intervalMs = positiveInteger(options.intervalMs, 25_000);
    this.timeoutMs = positiveInteger(options.timeoutMs, 75_000);
    this.stallThresholdMs = positiveInteger(options.stallThresholdMs, Math.max(1000, Math.floor(this.intervalMs / 2)));
    this.recoveryGraceMs = positiveInteger(options.recoveryGraceMs, Math.max(this.intervalMs, Math.min(this.timeoutMs, 30_000)));
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.logger = options.logger || console;
    this.isActive = options.isActive;
    this.lastInboundAt = options.lastInboundAt;
    this.sendHeartbeat = options.sendHeartbeat;
    this.onTimeout = options.onTimeout;
    this.timer = null;
    this.expectedAt = 0;
    this.recoveryUntil = 0;
    this.lastEventLoopLagMs = 0;
    this.maxEventLoopLagMs = 0;
    this.eventLoopStallCount = 0;
    this.lastEventLoopStallAt = 0;
    this.lastEventLoopStallWarnAt = 0;
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
  }

  observeInbound() {
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
      last_event_loop_lag_ms: this.lastEventLoopLagMs,
      max_event_loop_lag_ms: this.maxEventLoopLagMs,
      event_loop_stall_count: this.eventLoopStallCount,
      last_event_loop_stall_at: isoTimestamp(this.lastEventLoopStallAt),
    };
  }

  tick() {
    if (!this.isActive()) return;
    const now = this.now();
    const expectedAt = this.expectedAt || now;
    const eventLoopLagMs = Math.max(0, now - expectedAt);
    this.expectedAt = now + this.intervalMs;
    this.lastEventLoopLagMs = eventLoopLagMs;
    this.maxEventLoopLagMs = Math.max(this.maxEventLoopLagMs, eventLoopLagMs);

    if (eventLoopLagMs >= this.stallThresholdMs) {
      const silentForMs = Math.max(0, now - this.lastInboundAt());
      const staleAfterLongPause = eventLoopLagMs > this.timeoutMs + this.recoveryGraceMs
        && silentForMs > this.timeoutMs;
      this.observeEventLoopStall(now, eventLoopLagMs, !staleAfterLongPause);
      if (staleAfterLongPause) {
        this.recoveryUntil = 0;
        this.onTimeout({ silentForMs, eventLoopLagMs });
        return;
      }
      this.recoveryUntil = Math.max(this.recoveryUntil, now + this.recoveryGraceMs);
      this.sendHeartbeat(now);
      return;
    }
    if (now < this.recoveryUntil) {
      this.sendHeartbeat(now);
      return;
    }

    const silentForMs = Math.max(0, now - this.lastInboundAt());
    if (silentForMs >= this.timeoutMs) {
      this.onTimeout({ silentForMs, eventLoopLagMs });
      return;
    }
    this.sendHeartbeat(now);
  }

  observeEventLoopStall(now, lagMs, relayDisconnectDeferred = true) {
    this.eventLoopStallCount += 1;
    this.lastEventLoopStallAt = now;
    if (this.lastEventLoopStallWarnAt && now - this.lastEventLoopStallWarnAt < this.timeoutMs) return;
    this.lastEventLoopStallWarnAt = now;
    this.logger.warn?.(
      relayDisconnectDeferred
        ? "local event loop stalled; relay liveness decision deferred"
        : "local event loop resumed after a long pause; reconnecting stale relay transport",
      {
        event: "runtime.event_loop.stall",
        lag_ms: lagMs,
        recovery_grace_ms: this.recoveryGraceMs,
        relay_disconnect_deferred: relayDisconnectDeferred,
      },
    );
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
function isoTimestamp(value) {
  return Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
}
