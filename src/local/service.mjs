import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./shell.mjs";
import { ensureOwnerOnlyDir, expandHome, ownerOnlyFile } from "./state.mjs";
import { replaceFileSync } from "./atomic-fs.mjs";

const LABEL = "dev.machine-bridge-mcp.daemon";
const WINDOWS_TASK = "MachineBridgeMCP";
const SERVICE_COMMAND_OUTPUT_BYTES = 64 * 1024;

function serviceRun(command, args) {
  return run(command, args, {
    capture: true,
    allowFailure: true,
    maxOutputBytes: SERVICE_COMMAND_OUTPUT_BYTES,
  });
}

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
  if (process.platform === "win32") return serviceRun("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
  return serviceRun("systemctl", ["--user", "start", "machine-bridge-mcp.service"]);
}

export async function stopAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return stopLaunchd(logger);
  if (process.platform === "win32") return serviceRun("schtasks", ["/End", "/TN", WINDOWS_TASK]);
  return serviceRun("systemctl", ["--user", "stop", "machine-bridge-mcp.service"]);
}


export function trimAutostartLogs(stateRoot, options = {}) {
  const root = expandHome(stateRoot);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : 2 * 1024 * 1024;
  const keepBytes = Math.min(maxBytes, Number.isFinite(Number(options.keepBytes)) ? Math.max(1024, Number(options.keepBytes)) : 1024 * 1024);
  const logs = path.join(root, "logs");
  for (const name of ["daemon.out.log", "daemon.err.log"]) {
    const file = path.join(logs, name);
    let fd;
    try {
      if (!existsSync(file)) continue;
      const before = lstatSync(file);
      if (before.isSymbolicLink() || !before.isFile()) continue;
      const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
      fd = openSync(file, Number(fsConstants.O_RDWR) | noFollow);
      const info = fstatSync(fd);
      if (!info.isFile()) continue;
      if (info.size > maxBytes) {
        const length = Math.min(keepBytes, info.size);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, Math.max(0, info.size - length));
        const tail = lineSafeTail(buffer);
        ftruncateSync(fd, 0);
        if (tail.length) writeSync(fd, tail, 0, tail.length, 0);
      }
      try { chmodSync(file, 0o600); } catch {}
    } catch {
      // Operational log maintenance is best effort and must not stop startup.
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  }
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
  return {
    workspace,
    stateRoot: root,
    entryScript: resolvedEntryScript,
    node,
    pathEnv: serviceEnvironmentPath({ node, entryScript: resolvedEntryScript }),
    stdout: path.join(logs, "daemon.out.log"),
    stderr: path.join(logs, "daemon.err.log"),
  };
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
    "--no-print-credentials",
    "--log-level", "warn",
  ];
}

function ensurePrivateLogFile(file) {
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("autostart log path must be a regular non-symbolic-link file");
  }
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(file, Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_APPEND) | noFollow, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("autostart log path is not a regular file");
  } finally {
    closeSync(fd);
  }
  ownerOnlyFile(file);
}

function writePrivateServiceFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("autostart configuration path must be a regular non-symbolic-link file");
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    replaceFileSync(temporary, file);
    ownerOnlyFile(file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function launchdPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
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
  const target = `gui/${process.getuid?.() ?? ""}`;
  if (!existsSync(plistPath)) return { ok: false, error: "launchd plist not installed" };
  await serviceRun("launchctl", ["bootout", target, plistPath]);
  const boot = await serviceRun("launchctl", ["bootstrap", target, plistPath]);
  const kick = await serviceRun("launchctl", ["kickstart", "-k", `${target}/${LABEL}`]);
  logger.info?.("launchd service started");
  return { ok: boot.code === 0 || kick.code === 0, bootstrap: boot, kickstart: kick };
}

async function stopLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const target = `gui/${process.getuid?.() ?? ""}`;
  const result = await serviceRun("launchctl", ["bootout", target, plistPath]);
  logger.info?.("launchd service stopped");
  return result;
}

async function uninstallLaunchd(logger) {
  await stopLaunchd(logger).catch(() => {});
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) rmSync(plistPath, { force: true });
  logger.info?.("Autostart removed.");
  return { ok: true, provider: "launchd", path: plistPath };
}

async function statusLaunchd() {
  const plistPath = launchdPlistPath();
  const target = `gui/${process.getuid?.() ?? ""}/${LABEL}`;
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
  logger.info?.("Autostart installed.");
  return { ok: reload.code === 0 && enable.code === 0, provider: "systemd", path: servicePath, reload, enable, linger };
}

async function uninstallSystemd(logger) {
  await serviceRun("systemctl", ["--user", "disable", "--now", "machine-bridge-mcp.service"]);
  const servicePath = systemdPath();
  if (existsSync(servicePath)) rmSync(servicePath, { force: true });
  await serviceRun("systemctl", ["--user", "daemon-reload"]);
  logger.info?.("Autostart removed.");
  return { ok: true, provider: "systemd", path: servicePath };
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

async function installWindowsTask(spec, logger) {
  const command = windowsCommand(spec);
  const result = await serviceRun("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/SC", "ONLOGON", "/TR", command, "/F"]);
  logger.info?.("Windows Scheduled Task installed for logon");
  return { ok: result.code === 0, provider: "schtasks", task: WINDOWS_TASK, result };
}

async function uninstallWindowsTask(logger) {
  const result = await serviceRun("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
  logger.info?.("Windows Scheduled Task removed");
  return { ok: result.code === 0 || /cannot find/i.test(result.stderr), provider: "schtasks", task: WINDOWS_TASK, result };
}

async function statusWindowsTask() {
  const result = await serviceRun("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/FO", "LIST"]);
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
