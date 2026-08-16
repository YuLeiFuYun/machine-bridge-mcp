import { closeSync, constants as fsConstants, existsSync, ftruncateSync, lstatSync, mkdirSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExecutable } from "./shell.mjs";
import { expandHome } from "./state.mjs";
import { ensureOwnerOnlyDir } from "./secure-file.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { openRegularFileSync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { waitForInactiveStatus, waitForStableActiveStatus, waitForStatus } from "./service-convergence.mjs";
import { launchdStatusSummary, systemdStatusSummary } from "./service-status.mjs";
import { systemdRemovalDecision } from "./systemd-removal.mjs";
import { removeServiceDefinitionIfCurrent, snapshotServiceDefinition } from "./service-definition.mjs";
import { writeServiceEnvironment } from "./service-environment.mjs";
import { beginServiceOwnerUpdate, removeServiceOwner } from "./service-owner.mjs";
import {
  installWindowsTask,
  restartWindowsTask,
  startWindowsTask,
  statusWindowsTask,
  stopWindowsTask,
  uninstallWindowsTask,
} from "./windows-service.mjs";
export { windowsCommandLineArgument } from "./windows-service.mjs";

const LABEL = "dev.machine-bridge-mcp.daemon";
const SERVICE_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SERVICE_COMMAND_TIMEOUT_MS = 30_000;
const AUTOSTART_LOG_SCHEMA_VERSION = 4;

function serviceRun(command, args) {
  return runServiceCommand(command, args);
}

export function runServiceCommand(command, args, execute = runExecutable) {
  return execute(command, args, {
    capture: true,
    allowFailure: true,
    timeoutMs: SERVICE_COMMAND_TIMEOUT_MS,
    maxOutputBytes: SERVICE_COMMAND_OUTPUT_BYTES,
  });
}

export async function installAutostart({ workspace, stateRoot, entryScript, version, logger = console,
  installProvider = defaultInstallProvider, beginOwnerUpdate = beginServiceOwnerUpdate,
  writeEnvironment = writeServiceEnvironment, deferOwnerCommit = false } = {}) {
  const spec = serviceSpec({ workspace, stateRoot, entryScript });
  const ownerUpdate = beginOwnerUpdate({ ...spec, version });
  let serviceEnvironment;
  try { serviceEnvironment = writeEnvironment(spec.stateRoot); }
  catch (error) {
    try { ownerUpdate.rollback(); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        "service environment preparation failed and the previous machine service owner could not be restored");
    }
    throw error;
  }
  let result;
  try { result = await installProvider(spec, logger); }
  catch (error) {
    throw new Error(
      "autostart installation threw after its machine service owner became pending; service start is blocked until reinstall",
      { cause: error },
    );
  }
  if (result?.ok !== true) {
    return withDeferredOwnerTransaction({
      ...result,
      service_environment: serviceEnvironment,
      service_owner: { status: "pending", version },
      reason: result?.reason || "installation_failed_owner_pending",
    }, ownerUpdate, deferOwnerCommit);
  }
  if (deferOwnerCommit) {
    return withDeferredOwnerTransaction({
      ...result,
      service_environment: serviceEnvironment,
      service_owner: { status: "pending", version },
    }, ownerUpdate, true);
  }
  let owner;
  try { owner = ownerUpdate.commit(); }
  catch (error) {
    throw new Error(
      "autostart definition was installed but its machine service owner could not be committed; the pending owner was retained and service start is blocked until reinstall",
      { cause: error },
    );
  }
  return { ...result, service_environment: serviceEnvironment, service_owner: { status: owner.status, version: owner.version } };
}

function withDeferredOwnerTransaction(result, ownerUpdate, enabled) {
  if (!enabled) return result;
  if (!ownerUpdate?.owner || ownerUpdate.owner.status !== "pending"
      || typeof ownerUpdate.commit !== "function" || typeof ownerUpdate.rollback !== "function") {
    throw new Error("deferred machine service owner transaction is unavailable");
  }
  Object.defineProperty(result, "serviceOwnerTransaction", {
    value: Object.freeze({
      owner: ownerUpdate.owner,
      commit: () => ownerUpdate.commit(),
      rollback: () => ownerUpdate.rollback(),
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

async function defaultInstallProvider(spec, logger) {
  if (process.platform === "darwin") return installLaunchd(spec, logger);
  if (process.platform === "win32") return installWindowsTask(spec, logger, { run: serviceRun });
  return installSystemd(spec, logger);
}


export async function uninstallAutostart({ stateRoot, logger = console } = {}) {
  let result;
  if (process.platform === "darwin") result = await uninstallLaunchd(logger);
  else if (process.platform === "win32") result = await uninstallWindowsTask(logger, { run: serviceRun, stateRoot });
  else result = await uninstallSystemd(logger);
  if (result?.ok === true) removeServiceOwner();
  return result;
}

export async function autostartStatus() {
  if (process.platform === "darwin") return statusLaunchd();
  if (process.platform === "win32") return statusWindowsTask({ run: serviceRun });
  return statusSystemd();
}

export async function startAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return startLaunchd(logger);
  if (process.platform === "win32") return startWindowsTask(logger, { run: serviceRun });
  return startSystemd(logger);
}

export async function restartAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return restartLaunchd(logger);
  if (process.platform === "win32") return restartWindowsTask(logger, { run: serviceRun });
  return restartSystemd(logger);
}

export async function stopAutostart({ logger = console } = {}) {
  if (process.platform === "darwin") return stopLaunchdService(logger);
  if (process.platform === "win32") return stopWindowsTask(logger, { run: serviceRun });
  return stopSystemdService(logger);
}

export function trimAutostartLogs(stateRoot, options = {}) {
  const root = expandHome(stateRoot);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : 2 * 1024 * 1024;
  const keepBytes = Math.min(maxBytes, Number.isFinite(Number(options.keepBytes)) ? Math.max(1024, Number(options.keepBytes)) : 1024 * 1024);
  const schemaVersion = String(AUTOSTART_LOG_SCHEMA_VERSION);
  const logs = path.join(root, "logs");
  ensureOwnerOnlyDir(logs);
  const schemaFile = path.join(logs, ".log-schema");
  const reset = readLogSchema(schemaFile) !== schemaVersion;
  const openedLogs = [];
  try {
    for (const name of ["daemon.out.log", "daemon.err.log"]) {
      const file = path.join(logs, name);
      ensurePrivateLogFile(file);
      openedLogs.push(openRegularFileSync(file, fsConstants.O_RDWR, {
        label: "autostart log path", chmod: 0o600, rejectMultipleLinks: true,
      }));
    }
    for (const opened of openedLogs) {
      if (reset) {
        ftruncateSync(opened.fd, 0);
      } else if (opened.info.size > maxBytes) {
        const tail = readLogTail(opened.fd, opened.info.size, keepBytes);
        ftruncateSync(opened.fd, 0);
        if (tail.length) writeSync(opened.fd, tail, 0, tail.length, 0);
      }
    }
    writePrivateServiceFile(schemaFile, `${schemaVersion}\n`);
  } finally {
    for (const opened of openedLogs) {
      try { closeSync(opened.fd); }
      catch { /* Descriptor cleanup cannot improve the already-completed log rotation outcome. */ }
    }
  }
}

function readLogSchema(file) {
  try {
    return readBoundedRegularFileSync(file, 64, "autostart log schema", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).toString("utf8").trim();
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
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
    } catch { /* Inaccessible or transient PATH candidates are skipped in favor of the known executable. */ }
  }
  return execPath;
}

export function serviceEnvironmentPath(options = {}) {
  const platform = String(options.platform || process.platform);
  const pathApi = platform === "win32" ? path.win32 : path;
  const delimiter = String(options.delimiter || (platform === "win32" ? ";" : ":"));
  const pathEnv = String(options.pathEnv ?? process.env.PATH ?? "");
  const node = String(options.node || process.execPath || "");
  const entryScript = String(options.entryScript || "");
  const entryDirectory = entryScript ? pathApi.dirname(pathApi.resolve(entryScript)) : "";
  const defaults = platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : platform === "win32"
      ? []
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  const inheritedEntries = stripNpmLifecyclePathPrefix(pathEnv.split(delimiter));
  const candidates = [
    node ? pathApi.dirname(pathApi.resolve(node)) : "",
    entryDirectory,
    ...inheritedEntries,
    ...defaults,
  ];
  const seen = new Set();
  const entries = [];
  for (const raw of candidates) {
    if (!raw || !pathApi.isAbsolute(raw)) continue;
    const normalized = pathApi.resolve(raw);
    if (isInactiveCandidateRuntimePath(normalized, entryDirectory, platform)) continue;
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(normalized);
  }
  return entries.join(delimiter);
}

function stripNpmLifecyclePathPrefix(entries) {
  let lastMarker = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const portable = String(entries[index] || "").replaceAll("\\", "/").toLowerCase();
    if (portable.endsWith("/node-gyp-bin") && portable.includes("/@npmcli/run-script/")) lastMarker = index;
  }
  return lastMarker >= 0 ? entries.slice(lastMarker + 1) : entries;
}

function isInactiveCandidateRuntimePath(candidate, entryDirectory, platform) {
  if (!entryDirectory) return false;
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalize = (value) => {
    const resolved = pathApi.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const current = normalize(entryDirectory);
  const portable = current.replaceAll("\\", "/");
  const marker = "/release-channels/runtimes/";
  const markerIndex = portable.indexOf(marker);
  if (markerIndex < 0) return false;
  const runtimeContainer = portable.slice(0, markerIndex + marker.length - 1);
  const normalizedCandidate = normalize(candidate).replaceAll("\\", "/");
  return normalizedCandidate !== portable
    && (normalizedCandidate === runtimeContainer || normalizedCandidate.startsWith(`${runtimeContainer}/`));
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
    { label: "autostart log path", mode: 0o600, chmod: 0o600, rejectMultipleLinks: true },
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
  const domainTarget = launchdDomainTarget();
  const serviceTarget = launchdServiceTarget();
  if (!existsSync(plistPath)) return { ok: false, provider: "launchd", installed: false, loaded: false, active: false, reason: "not_installed" };
  const before = await statusLaunchd();
  if (before.status_available !== true || typeof before.active !== "boolean") {
    return { ok: false, provider: "launchd", installed: true, loaded: null, active: null, reason: "status_unavailable", status: before };
  }
  if (before.active) {
    const existing = await waitForStableActiveStatus(statusLaunchd);
    if (existing.stable) {
      logger.info?.("launchd service is already running");
      return { ...existing.status, ok: true, active_before: true, already_running: true, reason: "already_running" };
    }
  }
  const boot = before.loaded
    ? { code: 0, stdout: "", stderr: "", already_loaded: true }
    : await serviceRun("launchctl", ["bootstrap", domainTarget, plistPath]);
  const kick = await serviceRun("launchctl", ["kickstart", serviceTarget]);
  const stability = await waitForStableActiveStatus(statusLaunchd);
  const after = stability.status;
  const ok = stability.stable;
  if (ok) logger.info?.("launchd service started");
  else logger.warn?.("launchd service failed to start");
  return {
    ok,
    provider: "launchd",
    installed: true,
    loaded: after?.loaded === true,
    active_before: false,
    active: after?.active === true,
    bootstrap: boot,
    kickstart: kick,
  };
}

async function restartLaunchd(logger) {
  const plistPath = launchdPlistPath();
  if (!existsSync(plistPath)) return { ok: false, provider: "launchd", installed: false, reason: "not_installed" };
  const before = await statusLaunchd();
  if (before.status_available !== true || typeof before.active !== "boolean") {
    return { ok: false, provider: "launchd", installed: true, active: null, restarted: false, reason: "status_unavailable", status: before };
  }
  if (!before.active) {
    const started = await startLaunchd(logger);
    return { ...started, restarted: false, reason: started.ok ? "started_inactive_service" : started.reason || "start_failed" };
  }
  const target = launchdServiceTarget();
  const previousPid = before.pid;
  const kick = await serviceRun("launchctl", ["kickstart", "-k", target]);
  const changed = await waitForStatus(
    statusLaunchd,
    (status) => status?.active === true && (!previousPid || status.pid !== previousPid),
  );
  const stability = changed?.active === true && (!previousPid || changed.pid !== previousPid)
    ? await waitForStableActiveStatus(statusLaunchd, { identity: (status) => status?.pid || null })
    : { stable: false, status: changed };
  const after = stability.status;
  const ok = kick.code === 0 && stability.stable && (!previousPid || after?.pid !== previousPid);
  if (ok) logger.info?.("launchd service restarted");
  else logger.warn?.("launchd service restart could not be verified");
  return { ok, provider: "launchd", installed: true, active_before: true, active: after?.active === true && stability.stable, restarted: ok, kickstart: kick };
}

export async function stopLaunchdService(logger = console, options = {}) {
  const plistPath = launchdPlistPath();
  const run = typeof options.run === "function" ? options.run : serviceRun;
  const readStatus = typeof options.readStatus === "function" ? options.readStatus : statusLaunchd;
  const waitForUnloaded = typeof options.waitForUnloaded === "function"
    ? options.waitForUnloaded
    : callback => waitForStatus(callback, launchdStatusIsSafelyUnloaded, { attempts: 100, delayMs: 100 });
  const before = await readStatus();
  if (!before.loaded) {
    if (!launchdStatusIsSafelyUnloaded(before)) {
      return {
        ok: false, provider: "launchd", installed: before?.installed === true, loaded: null,
        active_before: null, active: null, restore_required: null, already_stopped: false,
        reason: "status_unavailable", status: before,
      };
    }
    logger.info?.("launchd service is not loaded");
    return {
      ok: true,
      provider: "launchd",
      installed: before?.installed === true,
      loaded: false,
      active_before: false,
      active: false,
      restore_required: false,
      already_stopped: true,
      code: 0,
      stdout: "",
      stderr: "",
    };
  }

  const uid = options.uid === undefined ? process.getuid?.() : options.uid;
  const domainTarget = launchdDomainTarget(uid);
  const serviceTarget = launchdServiceTarget(uid);
  const byServiceTarget = await run("launchctl", ["bootout", serviceTarget]);
  const byPlist = byServiceTarget.code === 0
    ? null
    : await run("launchctl", ["bootout", domainTarget, plistPath]);
  const after = await waitForUnloaded(readStatus);
  const rawResult = byPlist || byServiceTarget;
  const ok = launchdStatusIsSafelyUnloaded(after);
  if (ok) logger.info?.("launchd service stopped");
  else logger.warn?.("launchd service removal from the launchd domain could not be verified");
  return {
    ...rawResult,
    ok,
    provider: "launchd",
    installed: after?.installed === true,
    loaded: ok ? false : after?.loaded ?? null,
    active_before: before.active === true,
    active: ok ? false : after?.active ?? null,
    // Once bootout is dispatched, an initially active service may still
    // disappear after this observation window. Preserve rollback intent even
    // when stop settlement itself is inconclusive.
    restore_required: before.active === true,
    mutation_attempted: true,
    already_stopped: false,
    code: ok ? 0 : rawResult.code,
    reason: ok ? "stopped" : "stop_not_observed",
    status: after,
    bootout_service_target: byServiceTarget,
    ...(byPlist ? { bootout_plist_fallback: byPlist } : {}),
  };
}

function launchdStatusIsSafelyUnloaded(status) {
  return status?.status_available === true && status?.loaded === false && status?.active === false;
}

async function uninstallLaunchd(logger) {
  const plistPath = launchdPlistPath();
  const definitionIdentity = snapshotServiceDefinition(plistPath, "launchd service definition");
  const stopped = await stopLaunchdService(logger);
  if (!stopped.ok) return { ok: false, provider: "launchd", path: plistPath, stop: stopped };
  if (!removeServiceDefinitionIfCurrent(plistPath, definitionIdentity, "launchd service definition")) {
    logger.warn?.("launchd service definition changed during removal; the replacement was retained.");
    return { ok: false, provider: "launchd", path: plistPath, stop: stopped, reason: "definition_changed" };
  }
  logger.info?.("Autostart removed.");
  return { ok: true, provider: "launchd", path: plistPath, stop: stopped };
}

async function statusLaunchd() {
  const plistPath = launchdPlistPath();
  const result = await serviceRun("launchctl", ["print", launchdServiceTarget()]);
  return launchdStatusSummary({ installed: existsSync(plistPath), definition: LABEL, result });
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
  const definitionIdentity = snapshotServiceDefinition(servicePath, "systemd service definition");
  const definitionPresent = definitionIdentity !== null;
  const disable = await serviceRun("systemctl", ["--user", "disable", "--now", "machine-bridge-mcp.service"]);
  const activeCheck = await serviceRun("systemctl", ["--user", "is-active", "machine-bridge-mcp.service"]);
  const status = systemdStatusSummary({ installed: definitionPresent, definition: "machine-bridge-mcp.service", result: activeCheck });
  const decision = systemdRemovalDecision({ definitionPresent, disableCode: disable.code, status });
  if (!decision.removable) {
    logger.warn?.("systemd service removal could not be verified; its definition was not removed.");
    return { ok: false, provider: "systemd", path: servicePath, disable, active_check: activeCheck, status, active: status.active, reason: decision.reason };
  }
  if (!removeServiceDefinitionIfCurrent(servicePath, definitionIdentity, "systemd service definition")) {
    logger.warn?.("systemd service definition changed during removal; the replacement was retained.");
    return { ok: false, provider: "systemd", path: servicePath, disable, active_check: activeCheck, status, active: false, reason: "definition_changed" };
  }
  const reload = await serviceRun("systemctl", ["--user", "daemon-reload"]);
  const ok = reload.code === 0;
  if (ok) logger.info?.("Autostart removed.");
  else logger.warn?.("Autostart removal reported an error.");
  return { ok, provider: "systemd", path: servicePath, disable, active_check: activeCheck, status, reload, active: false, already_absent: decision.alreadyAbsent, reason: ok ? decision.reason : "reload_failed" };
}

export async function stopSystemdService(logger = console, options = {}) {
  const run = typeof options.run === "function" ? options.run : serviceRun;
  const readStatus = typeof options.readStatus === "function" ? options.readStatus : statusSystemd;
  const waitForInactive = typeof options.waitForInactive === "function"
    ? options.waitForInactive
    : callback => waitForInactiveStatus(callback);
  const before = await readStatus();
  if (systemdStatusIsInactive(before)) {
    logger.info?.("systemd service is not active");
    return {
      ok: true,
      provider: "systemd",
      installed: before?.installed === true,
      active_before: false,
      active: false,
      restore_required: false,
      already_stopped: true,
      state: before?.state || "inactive",
    };
  }
  if (before?.active !== true && ["unknown", "maintenance"].includes(before?.state)) {
    return {
      ok: false,
      provider: "systemd",
      installed: before?.installed === true,
      active_before: null,
      active: null,
      restore_required: null,
      reason: "status_unavailable",
      status: before,
    };
  }
  const command = await run("systemctl", ["--user", "stop", "machine-bridge-mcp.service"]);
  const after = await waitForInactive(readStatus);
  const inactive = systemdStatusIsInactive(after);
  if (inactive) logger.info?.("systemd service stopped");
  else logger.warn?.("systemd service stop could not be verified");
  return {
    ok: inactive,
    provider: "systemd",
    installed: after?.installed === true,
    active_before: before?.active === true,
    active: inactive ? false : after?.active ?? null,
    restore_required: inactive && systemdStatusRequiresRestore(before),
    already_stopped: false,
    command,
    status: after,
    reason: inactive ? "stopped" : "stop_not_observed",
  };
}

function systemdStatusIsInactive(status) {
  if (status?.active !== false) return false;
  if (["inactive", "failed"].includes(status?.state)) return true;
  return status?.installed === false && status?.state === "unknown";
}
function systemdStatusRequiresRestore(status) {
  return status?.active === true || ["activating", "reloading"].includes(status?.state);
}

async function startSystemd(logger) {
  const before = await statusSystemd();
  if (typeof before.active !== "boolean") {
    return { ok: false, provider: "systemd", installed: before.installed === true, active: null, reason: "status_unavailable", status: before };
  }
  if (before.installed !== true) {
    return { ok: false, provider: "systemd", installed: false, active: false, reason: "not_installed", status: before };
  }
  if (before.active) {
    const existing = await waitForStableActiveStatus(statusSystemd);
    if (existing.stable) {
      logger.info?.("systemd service is already running");
      return { ...existing.status, ok: true, active_before: true, already_running: true, reason: "already_running" };
    }
  }
  const command = await serviceRun("systemctl", ["--user", "start", "machine-bridge-mcp.service"]);
  const stability = await waitForStableActiveStatus(statusSystemd);
  const after = stability.status;
  const ok = command.code === 0 && stability.stable;
  if (ok) logger.info?.("systemd service started");
  else logger.warn?.("systemd service failed to start");
  return { ok, provider: "systemd", installed: after.installed, active_before: false, active: after.active, command };
}

async function restartSystemd(logger) {
  const before = await statusSystemd();
  if (typeof before.active !== "boolean") {
    return { ok: false, provider: "systemd", installed: before.installed === true, active: null, restarted: false, reason: "status_unavailable", status: before };
  }
  if (before.installed !== true) {
    return { ok: false, provider: "systemd", installed: false, active: false, restarted: false, reason: "not_installed", status: before };
  }
  const command = await serviceRun("systemctl", ["--user", "restart", "machine-bridge-mcp.service"]);
  const stability = await waitForStableActiveStatus(statusSystemd);
  const after = stability.status;
  const ok = command.code === 0 && stability.stable;
  if (ok) logger.info?.("systemd service restarted");
  else logger.warn?.("systemd service restart could not be verified");
  return { ok, provider: "systemd", installed: after.installed, active: after.active, restarted: ok, command };
}

async function statusSystemd() {
  const servicePath = systemdPath();
  const result = await serviceRun("systemctl", ["--user", "is-active", "machine-bridge-mcp.service"]);
  return systemdStatusSummary({ installed: existsSync(servicePath), definition: "machine-bridge-mcp.service", result });
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
