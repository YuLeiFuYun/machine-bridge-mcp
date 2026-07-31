import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-tree.mjs";

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
  }

  track(child, callId = "") {
    if (!child) return;
    this.active.add(child);
    if (!callId) return;
    const id = String(callId);
    const children = this.byCall.get(id) || new Set();
    children.add(child);
    this.byCall.set(id, children);
    this.childCall.set(child, id);
  }

  untrack(child) {
    if (!child) return;
    this.active.delete(child);
    this.terminating.delete(child);
    const callId = this.childCall.get(child);
    this.childCall.delete(child);
    if (callId) {
      const children = this.byCall.get(callId);
      children?.delete(child);
      if (!children?.size) {
        this.byCall.delete(callId);
        this.releasedCalls.delete(callId);
      }
      return;
    }
    for (const [id, children] of this.byCall) {
      children.delete(child);
      if (!children.size) {
        this.byCall.delete(id);
        this.releasedCalls.delete(id);
      }
    }
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
}
