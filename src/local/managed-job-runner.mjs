import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcessInstance } from "./process-identity.mjs";
import { classifyOperationalError } from "./log.mjs";
import { ownerOnlyFile } from "./secure-file.mjs";
import { openPrivateAppendFile, readBoundedFile, trimDiagnosticFile } from "./managed-job-storage.mjs";
import { publishProvisionalRunnerClaim } from "./managed-job-runner-claim.mjs";

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
      job_id: basename(dir),
      recovery: recover,
      error_class: classifyOperationalError(error),
    });
  });
  const pid = Number(child.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("managed job runner did not receive a process id");
  try {
    publishProvisionalRunnerClaim(dir, pid, launchToken);
  } catch (error) {
    try { child.kill?.("SIGKILL"); } catch {}
    throw error;
  }
  child.unref();
  return pid;
}

export function runnerProcessIsCurrent(status, dir, { ownerOnly = false } = {}) {
  const fallback = ownerOnly ? status : {
    pid: Number(status?.runner_pid) || undefined,
    processStartedAt: status?.runner_process_started_at,
    startedAt: status?.started_at || status?.updated_at || status?.created_at,
  };
  const owner = readRunnerOwner(dir, fallback);
  if (!owner.pid) return false;
  const identity = inspectProcessInstance(owner, { maxAgeMs: Number.POSITIVE_INFINITY });
  return identity.current || (identity.alive && !identity.reclaimable);
}

function readRunnerOwner(dir, fallback = {}) {
  let text;
  try { text = readBoundedFile(join(dir, "runner.pid"), 1024).toString("utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { ...fallback }; throw error; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...fallback };
    return { ...fallback, ...parsed };
  } catch { return { ...fallback }; }
}

export function managedRunnerEnvironment({ fullEnv = false, recoveryToken = "", launchToken = "", source = process.env } = {}) {
  const env = fullEnv ? { ...source } : {};
  if (!fullEnv) {
    for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP"]) {
      if (typeof source[key] === "string" && source[key]) env[key] = source[key];
    }
  }
  if (recoveryToken) env.MBM_RECOVERY_LOCK_TOKEN = recoveryToken;
  else delete env.MBM_RECOVERY_LOCK_TOKEN;
  if (launchToken) env.MBM_RUNNER_LAUNCH_TOKEN = launchToken;
  else delete env.MBM_RUNNER_LAUNCH_TOKEN;
  return env;
}
