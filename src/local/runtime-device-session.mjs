import { validateDeviceSessionIdentity } from "./device-identity.mjs";
import { classifyOperationalError } from "./log.mjs";

export const DEVICE_SESSION_RENEW_BEFORE_MS = 10 * 60_000;
export const DEVICE_SESSION_RETRY_MS = Object.freeze([1_000, 5_000, 30_000, 5 * 60_000]);

export class RuntimeDeviceSession {
  constructor({ identity, renew = null, onRotated = null, logger = {}, scheduler = { setTimeout, clearTimeout }, wallNow = Date.now } = {}) {
    this.renew = typeof renew === "function" ? renew : null;
    this.onRotated = typeof onRotated === "function" ? onRotated : () => {};
    this.logger = logger;
    this.scheduler = scheduler;
    this.wallNow = wallNow;
    this.identity = validateDeviceSessionIdentity(identity, this.wallNow());
    this.timer = null;
    this.started = false;
    this.generation = 1;
    this.failureCount = 0;
    this.lastRotatedAt = 0;
    this.lastErrorClass = "";
    this.renewalDueAt = 0;
  }

  current() {
    const now = this.wallNow();
    const retryDue = this.renewalDueAt || this.renewAt();
    if (this.renew && now >= this.renewAt() && now >= retryDue) this.rotate("authentication_boundary", false);
    return this.identity;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduleRenewal();
  }

  stop() {
    this.started = false;
    this.clearTimer();
  }

  snapshot() {
    const expiresAt = sessionExpiresAt(this.identity);
    return {
      renewable: Boolean(this.renew), automatic_renewal: Boolean(this.renew), session_generation: this.generation,
      expires_at: new Date(expiresAt).toISOString(),
      renewal_due_at: this.renew ? new Date(this.renewalDueAt || this.renewAt()).toISOString() : null,
      last_rotated_at: this.lastRotatedAt ? new Date(this.lastRotatedAt).toISOString() : null,
      renewal_failure_count: this.failureCount, last_renewal_error_class: this.lastErrorClass || null,
    };
  }

  rotate(reason = "scheduled", notify = true) {
    if (!this.renew) return false;
    try {
      const next = this.renew(this.wallNow());
      if (next && typeof next.then === "function") throw new TypeError("device session renewal must be synchronous");
      this.identity = validateDeviceSessionIdentity(next, this.wallNow());
      this.generation += 1;
      this.lastRotatedAt = this.wallNow();
      this.failureCount = 0;
      this.lastErrorClass = "";
      this.logger.event?.("info", "runtime.device_session.rotated", { generation: this.generation, reason }, "Runtime device session rotated");
      if (this.started) {
        this.scheduleRenewal();
        if (notify) this.onRotated({ generation: this.generation, reason });
      }
      return true;
    } catch (error) {
      this.failureCount += 1;
      this.lastErrorClass = classifyOperationalError(error);
      this.logger.event?.("warn", "runtime.device_session.renewal_failed", {
        error_class: this.lastErrorClass, failure_count: this.failureCount,
      }, "Runtime device session renewal failed");
      if (this.started) this.scheduleRetry();
      return false;
    }
  }

  renewAt() { return Math.max(0, sessionExpiresAt(this.identity) - DEVICE_SESSION_RENEW_BEFORE_MS); }

  scheduleRenewal() {
    this.clearTimer();
    if (!this.started || !this.renew) { this.renewalDueAt = 0; return; }
    this.renewalDueAt = this.renewAt();
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.rotate("scheduled"); }, Math.max(0, this.renewalDueAt - this.wallNow()));
    this.timer?.unref?.();
  }

  scheduleRetry() {
    this.clearTimer();
    if (!this.started || !this.renew) return;
    const index = Math.min(Math.max(0, this.failureCount - 1), DEVICE_SESSION_RETRY_MS.length - 1);
    const delay = DEVICE_SESSION_RETRY_MS[index];
    this.renewalDueAt = this.wallNow() + delay;
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.rotate("retry"); }, delay);
    this.timer?.unref?.();
  }

  clearTimer() {
    if (!this.timer) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

function sessionExpiresAt(identity) {
  const seconds = Number(identity?.certificate?.expires_at);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("device session expiry is invalid");
  return seconds * 1000;
}
