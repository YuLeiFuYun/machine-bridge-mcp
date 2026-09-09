import { spawn } from "node:child_process";
import { classifyOperationalError } from "./log.mjs";
import { MacosIdleSleepRecovery } from "./macos-idle-sleep-recovery.mjs";
export class MacosIdleSleepAssertion {
  constructor({ platform = process.platform, processId = process.pid, spawnProcess = spawn, logger = console, preventIdleSleep = true, preventSystemSleepOnAc = true, setTimer, clearTimer, wallNow } = {}) {
    this.supported = platform === "darwin";
    this.processId = processId;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.preventIdleSleep = Boolean(preventIdleSleep);
    this.preventSystemSleepOnAc = Boolean(preventSystemSleepOnAc);
    this.child = null;
    this.lastErrorClass = null;
    this.generation = 0;
    this.recovery = new MacosIdleSleepRecovery({ setTimer, clearTimer, wallNow, onRetry: () => this.spawnChild(), onTimerError: (error) => this.reportUnavailable(error) });
  }
  acquire() {
    if (!this.supported) return false;
    this.recovery.enable();
    if (this.child) return true;
    return this.spawnChild();
  }
  spawnChild() {
    let child = null;
    try {
      const args = [...(this.preventIdleSleep ? ["-i"] : []), ...(this.preventSystemSleepOnAc ? ["-s"] : []), "-w", String(this.processId)];
      child = this.spawnProcess("/usr/bin/caffeinate", args, {
        stdio: "ignore", shell: false, windowsHide: true,
      });
      this.child = child;
      this.generation += 1;
      child.unref?.();
      child.once?.("error", (error) => this.handleChildFailure(child, error));
      child.once?.("exit", () => this.handleChildFailure(child, new Error("idle-sleep assertion child exited before its owner process")));
      this.lastErrorClass = null;
      this.recovery.recovered();
      return true;
    } catch (error) {
      if (this.child === child) this.child = null;
      try { child?.kill?.("SIGTERM"); } catch { /* Best-effort cleanup after partial child setup. */ }
      this.reportUnavailable(error);
      this.recovery.failed();
      return false;
    }
  }
  handleChildFailure(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.reportUnavailable(error);
    this.recovery.failed();
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
    this.recovery.stop();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed === true) return;
    try { child.kill?.("SIGTERM"); } catch { /* -w binds any survivor to the owner process lifetime. */ }
  }
  snapshot() {
    return {
      supported: this.supported,
      active: Boolean(this.child),
      requests_idle_sleep_prevention: Boolean(this.child) && this.preventIdleSleep,
      requests_system_sleep_prevention_on_ac: Boolean(this.child) && this.preventSystemSleepOnAc,
      last_error_class: this.lastErrorClass,
      assertion_generation: this.generation,
      ...this.recovery.snapshot(),
    };
  }
}
