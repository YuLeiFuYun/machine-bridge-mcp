import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-sessions.mjs";

export class ProcessTracker {
  constructor(options = {}) {
    this.terminate = typeof options.terminate === "function" ? options.terminate : terminateProcessTree;
    this.terminateWithEscalation = typeof options.terminateWithEscalation === "function"
      ? options.terminateWithEscalation
      : terminateProcessTreeWithEscalation;
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
      if (force) this.terminate(child, "SIGKILL");
      else this.terminateWithEscalation(child);
    }
    return children.length;
  }

  terminateAll(signal = "SIGTERM", escalate = false) {
    for (const child of [...this.active]) {
      if (escalate && signal !== "SIGKILL") this.terminateWithEscalation(child);
      else this.terminate(child, signal);
    }
  }

  snapshot() {
    return { active_processes: this.active.size, calls_with_processes: this.byCall.size };
  }
}
