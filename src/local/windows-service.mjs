import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { waitForInactiveStatus } from "./service-convergence.mjs";

export const WINDOWS_TASK = "MachineBridgeMCP";
const WINDOWS_LAUNCHER = "service-launcher.cmd";
const WINDOWS_TASK_COMMAND_MAX_CHARS = 262;
const WINDOWS_STATUS_SCRIPT = [
  "$task = Get-ScheduledTask -TaskName 'MachineBridgeMCP' -ErrorAction SilentlyContinue;",
  "if ($null -eq $task) { exit 3 };",
  "$info = Get-ScheduledTaskInfo -TaskName 'MachineBridgeMCP' -ErrorAction Stop;",
  "$payload = [ordered]@{ state = $task.State.ToString(); last_result = [Int64]$info.LastTaskResult; last_run_time = $info.LastRunTime.ToUniversalTime().ToString('o') };",
  "[Console]::Out.Write(($payload | ConvertTo-Json -Compress))",
].join(" ");

export async function installWindowsTask(spec, logger = console, options = {}) {
  const run = requiredRun(options.run);
  const taskAction = windowsTaskAction(windowsLauncherPath(spec.stateRoot));
  const launcher = writeWindowsLauncher(spec);
  const create = await run("schtasks", [
    "/Create",
    "/TN", WINDOWS_TASK,
    "/SC", "ONLOGON",
    "/TR", taskAction,
    "/RL", "LIMITED",
    "/F",
  ]);
  const status = await waitForWindowsStatus(value => value.installed === true, { ...options, run });
  const ok = create?.code === 0 && status.installed === true;
  if (ok) logger.info?.("Windows Scheduled Task installed for user logon");
  else logger.warn?.("Windows Scheduled Task installation failed", { reason: windowsServiceFailureReason(create, status) });
  return {
    ok,
    provider: "schtasks",
    task: WINDOWS_TASK,
    trigger: "user_logon",
    launcher: launcher.path,
    launcher_restarts_on_failure: true,
    create,
    status,
    reason: ok ? "installed" : windowsServiceFailureReason(create, status),
  };
}

export async function startWindowsTask(logger = console, options = {}) {
  const run = requiredRun(options.run);
  const before = await statusWindowsTask({ ...options, run });
  if (before.installed === null) return { ok: false, provider: "schtasks", task: WINDOWS_TASK, reason: "task_status_unavailable", status: before };
  if (before.installed === false) return { ok: false, provider: "schtasks", task: WINDOWS_TASK, reason: "not_installed", status: before };
  const command = await run("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
  const after = await waitForWindowsStatus(
    status => status.active === true || completedSince(before, status),
    { ...options, run },
  );
  const completed = completedSince(before, after);
  const ok = after.active === true || completed;
  if (ok) logger.info?.("Windows Scheduled Task started");
  else logger.warn?.("Windows Scheduled Task did not reach a running or successful completed state");
  return {
    ok,
    provider: "schtasks",
    task: WINDOWS_TASK,
    command,
    status: after,
    reason: after.active === true ? "started" : completed ? "completed" : "start_not_observed",
  };
}

export async function stopWindowsTask(logger = console, options = {}) {
  const run = requiredRun(options.run);
  const before = await statusWindowsTask({ ...options, run });
  if (before.installed === null) return { ok: false, provider: "schtasks", task: WINDOWS_TASK, reason: "task_status_unavailable", status: before };
  if (before.installed === false || before.active === false) {
    return {
      ok: true,
      provider: "schtasks",
      task: WINDOWS_TASK,
      installed: before.installed,
      active_before: false,
      active: false,
      already_stopped: true,
      reason: before.installed ? "already_stopped" : "not_installed",
      status: before,
    };
  }
  const command = await run("schtasks", ["/End", "/TN", WINDOWS_TASK]);
  const after = await waitForInactiveStatus(
    () => statusWindowsTask({ ...options, run }),
    windowsStatusWaitOptions(options),
  );
  const ok = after?.active === false;
  if (ok) logger.info?.("Windows Scheduled Task stopped");
  else logger.warn?.("Windows Scheduled Task is still active after the stop request");
  return {
    ok,
    provider: "schtasks",
    task: WINDOWS_TASK,
    installed: after?.installed !== false,
    active_before: true,
    active: after?.active !== false,
    already_stopped: false,
    command,
    status: after,
    reason: ok ? "stopped" : "stop_not_observed",
  };
}

export async function uninstallWindowsTask(logger = console, options = {}) {
  const run = requiredRun(options.run);
  const stopped = await stopWindowsTask(logger, { ...options, run });
  if (!stopped.ok) return { ok: false, provider: "schtasks", task: WINDOWS_TASK, stop: stopped, reason: "stop_failed" };
  const command = await run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
  const status = await waitForWindowsStatus(
    value => value.installed === false,
    { ...options, run },
  );
  const ok = status.installed === false;
  if (ok) logger.info?.("Windows Scheduled Task removed");
  else logger.warn?.("Windows Scheduled Task removal could not be verified");
  return { ok, provider: "schtasks", task: WINDOWS_TASK, stop: stopped, command, status, reason: ok ? "removed" : "removal_not_observed" };
}

export async function statusWindowsTask(options = {}) {
  const run = requiredRun(options.run);
  const powershell = String(options.powershell || "powershell.exe");
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STATUS_SCRIPT]);
  if (result?.code === 3) {
    return { ok: false, provider: "schtasks", task: WINDOWS_TASK, installed: false, active: false, state: "missing" };
  }
  if (result?.code !== 0) {
    return { ok: false, provider: "schtasks", task: WINDOWS_TASK, installed: null, active: null, state: "unknown", query: result };
  }
  let payload;
  try { payload = JSON.parse(String(result.stdout || "")); } catch {
    return { ok: false, provider: "schtasks", task: WINDOWS_TASK, installed: null, active: null, state: "unknown", query: result };
  }
  const state = String(payload?.state || "").trim().toLowerCase();
  const lastResult = Number(payload?.last_result);
  const lastRunTime = typeof payload?.last_run_time === "string" ? payload.last_run_time : null;
  const active = state === "running";
  return {
    ok: true,
    provider: "schtasks",
    task: WINDOWS_TASK,
    installed: true,
    active,
    state: state || "unknown",
    last_result: Number.isFinite(lastResult) ? lastResult : null,
    last_run_time: lastRunTime,
  };
}

export function windowsLauncherPath(stateRoot) {
  return path.join(path.resolve(String(stateRoot)), WINDOWS_LAUNCHER);
}

export function writeWindowsLauncher(spec) {
  const launcherPath = windowsLauncherPath(spec.stateRoot);
  const content = windowsLauncherContent(spec);
  replaceFileAtomicallySync(launcherPath, content, { mode: 0o600 });
  return { path: launcherPath, content };
}

export function windowsLauncherContent(spec) {
  const command = [spec.node, ...(spec.daemonArgs || [])].map(windowsBatchArgument).join(" ");
  const stdout = windowsBatchArgument(spec.stdout);
  const stderr = windowsBatchArgument(spec.stderr);
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    ":restart",
    `${command} 1>>${stdout} 2>>${stderr}`,
    'set "mbm_exit=%ERRORLEVEL%"',
    'if "%mbm_exit%"=="0" exit /b 0',
    '"%SystemRoot%\\System32\\timeout.exe" /t 5 /nobreak >nul 2>&1',
    "goto restart",
    "",
  ].join("\r\n");
}

export function windowsTaskAction(launcherPath) {
  const action = String(launcherPath);
  if (action.includes("\0") || /[\r\n]/.test(action)) throw new Error("Windows autostart launcher path contains a prohibited control character");
  if (!path.isAbsolute(action) && !path.win32.isAbsolute(action)) throw new Error("Windows autostart launcher path must be absolute");
  if (action.includes("%")) throw new Error("Windows autostart launcher path must not contain a percent sign because Task Scheduler may expand it as an environment variable");
  if (action.length > WINDOWS_TASK_COMMAND_MAX_CHARS) {
    throw new Error(`Windows autostart action exceeds the ${WINDOWS_TASK_COMMAND_MAX_CHARS}-character Task Scheduler limit; use the default state directory or a shorter --state-dir`);
  }
  return action;
}

export function windowsCommandLineArgument(value) {
  const text = String(value);
  if (text.includes("\0")) throw new Error("Windows command-line argument contains a NUL byte");
  if (/[\r\n]/.test(text)) throw new Error("Windows command-line argument contains a line break");
  const escapedQuotes = text.replace(/(\\*)"/g, (_match, slashes) => `${slashes}${slashes}\\"`);
  const escapedTrailingSlashes = escapedQuotes.replace(/(\\+)$/, slashes => `${slashes}${slashes}`);
  return `"${escapedTrailingSlashes}"`;
}

export function windowsBatchArgument(value) {
  return windowsCommandLineArgument(value).replaceAll("%", "%%");
}

function completedSince(before, after) {
  return after?.installed === true
    && after.active === false
    && after.last_result === 0
    && Boolean(after.last_run_time)
    && after.last_run_time !== before?.last_run_time;
}

function windowsServiceFailureReason(command, status) {
  if (command?.code !== 0) return "task_create_failed";
  if (status?.installed === false) return "task_not_found_after_create";
  if (status?.installed === null) return "task_status_unavailable";
  return "task_installation_unverified";
}

async function waitForWindowsStatus(predicate, options) {
  const attempts = boundedPositiveInteger(options.statusAttempts, 10);
  const delayMs = boundedPositiveInteger(options.statusDelayMs, 100);
  const sleep = typeof options.sleep === "function" ? options.sleep : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  let status = await statusWindowsTask(options);
  for (let index = 1; index < attempts && !predicate(status); index += 1) {
    await sleep(delayMs);
    status = await statusWindowsTask(options);
  }
  return status;
}

function windowsStatusWaitOptions(options) {
  return {
    attempts: boundedPositiveInteger(options.statusAttempts, 10),
    delayMs: boundedPositiveInteger(options.statusDelayMs, 100),
    sleep: typeof options.sleep === "function" ? options.sleep : undefined,
  };
}

function requiredRun(run) {
  if (typeof run !== "function") throw new Error("Windows service command runner is required");
  return run;
}

function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
