import { closeSync, constants as fsConstants, existsSync, ftruncateSync, lstatSync, mkdirSync, readSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExecutable } from "./shell.mjs";
import { ensureOwnerOnlyDir, expandHome } from "./state.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { openRegularFileSync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { waitForInactiveStatus } from "./service-convergence.mjs";
import { writeServiceEnvironment } from "./service-environment.mjs";
import {
  installWindowsTask,
  startWindowsTask,
  statusWindowsTask,
  stopWindowsTask,
  uninstallWindowsTask,
} from "./windows-service.mjs";
export { windowsCommandLineArgument } from "./windows-service.mjs";

const LABEL = "dev.machine-bridge-mcp.daemon";
const SERVICE_COMMAND_OUTPUT_BYTES = 64 * 1024;
const AUTOSTART_LOG_SCHEMA_VERSION = 3;

function serviceRun(command, args) {
  return runServiceCommand(command, args);
}

export function runServiceCommand(command, args, execute = runExecutable) {
  return execute(command, args, {
    capture: true,
    allowFailure: true,
    maxOutputBytes: SERVICE_COMMAND_OUTPUT_BYTES,
  });
}

export async function installAutostart({ workspace, stateRoot, entryScript, logger = console }) {
  const spec = serviceSpec({ workspace, stateRoot, entryScript });
  const serviceEnvironment = writeServiceEnvironment(spec.stateRoot);
  let result;
  if (process.platform === "darwin") result = await installLaunchd(spec, logger);
  else if (process.platform === "win32") result = await installWindowsTask(spec, logger, { run: serviceRun });
  else result = await installSystemd(spec, logger);
  return { ...result, service_environment: serviceEnvironment };
}

export async function uninstallAutostart({ stateRoot, logger = console } = {}) {
  if (process.platform === "darwin") return uninstallLaunchd(logger);
  if (process.platform === "win32") return uninstallWindowsTask(logger, { run: serviceRun, stateRoot });
  return uninstallSystemd(logger);
}

export async function autostartStatus() {
  if (process.platform === "darwin") return statusLaunchd();
  if (process.platform === "win32") return statusWindowsTask({ run: serviceRun });
  return statusSystemd();
}

export async function startAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return startLaunchd(logger);
  if (process.platform === "win32") return startWindowsTask(logger, { run: serviceRun });
  return normalizeServiceCommandResult("systemd", await serviceRun("systemctl", ["--user", "start", "machine-bridge-mcp.service"]));
}

export async function stopAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return stopLaunchd(logger);
  if (process.platform === "win32") return stopWindowsTask(logger, { run: serviceRun });
  return normalizeServiceCommandResult("systemd", await serviceRun("systemctl", ["--user", "stop", "machine-bridge-mcp.service"]), { allowAlreadyStopped: true });
}

export function normalizeServiceCommandResult(provider, result, { allowAlreadyStopped = false } = {}) {
  const detail = `${result?.stdout || ""}
${result?.stderr || ""}`;
  const alreadyStopped = allowAlreadyStopped && /(?:not loaded|not found|does not exist|cannot find|not running|inactive)/i.test(detail);
  return {
    ...result,
    ok: result?.code === 0 || alreadyStopped,
    provider,
    already_stopped: alreadyStopped,
  };
}

export function trimAutostartLogs(stateRoot, options = {}) {
  const root = expandHome(stateRoot);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : 2 * 1024 * 1024;
  const keepBytes = Math.min(maxBytes, Number.isFinite(Number(options.keepBytes)) ? Math.max(1024, Number(options.keepBytes)) : 1024 * 1024);
  const schemaVersion = String(AUTOSTART_LOG_SCHEMA_VERSION);
  const logs = path.join(root, "logs");
  const schemaFile = path.join(logs, ".log-schema");
  const reset = readLogSchema(schemaFile) !== schemaVersion;

  for (const name of ["daemon.out.log", "daemon.err.log"]) {
    const file = path.join(logs, name);
    let fd;
    try {
      const opened = openRegularFileSync(file, fsConstants.O_RDWR, {
        label: "autostart log path",
        chmod: 0o600,
      });
      fd = opened.fd;
      if (reset) {
        ftruncateSync(fd, 0);
      } else if (opened.info.size > maxBytes) {
        const tail = readLogTail(fd, opened.info.size, keepBytes);
        ftruncateSync(fd, 0);
        if (tail.length) writeSync(fd, tail, 0, tail.length, 0);
      }
    } catch {
      // Log maintenance is best effort and must not stop daemon startup.
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  }

  try { writePrivateServiceFile(schemaFile, `${schemaVersion}\n`); } catch {}
}

function readLogSchema(file) {
  try { return readBoundedRegularFileSync(file, 64).toString("utf8").trim(); } catch { return ""; }
}

function readLogTail(fd, size, limit) {
  const length = Math.min(limit, size);
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, Math.max(0, size - length));
  return lineSafeTail(buffer);
}

function lineSafeTail(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return Buffer.alloc(0);
  let text = buffer.toString("utf8");
  const firstNewline = text.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < text.length - 1) text = text.slice(firstNewline + 1);
  else text = text.replace(/^\uFFFD+/, "");
  return Buffer.from(text, "utf8");
}

function serviceSpec({ workspace, stateRoot, entryScript }) {
  const root = expandHome(stateRoot);
  const logs = path.join(root, "logs");
  const resolvedEntryScript = path.resolve(entryScript);
  const node = stableNodeExecutable();
  ensureOwnerOnlyDir(root);
  ensureOwnerOnlyDir(logs);
  for (const file of [path.join(logs, "daemon.out.log"), path.join(logs, "daemon.err.log")]) ensurePrivateLogFile(file);
  const spec = {
    workspace,
    stateRoot: root,
    entryScript: resolvedEntryScript,
    node,
    pathEnv: serviceEnvironmentPath({ node, entryScript: resolvedEntryScript }),
    stdout: path.join(logs, "daemon.out.log"),
    stderr: path.join(logs, "daemon.err.log"),
  };
  return { ...spec, daemonArgs: daemonArgs(spec) };
}

export function stableNodeExecutable(options = {}) {
  const platform = String(options.platform || process.platform);
  const execPath = path.resolve(String(options.execPath || process.execPath));
  const pathEnv = String(options.pathEnv ?? process.env.PATH ?? "");
  let canonicalExec;
  try { canonicalExec = realpathSync(execPath); } catch { return execPath; }
  const executableName = platform === "win32" ? "node.exe" : "node";
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, executableName);
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      const candidateCanonical = realpathSync(candidate);
      const sameExecutable = platform === "win32"
        ? candidateCanonical.toLowerCase() === canonicalExec.toLowerCase()
        : candidateCanonical === canonicalExec;
      if (!sameExecutable) continue;
      if (platform !== "win32" && (statSync(candidate).mode & 0o111) === 0) continue;
      return candidate;
    } catch {}
  }
  return execPath;
}

export function serviceEnvironmentPath(options = {}) {
  const platform = String(options.platform || process.platform);
  const delimiter = String(options.delimiter || (platform === "win32" ? ";" : ":"));
  const pathEnv = String(options.pathEnv ?? process.env.PATH ?? "");
  const node = String(options.node || process.execPath || "");
  const entryScript = String(options.entryScript || "");
  const defaults = platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : platform === "win32"
      ? []
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  const candidates = [
    node ? path.dirname(path.resolve(node)) : "",
    entryScript ? path.dirname(path.resolve(entryScript)) : "",
    ...pathEnv.split(delimiter),
    ...defaults,
  ];
  const seen = new Set();
  const entries = [];
  for (const raw of candidates) {
    if (!raw || !path.isAbsolute(raw)) continue;
    const normalized = path.resolve(raw);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(normalized);
  }
  return entries.join(delimiter);
}

export function daemonArgs(spec) {
  return [
    spec.entryScript,
    "start",
    "--daemon-only",
    "--workspace", spec.workspace,
    "--state-dir", spec.stateRoot,
    "--log-level", "warn",
    "--log-format", "json",
  ];
}

function ensurePrivateLogFile(file) {
  const opened = openRegularFileSync(
    file,
    Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_APPEND),
    { label: "autostart log path", mode: 0o600, chmod: 0o600 },
  );
  closeSync(opened.fd);
}

function writePrivateServiceFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
}

function launchdPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function launchdServiceTarget(uid = process.getuid?.()) {
  const parsed = Number(uid);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("launchd requires a numeric user id");
  return `gui/${parsed}/${LABEL}`;
}

function launchdDomainTarget(uid = process.getuid?.()) {
  const parsed = Number(uid);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("launchd requires a numeric user id");
  return `gui/${parsed}`;
}

async function installLaunchd(spec, logger) {
  const plistPath = launchdPlistPath();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  const args = [spec.node, ...daemonArgs(spec)];
  writePrivateServiceFile(plistPath, launchdPlist({ args, pathEnv: spec.pathEnv, stdout: spec.stdout, stderr: spec.stderr }));
  logger.info?.("Autostart installed for next login.");
  return { ok: true, provider: "launchd", path: plistPath };
}

async function startLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const target = launchdDomainTarget();
  if (!existsSync(plistPath)) return { ok: false, error: "launchd plist not installed" };
  const stopped = await stopLaunchd({ info() {}, warn() {} });
  if (!stopped.ok) return { ok: false, provider: "launchd", stop: stopped };
  const boot = await serviceRun("launchctl", ["bootstrap", target, plistPath]);
  const kick = await serviceRun("launchctl", ["kickstart", "-k", `${target}/${LABEL}`]);
  const ok = boot.code === 0 || kick.code === 0;
  if (ok) logger.info?.("launchd service started");
  else logger.warn?.("launchd service failed to start");
  return { ok, provider: "launchd", bootstrap: boot, kickstart: kick };
}

async function stopLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const domainTarget = launchdDomainTarget();
  const serviceTarget = launchdServiceTarget();
  const before = await statusLaunchd();
  if (!before.active) {
    logger.info?.("launchd service is not loaded");
    return {
      ok: true,
      provider: "launchd",
      installed: existsSync(plistPath),
      active_before: false,
      active: false,
      already_stopped: true,
      code: 0,
      stdout: "",
      stderr: "",
    };
  }

  const byServiceTarget = await serviceRun("launchctl", ["bootout", serviceTarget]);
  const byPlist = byServiceTarget.code === 0
    ? null
    : await serviceRun("launchctl", ["bootout", domainTarget, plistPath]);
  const after = await waitForInactiveStatus(statusLaunchd);
  const rawResult = byPlist || byServiceTarget;
  const active = after?.active !== false;
  const ok = !active;
  if (ok) logger.info?.("launchd service stopped");
  else logger.warn?.("launchd service is still active after the stop request");
  return {
    ...rawResult,
    ok,
    provider: "launchd",
    installed: existsSync(plistPath),
    active_before: true,
    active,
    already_stopped: false,
    code: ok ? 0 : rawResult.code,
    bootout_service_target: byServiceTarget,
    ...(byPlist ? { bootout_plist_fallback: byPlist } : {}),
  };
}

async function uninstallLaunchd(logger) {
  const stopped = await stopLaunchd(logger);
  const plistPath = launchdPlistPath();
  if (!stopped.ok) return { ok: false, provider: "launchd", path: plistPath, stop: stopped };
  if (existsSync(plistPath)) rmSync(plistPath, { force: true });
  logger.info?.("Autostart removed.");
  return { ok: true, provider: "launchd", path: plistPath, stop: stopped };
}

async function statusLaunchd() {
  const plistPath = launchdPlistPath();
  const target = launchdServiceTarget();
  const result = await serviceRun("launchctl", ["print", target]);
  return { ok: existsSync(plistPath), provider: "launchd", installed: existsSync(plistPath), path: plistPath, active: result.code === 0, detail: result.stdout || result.stderr };
}

export function launchdPlist({ args, pathEnv, stdout, stderr }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict>
</plist>
`;
}

function systemdPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "machine-bridge-mcp.service");
}

async function installSystemd(spec, logger) {
  const servicePath = systemdPath();
  mkdirSync(path.dirname(servicePath), { recursive: true });
  writePrivateServiceFile(servicePath, systemdUnit(spec));
  const reload = await serviceRun("systemctl", ["--user", "daemon-reload"]);
  const enable = await serviceRun("systemctl", ["--user", "enable", "machine-bridge-mcp.service"]);
  const linger = await serviceRun("loginctl", ["enable-linger", os.userInfo().username]);
  const ok = reload.code === 0 && enable.code === 0;
  if (ok) logger.info?.("Autostart installed.");
  else logger.warn?.("Autostart installation failed; the service definition was kept for diagnosis.");
  return { ok, provider: "systemd", path: servicePath, reload, enable, linger };
}

async function uninstallSystemd(logger) {
  const servicePath = systemdPath();
  const disable = await serviceRun("systemctl", ["--user", "disable", "--now", "machine-bridge-mcp.service"]);
  const activeCheck = await serviceRun("systemctl", ["--user", "is-active", "machine-bridge-mcp.service"]);
  const active = activeCheck.code === 0;
  if (active) {
    logger.warn?.("systemd service is still active; its definition was not removed.");
    return { ok: false, provider: "systemd", path: servicePath, disable, active_check: activeCheck, active: true };
  }
  if (existsSync(servicePath)) rmSync(servicePath, { force: true });
  const reload = await serviceRun("systemctl", ["--user", "daemon-reload"]);
  const ok = reload.code === 0 && (disable.code === 0 || /not loaded|not found|does not exist/i.test(`${disable.stdout}
${disable.stderr}`));
  if (ok) logger.info?.("Autostart removed.");
  else logger.warn?.("Autostart removal reported an error.");
  return { ok, provider: "systemd", path: servicePath, disable, active_check: activeCheck, reload, active: false };
}

async function statusSystemd() {
  const servicePath = systemdPath();
  const result = await serviceRun("systemctl", ["--user", "status", "machine-bridge-mcp.service", "--no-pager"]);
  return { ok: existsSync(servicePath), provider: "systemd", installed: existsSync(servicePath), path: servicePath, active: result.code === 0, detail: result.stdout || result.stderr };
}

export function systemdUnit(spec) {
  const execArgs = [spec.node, ...daemonArgs(spec)].map(systemdQuote).join(" ");
  return `[Unit]
Description=Machine Bridge MCP daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execArgs}
Environment=${systemdQuote(`PATH=${spec.pathEnv}`)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.stdout}
StandardError=append:${spec.stderr}

[Install]
WantedBy=default.target
`;
}

export function systemdQuote(value) {
  const escaped = String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
