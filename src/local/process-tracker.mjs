import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { BridgeError } from "./errors.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

const DEFAULT_DRAIN_WAIT_MS = 5_000;

export class ProcessTracker {
  constructor(options = {}) {
    this.terminate = typeof options.terminate === "function" ? options.terminate : terminateProcessTree;
    this.terminateWithEscalation = typeof options.terminateWithEscalation === "function"
      ? options.terminateWithEscalation
      : terminateProcessTreeWithEscalation;
    this.clearScheduledTermination = typeof options.clearScheduledTermination === "function"
      ? options.clearScheduledTermination
      : clearTimeout;
    this.active = new Set();
    this.byCall = new Map();
    this.childCall = new Map();
    this.releasedCalls = new Set();
    this.terminating = new Set();
    this.terminationTimers = new Map();
    this.drainSignal = null;
    this.drainRequested = new Set();
    this.changeWaiters = new Set();
  }

  track(child, callId = "") {
    if (!child) return;
    this.active.add(child);
    if (callId) {
      const id = String(callId);
      const children = this.byCall.get(id) || new Set();
      children.add(child);
      this.byCall.set(id, children);
      this.childCall.set(child, id);
    }
    if (this.drainSignal) this.requestDrainTermination(child);
    this.notifyChange();
  }

  untrack(child) {
    if (!child) return;
    this.active.delete(child);
    this.terminating.delete(child);
    this.drainRequested.delete(child);
    const callId = this.childCall.get(child);
    this.childCall.delete(child);
    if (callId) {
      const children = this.byCall.get(callId);
      children?.delete(child);
      if (!children?.size) {
        this.byCall.delete(callId);
        this.releasedCalls.delete(callId);
      }
      this.notifyChange();
      return;
    }
    for (const [id, children] of this.byCall) {
      children.delete(child);
      if (!children.size) {
        this.byCall.delete(id);
        this.releasedCalls.delete(id);
      }
    }
    this.notifyChange();
  }

  releaseCall(callId) {
    const id = String(callId || "");
    if (!id) return;
    if (this.byCall.get(id)?.size) this.releasedCalls.add(id);
    else {
      this.byCall.delete(id);
      this.releasedCalls.delete(id);
    }
  }

  terminateCall(callId, { force = false } = {}) {
    const children = [...(this.byCall.get(String(callId || "")) || [])];
    for (const child of children) {
      this.terminating.add(child);
      this.requestTermination(child, force);
    }
    return children.length;
  }

  terminateAll(signal = "SIGTERM", escalate = false) {
    for (const child of [...this.active]) {
      this.terminating.add(child);
      if (escalate && signal !== "SIGKILL") this.requestTermination(child, false);
      else {
        this.clearTermination(child);
        this.terminate(child, signal);
      }
    }
  }

  async drain(signal = "SIGKILL", waitMs = DEFAULT_DRAIN_WAIT_MS) {
    const boundedWaitMs = Number.isFinite(Number(waitMs)) ? Math.max(1, Math.min(30_000, Math.floor(Number(waitMs)))) : DEFAULT_DRAIN_WAIT_MS;
    this.drainSignal = signal;
    const deadline = createMonotonicDeadline(boundedWaitMs);
    while (this.active.size) {
      for (const child of [...this.active]) this.requestDrainTermination(child);
      if (!this.active.size) break;
      if (deadline.expired()) break;
      await this.waitForChange(Math.max(1, deadline.remainingMs()));
    }
    if (this.active.size) {
      for (const child of this.active) this.drainRequested.delete(child);
      throw new BridgeError("unavailable", "process shutdown did not settle before the runtime teardown deadline", {
        retryable: true,
        details: { active_processes: this.active.size },
      });
    }
  }

  snapshot() {
    let activeCalls = 0;
    let drainingCalls = 0;
    let drainingProcesses = 0;
    for (const [callId, children] of this.byCall) {
      if (this.releasedCalls.has(callId)) {
        drainingCalls += 1;
        drainingProcesses += children.size;
      } else activeCalls += 1;
    }
    return {
      active_processes: this.active.size,
      calls_with_processes: activeCalls,
      draining_calls: drainingCalls,
      draining_processes: drainingProcesses,
      terminating_processes: this.terminating.size,
      termination_escalations_pending: this.terminationTimers.size,
    };
  }

  requestTermination(child, force) {
    if (force) {
      this.clearTermination(child);
      this.terminate(child, "SIGKILL");
      return;
    }
    if (this.terminationTimers.has(child)) return;
    const timer = this.terminateWithEscalation(child, {
      onTerminationSettled: () => { this.terminationTimers.delete(child); },
    });
    if (timer) this.terminationTimers.set(child, timer);
  }

  clearTermination(child) {
    const timer = this.terminationTimers.get(child);
    if (!timer) return;
    this.clearScheduledTermination(timer);
    this.terminationTimers.delete(child);
  }

  requestDrainTermination(child) {
    if (!child || this.drainRequested.has(child)) return;
    this.drainRequested.add(child);
    this.terminating.add(child);
    this.clearTermination(child);
    try { this.terminate(child, this.drainSignal || "SIGKILL"); }
    catch { /* Drain completion is proven by close/untrack, never by the kill request alone. */ }
  }

  waitForChange(waitMs) {
    return new Promise((resolvePromise) => {
      let timer;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.changeWaiters.delete(done);
        resolvePromise();
      };
      this.changeWaiters.add(done);
      timer = setTimeout(done, waitMs);
    });
  }

  notifyChange() {
    for (const waiter of [...this.changeWaiters]) waiter();
  }
}
