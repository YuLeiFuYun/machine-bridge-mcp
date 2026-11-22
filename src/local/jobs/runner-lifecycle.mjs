import { classifyOperationalError } from "../core/log.mjs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../core/errors.mjs";
import { resolveRuntimeNodeExecutable } from "../core/runtime-node.mjs";
import { openPrivateAppendFile, trimDiagnosticFile } from "./directory.mjs";
import { publishProvisionalRunnerClaim } from "./runner-claim.mjs";
import { EXECUTION_SURFACE, withExecutionSurface } from "../core/authority.mjs";

const DEFAULT_RECONCILE_DELAY_MS = 10_100;

const DEFAULT_RETRY_DELAY_MS = 10_100;

const DEFAULT_MAX_ATTEMPTS = 3;

const RETRYABLE_ERROR_CLASSES = new Set(["permission_denied", "conflict", "timeout", "resource_unavailable"]);

export function createManagedJobRunnerExitRecovery({
  reconcileStatus,
  logger = console,
  delayMs = DEFAULT_RECONCILE_DELAY_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const timers = new Set();
  let enabled = true;
  const boundedMaxAttempts = Math.max(1, Math.min(10, Number.parseInt(String(maxAttempts), 10) || DEFAULT_MAX_ATTEMPTS));

  function schedule(dir, waitMs, attempt) {
    if (!enabled) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!enabled) return;
      try { reconcileStatus(dir); }
      catch (error) {
        const errorClass = classifyOperationalError(error);
        const retryScheduled = attempt < boundedMaxAttempts && RETRYABLE_ERROR_CLASSES.has(errorClass);
        logger.warn?.("managed job runner exit reconciliation failed; retaining state for later recovery", {
          error_class: errorClass,
          recovery_attempt: attempt,
          retry_scheduled: retryScheduled,
        });
        if (retryScheduled) schedule(dir, retryDelayMs, attempt + 1);
      }
    }, Math.max(0, Number(waitMs) || 0));
    timer.unref?.();
    timers.add(timer);
  }

  return {
    observe(dir) { schedule(dir, delayMs, 1); },
    stop() {
      enabled = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
export { runnerProcessIsCurrent, runnerProcessIsCurrentAsync } from "./runner-claim.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./runner.mjs", import.meta.url));

export function launchRunner(dir, recover = false, recoveryToken = "", options = {}) {
  const launchToken = randomBytes(16).toString("hex");
  const args = [RUNNER_PATH, "--job-dir", dir];
  if (recover) args.push("--recover");
  const logger = options.logger || console;
  const runtimeNode = resolveRuntimeNodeExecutable({
    execPath: options.runtimeExecutable ?? process.execPath,
    argv0: options.runtimeLauncher ?? process.argv0,
    platform: options.platform ?? process.platform,
    isExecutable: options.isExecutable,
  });
  if (!runtimeNode.available) throw new BridgeError(
    "unavailable",
    "managed job runtime executable is unavailable; restart Machine Bridge to refresh its Node launcher",
    { retryable: true },
  );
  if (runtimeNode.fallback_active) logger.warn?.(
    "managed job runner is using the daemon original Node launcher because its concrete runtime executable is no longer available",
    { runtime_executable_source: runtimeNode.source, stale_exec_path: true, recovery: recover },
  );
  const stdoutFile = join(dir, "runner.out.log");
  const stderrFile = join(dir, "runner.err.log");
  trimDiagnosticFile(stdoutFile);
  trimDiagnosticFile(stderrFile);
  let stdoutFd;
  let stderrFd;
  let child;
  try {
    stdoutFd = openPrivateAppendFile(stdoutFile);
    stderrFd = openPrivateAppendFile(stderrFile);
    const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
    child = spawnProcess(runtimeNode.command, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      shell: false,
      env: managedRunnerEnvironment({ fullEnv: options.fullEnv === true, recoveryToken, launchToken, source: options.env || process.env }),
    });
    child.once?.("error", (error) => {
      try {
        logger.error?.("managed job runner process reported an asynchronous failure", {
          recovery: recover,
          error_class: classifyOperationalError(error),
        });
      } catch { /* A failed diagnostic sink must not crash the daemon after child settlement. */ }
    });
  } finally {
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* The child owns its duplicate; close every parent diagnostic descriptor without replacing launch errors. */ } }
    }
  }
  const pid = Number(child.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("managed job runner did not receive a process id");
  try {
    publishProvisionalRunnerClaim(dir, pid, launchToken);
  } catch (error) {
    try { child.kill?.("SIGKILL"); }
    catch { /* An uncommitted two-phase runner claim prevents this child from executing even if local kill delivery fails. */ }
    throw error;
  }
  if (typeof options.onExit === "function") {
    const alreadyExited = (child.exitCode !== undefined && child.exitCode !== null)
      || (child.signalCode !== undefined && child.signalCode !== null);
    if (alreadyExited) queueMicrotask(options.onExit);
    else child.once?.("exit", options.onExit);
  }
  child.unref();
  return pid;
}

export function managedRunnerEnvironment({ fullEnv = false, recoveryToken = "", launchToken = "", source = process.env } = {}) {
  const env = fullEnv ? { ...source } : {};
  if (!fullEnv) {
    for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "AGENT_RESOURCE_COORDINATOR_ROOT", "AGENT_BUILD_ROOT"]) {
      if (typeof source[key] === "string" && source[key]) env[key] = source[key];
    }
  }
  if (recoveryToken) env.MBM_RECOVERY_LOCK_TOKEN = recoveryToken;
  else delete env.MBM_RECOVERY_LOCK_TOKEN;
  if (launchToken) env.MBM_RUNNER_LAUNCH_TOKEN = launchToken;
  else delete env.MBM_RUNNER_LAUNCH_TOKEN;
  return withExecutionSurface(env, EXECUTION_SURFACE.managedJob);
}
