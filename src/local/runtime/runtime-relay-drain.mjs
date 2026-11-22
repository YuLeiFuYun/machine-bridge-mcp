import { randomBytes } from "node:crypto";

const DEFAULT_ACK_WAIT_MS = 2_000;

export class RuntimeRelayShutdownDrain {
  constructor({ send, ready, logger = console, waitMs = DEFAULT_ACK_WAIT_MS, scheduler = { setTimeout, clearTimeout } }) {
    this.send = send;
    this.ready = ready;
    this.logger = logger;
    this.waitMs = waitMs;
    this.scheduler = scheduler;
    this.pending = null;
  }

  async begin(activeCalls = 0) {
    if (this.pending) return this.pending.promise;
    if (this.ready?.() !== true) return { attempted: false, acknowledged: false, reason: "relay_not_ready" };
    const drainId = `drain_${randomBytes(18).toString("base64url")}`;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const finish = (acknowledged, reason) => {
      const current = this.pending;
      if (!current || current.drainId !== drainId) return false;
      this.pending = null;
      this.scheduler.clearTimeout(current.timer);
      resolvePromise({ attempted: true, acknowledged, reason });
      return true;
    };
    const timer = this.scheduler.setTimeout(() => finish(false, "ack_timeout"), this.waitMs);
    timer?.unref?.();
    this.pending = { drainId, promise, finish, timer };
    let sent = false;
    try { sent = this.send?.({ type: "daemon_draining", drain_id: drainId, active_calls: Math.max(0, Number(activeCalls) || 0) }) === true; }
    catch { sent = false; }
    if (!sent) finish(false, "send_failed");
    return promise;
  }

  acknowledge(message) {
    const drainId = String(message?.drain_id || "");
    if (!/^drain_[A-Za-z0-9_-]{24}$/.test(drainId) || drainId !== this.pending?.drainId) return false;
    this.logger.event?.("info", "relay.planned_drain.acknowledged", {}, "Worker acknowledged planned daemon drain");
    return this.pending.finish(true, "acknowledged");
  }

  stop() { this.pending?.finish(false, "runtime_stopped"); }
}

export function handleRuntimeRelayShutdownAck(runtime, message, ready) {
  if (ready === true && runtime.relayShutdownDrain?.acknowledge?.(message)) return true;
  runtime.handleRelayProtocolViolation("invalid_daemon_draining_ack");
  return true;
}
