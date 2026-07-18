import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";

const WINDOWS_LAUNCHER = "service-launcher.cmd";
const WINDOWS_TASK_COMMAND_MAX_CHARS = 262;

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
