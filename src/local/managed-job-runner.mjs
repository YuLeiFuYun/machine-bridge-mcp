import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyOperationalError } from "./log.mjs";
import { ownerOnlyFile } from "./secure-file.mjs";
import { openPrivateAppendFile, trimDiagnosticFile } from "./managed-job-storage.mjs";
import { publishProvisionalRunnerClaim } from "./managed-job-runner-claim.mjs";
import { EXECUTION_SURFACE, withExecutionSurface } from "./execution-surface.mjs";
export { runnerProcessIsCurrent, runnerProcessIsCurrentAsync } from "./managed-job-runner-liveness.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./job-runner.mjs", import.meta.url));

export function launchRunner(dir, recover = false, recoveryToken = "", options = {}) {
  const launchToken = randomBytes(16).toString("hex");
  const args = [RUNNER_PATH, "--job-dir", dir];
  if (recover) args.push("--recover");
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
    child = spawnProcess(process.execPath, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      shell: false,
      env: managedRunnerEnvironment({ fullEnv: options.fullEnv === true, recoveryToken, launchToken, source: options.env || process.env }),
    });
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  ownerOnlyFile(stdoutFile);
  ownerOnlyFile(stderrFile);
  const logger = options.logger || console;
  child.once?.("error", (error) => {
    logger.error?.("managed job runner process reported an asynchronous failure", {
      recovery: recover,
      error_class: classifyOperationalError(error),
    });
  });
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
