import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-sessions.mjs";

export class ProcessTracker {
  constructor() {
    this.active = new Set();
    this.byCall = new Map();
  }

  track(child, callId = "") {
    if (!child) return;
    this.active.add(child);
    if (!callId) return;
    const id = String(callId);
    const children = this.byCall.get(id) || new Set();
    children.add(child);
    this.byCall.set(id, children);
  }

  untrack(child) {
    if (!child) return;
    this.active.delete(child);
    for (const [callId, children] of this.byCall) {
      children.delete(child);
      if (!children.size) this.byCall.delete(callId);
    }
  }

  releaseCall(callId) {
    if (callId) this.byCall.delete(String(callId));
  }

  terminateCall(callId, { force = false } = {}) {
    const children = [...(this.byCall.get(String(callId || "")) || [])];
    for (const child of children) {
      if (force) terminateProcessTree(child, "SIGKILL");
      else terminateProcessTreeWithEscalation(child);
    }
    return children.length;
  }

  terminateAll(signal = "SIGTERM", escalate = false) {
    for (const child of [...this.active]) {
      if (escalate && signal !== "SIGKILL") terminateProcessTreeWithEscalation(child);
      else terminateProcessTree(child, signal);
    }
  }

  snapshot() {
    return { active_processes: this.active.size, calls_with_processes: this.byCall.size };
  }
}
