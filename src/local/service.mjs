import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./shell.mjs";
import { ensureOwnerOnlyDir, expandHome } from "./state.mjs";

const LABEL = "dev.machine-bridge-mcp.daemon";
const WINDOWS_TASK = "MachineBridgeMCP";

export async function installAutostart({ workspace, stateRoot, entryScript, logger = console }) {
  const spec = serviceSpec({ workspace, stateRoot, entryScript });
  if (process.platform === "darwin") return installLaunchd(spec, logger);
  if (process.platform === "win32") return installWindowsTask(spec, logger);
  return installSystemd(spec, logger);
}

export async function uninstallAutostart({ stateRoot, logger = console } = {}) {
  if (process.platform === "darwin") return uninstallLaunchd(logger);
  if (process.platform === "win32") return uninstallWindowsTask(logger);
  return uninstallSystemd(logger);
}

export async function autostartStatus({ logger = console } = {}) {
  if (process.platform === "darwin") return statusLaunchd(logger);
  if (process.platform === "win32") return statusWindowsTask(logger);
  return statusSystemd(logger);
}

export async function startAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return startLaunchd(logger);
  if (process.platform === "win32") return run("schtasks", ["/Run", "/TN", WINDOWS_TASK], { capture: true, allowFailure: true });
  return run("systemctl", ["--user", "start", "machine-bridge-mcp.service"], { capture: true, allowFailure: true });
}

export async function stopAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return stopLaunchd(logger);
  if (process.platform === "win32") return run("schtasks", ["/End", "/TN", WINDOWS_TASK], { capture: true, allowFailure: true });
  return run("systemctl", ["--user", "stop", "machine-bridge-mcp.service"], { capture: true, allowFailure: true });
}


export function trimAutostartLogs(stateRoot, options = {}) {
  const root = expandHome(stateRoot);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : 2 * 1024 * 1024;
  const keepBytes = Math.min(maxBytes, Number.isFinite(Number(options.keepBytes)) ? Math.max(1024, Number(options.keepBytes)) : 1024 * 1024);
  const logs = path.join(root, "logs");
  for (const name of ["daemon.out.log", "daemon.err.log"]) {
    const file = path.join(logs, name);
    try {
      const info = statSync(file);
      if (info.size > maxBytes) {
        const fd = openSync(file, "r");
        try {
          const current = fstatSync(fd);
          const length = Math.min(keepBytes, current.size);
          const buffer = Buffer.alloc(length);
          readSync(fd, buffer, 0, length, Math.max(0, current.size - length));
          writeFileSync(file, buffer, { mode: 0o600 });
        } finally {
          closeSync(fd);
        }
      }
      chmodSync(file, 0o600);
    } catch {}
  }
}

function serviceSpec({ workspace, stateRoot, entryScript }) {
  const root = expandHome(stateRoot);
  const logs = path.join(root, "logs");
  ensureOwnerOnlyDir(root);
  ensureOwnerOnlyDir(logs);
  for (const file of [path.join(logs, "daemon.out.log"), path.join(logs, "daemon.err.log")]) {
    writeFileSync(file, "", { flag: "a", mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  }
  return {
    workspace,
    stateRoot: root,
    entryScript: path.resolve(entryScript),
    node: process.execPath,
    stdout: path.join(logs, "daemon.out.log"),
    stderr: path.join(logs, "daemon.err.log"),
  };
}

export function daemonArgs(spec) {
  return [
    spec.entryScript,
    "start",
    "--daemon-only",
    "--workspace", spec.workspace,
    "--state-dir", spec.stateRoot,
    "--no-print-credentials",
    "--quiet",
  ];
}

function launchdPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

async function installLaunchd(spec, logger) {
  const plistPath = launchdPlistPath();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  const args = [spec.node, ...daemonArgs(spec)];
  writeFileSync(plistPath, launchdPlist({ args, stdout: spec.stdout, stderr: spec.stderr }), { mode: 0o644 });
  logger.info?.(`Autostart installed for next login: ${plistPath}`);
  return { ok: true, provider: "launchd", path: plistPath };
}

async function startLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const target = `gui/${process.getuid?.() ?? ""}`;
  if (!existsSync(plistPath)) return { ok: false, error: "launchd plist not installed" };
  await run("launchctl", ["bootout", target, plistPath], { capture: true, allowFailure: true });
  const boot = await run("launchctl", ["bootstrap", target, plistPath], { capture: true, allowFailure: true });
  const kick = await run("launchctl", ["kickstart", "-k", `${target}/${LABEL}`], { capture: true, allowFailure: true });
  logger.info?.("launchd service started");
  return { ok: boot.code === 0 || kick.code === 0, bootstrap: boot, kickstart: kick };
}

async function stopLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const target = `gui/${process.getuid?.() ?? ""}`;
  const result = await run("launchctl", ["bootout", target, plistPath], { capture: true, allowFailure: true });
  logger.info?.("launchd service stopped");
  return result;
}

async function uninstallLaunchd(logger) {
  await stopLaunchd(logger).catch(() => {});
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) rmSync(plistPath, { force: true });
  logger.info?.(`Autostart removed: ${plistPath}`);
  return { ok: true, provider: "launchd", path: plistPath };
}

async function statusLaunchd() {
  const plistPath = launchdPlistPath();
  const target = `gui/${process.getuid?.() ?? ""}/${LABEL}`;
  const result = await run("launchctl", ["print", target], { capture: true, allowFailure: true });
  return { ok: existsSync(plistPath), provider: "launchd", installed: existsSync(plistPath), path: plistPath, active: result.code === 0, detail: result.stdout || result.stderr };
}

function launchdPlist({ args, stdout, stderr }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
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
  writeFileSync(servicePath, systemdUnit(spec), { mode: 0o644 });
  const reload = await run("systemctl", ["--user", "daemon-reload"], { capture: true, allowFailure: true });
  const enable = await run("systemctl", ["--user", "enable", "machine-bridge-mcp.service"], { capture: true, allowFailure: true });
  const linger = await run("loginctl", ["enable-linger", os.userInfo().username], { capture: true, allowFailure: true });
  logger.info?.(`Autostart installed: ${servicePath}`);
  return { ok: reload.code === 0 && enable.code === 0, provider: "systemd", path: servicePath, reload, enable, linger };
}

async function uninstallSystemd(logger) {
  await run("systemctl", ["--user", "disable", "--now", "machine-bridge-mcp.service"], { capture: true, allowFailure: true });
  const servicePath = systemdPath();
  if (existsSync(servicePath)) rmSync(servicePath, { force: true });
  await run("systemctl", ["--user", "daemon-reload"], { capture: true, allowFailure: true });
  logger.info?.(`Autostart removed: ${servicePath}`);
  return { ok: true, provider: "systemd", path: servicePath };
}

async function statusSystemd() {
  const servicePath = systemdPath();
  const result = await run("systemctl", ["--user", "status", "machine-bridge-mcp.service", "--no-pager"], { capture: true, allowFailure: true });
  return { ok: existsSync(servicePath), provider: "systemd", installed: existsSync(servicePath), path: servicePath, active: result.code === 0, detail: result.stdout || result.stderr };
}

function systemdUnit(spec) {
  const execArgs = [spec.node, ...daemonArgs(spec)].map(systemdQuote).join(" ");
  return `[Unit]
Description=Machine Bridge MCP daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execArgs}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.stdout}
StandardError=append:${spec.stderr}

[Install]
WantedBy=default.target
`;
}

async function installWindowsTask(spec, logger) {
  const command = windowsCommand(spec);
  const result = await run("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/SC", "ONLOGON", "/TR", command, "/F"], { capture: true, allowFailure: true });
  logger.info?.("Windows Scheduled Task installed for logon");
  return { ok: result.code === 0, provider: "schtasks", task: WINDOWS_TASK, result };
}

async function uninstallWindowsTask(logger) {
  const result = await run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { capture: true, allowFailure: true });
  logger.info?.("Windows Scheduled Task removed");
  return { ok: result.code === 0 || /cannot find/i.test(result.stderr), provider: "schtasks", task: WINDOWS_TASK, result };
}

async function statusWindowsTask() {
  const result = await run("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/FO", "LIST"], { capture: true, allowFailure: true });
  return { ok: result.code === 0, provider: "schtasks", installed: result.code === 0, task: WINDOWS_TASK, active: result.code === 0, detail: result.stdout || result.stderr };
}

function windowsCommand(spec) {
  return [spec.node, ...daemonArgs(spec)].map(winQuote).join(" ");
}

function winQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
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
