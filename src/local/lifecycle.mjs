import { BridgeError } from "./errors.mjs";

const OPERATIONAL_STATES = new Set(["ready", "starting", "running"]);

export class LifecycleController {
  constructor(name = "runtime", now = Date.now) {
    this.name = String(name || "runtime");
    this.now = typeof now === "function" ? now : Date.now;
    this.state = "ready";
    this.changedAt = this.now();
    this.failureCode = "";
  }

  beginStart() {
    if (this.state === "running") return false;
    if (this.state !== "ready" && this.state !== "failed") {
      throw new BridgeError("conflict", `${this.name} cannot start from state ${this.state}`);
    }
    this.transition("starting");
    return true;
  }

  markRunning() {
    if (this.state !== "starting") throw new BridgeError("conflict", `${this.name} cannot become running from state ${this.state}`);
    this.failureCode = "";
    this.transition("running");
  }

  markFailed(error) {
    this.failureCode = String(error?.code || error?.name || "execution_failed").slice(0, 64);
    this.transition("failed");
  }

  markStopFailed(error) {
    if (this.state !== "stopping") throw new BridgeError("conflict", `${this.name} cannot fail stop from state ${this.state}`);
    this.failureCode = String(error?.code || error?.name || "execution_failed").slice(0, 64);
    this.transition("stop_failed");
  }

  beginStop() {
    if (this.state === "stopped" || this.state === "stopping") return false;
    this.transition("stopping");
    return true;
  }

  markStopped() {
    if (this.state !== "stopping") throw new BridgeError("conflict", `${this.name} cannot become stopped from state ${this.state}`);
    this.transition("stopped");
  }

  assertOperational() {
    if (!OPERATIONAL_STATES.has(this.state)) {
      throw new BridgeError("unavailable", `${this.name} is not operational (${this.state})`, { retryable: this.state !== "stopped" });
    }
  }

  snapshot() {
    return {
      state: this.state,
      operational: OPERATIONAL_STATES.has(this.state),
      changed_at_ms: this.changedAt,
      failure_code: this.failureCode,
    };
  }

  transition(next) {
    this.state = next;
    this.changedAt = this.now();
  }
}
