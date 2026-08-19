export class RelayHeartbeatStall {
  constructor({ logger, timeoutMs, wallNow = Date.now }) {
    this.logger = logger || console;
    this.timeoutMs = timeoutMs;
    this.wallNow = wallNow;
    this.lastLagMs = 0;
    this.maxLagMs = 0;
    this.count = 0;
    this.lastWallAt = 0;
    this.lastWarnAt = 0;
  }

  recordLag(lagMs) {
    this.lastLagMs = lagMs;
    this.maxLagMs = Math.max(this.maxLagMs, lagMs);
  }

  observe(now, lagMs, recoveryGraceMs, relayDisconnectDeferred = true) {
    this.count += 1;
    this.lastWallAt = this.wallNow();
    if (this.lastWarnAt && now - this.lastWarnAt < this.timeoutMs) return;
    this.lastWarnAt = now;
    this.logger.warn?.(
      relayDisconnectDeferred
        ? "local event loop stalled; relay liveness decision deferred"
        : "local event loop resumed after a long pause; reconnecting stale relay transport",
      {
        event: "runtime.event_loop.stall",
        lag_ms: lagMs,
        recovery_grace_ms: recoveryGraceMs,
        relay_disconnect_deferred: relayDisconnectDeferred,
      },
    );
  }

  snapshot() {
    return {
      last_event_loop_lag_ms: this.lastLagMs,
      max_event_loop_lag_ms: this.maxLagMs,
      event_loop_stall_count: this.count,
      last_event_loop_stall_at: this.lastWallAt > 0 ? new Date(this.lastWallAt).toISOString() : null,
    };
  }
}
