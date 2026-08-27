import { spawn } from "node:child_process";
import { classifyOperationalError } from "./log.mjs";

export class MacosIdleSleepAssertion {
  constructor({ platform = process.platform, processId = process.pid, spawnProcess = spawn, logger = console } = {}) {
    this.supported = platform === "darwin";
    this.processId = processId;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.child = null;
    this.lastErrorClass = null;
  }

  acquire() {
    if (!this.supported) return false;
    if (this.child) return true;
    let child = null;
    try {
      child = this.spawnProcess("/usr/bin/caffeinate", ["-i", "-s", "-w", String(this.processId)], {
        stdio: "ignore", shell: false, windowsHide: true,
      });
      this.child = child;
      child.unref?.();
      child.once?.("error", (error) => this.handleChildFailure(child, error));
      child.once?.("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.reportUnavailable(new Error("idle-sleep assertion child exited before its owner process"));
      });
      this.lastErrorClass = null;
      return true;
    } catch (error) {
      if (this.child === child) this.child = null;
      try { child?.kill?.("SIGTERM"); } catch { /* Best-effort cleanup after partial child setup. */ }
      this.reportUnavailable(error);
      return false;
    }
  }

  handleChildFailure(child, error) {
    if (this.child === child) this.child = null;
    this.reportUnavailable(error);
  }

  reportUnavailable(error) {
    const errorClass = classifyOperationalError(error);
    if (this.lastErrorClass === errorClass) return;
    this.lastErrorClass = errorClass;
    try {
      this.logger.event?.("warn", "runtime.idle_sleep_guard.unavailable", { error_class: errorClass },
        "macOS idle-sleep assertion is unavailable");
    } catch { /* Auxiliary power-management logging must never affect the owning workload. */ }
  }

  release() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed === true) return;
    try { child.kill?.("SIGTERM"); } catch { /* -w binds any survivor to the owner process lifetime. */ }
  }

  snapshot() {
    return {
      supported: this.supported,
      active: Boolean(this.child),
      requests_system_sleep_prevention_on_ac: Boolean(this.child),
      last_error_class: this.lastErrorClass,
    };
  }
}
