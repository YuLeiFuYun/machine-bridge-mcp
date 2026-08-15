import { join, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { LocalRuntime } from "./runtime.mjs";
import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon, stopWorkspaceServiceDaemon, workspaceDaemonOwnsPlatformAutostart } from "./daemon-process.mjs";
import { inspectProcessInstance } from "./process-identity.mjs";
import { runStdioServer } from "./stdio.mjs";
import { assertCanonicalFullPolicy, POLICY_PROFILES, toolsForPolicy } from "./tools.mjs";
import { resolvePolicy } from "./cli-policy.mjs";
import { effectiveLogFormat, effectiveLogLevel, normalizeCommand, parseArgs, validateCommandOptions, validateLoggingOptions, validatePositionals } from "./cli-options.mjs";
import { createLocalAdminCommands } from "./cli-local-admin.mjs";
import { createServiceCommand } from "./cli-service.mjs";
import { createActivateCommand } from "./cli-activate.mjs";
import { generateAccountPassword } from "./account-admin.mjs";
import { accountAdminClient, createAccountCommand } from "./cli-account-admin.mjs";
export { resolvePolicy } from "./cli-policy.mjs";
export { parseArgs, validateCommandOptions, validateLoggingOptions, validatePositionals } from "./cli-options.mjs";
import { classifyOperationalError, createLogger, sanitizeLogText } from "./log.mjs";
import { runExecutable, runWrangler } from "./shell.mjs";
import { runFullAccessTest } from "./full-access-test.mjs";
import { stopAndRemoveAutostart } from "./service-lifecycle.mjs";
import { stopOwnedPlatformService } from "./service-ownership.mjs";
import { loadServiceEnvironment } from "./service-environment.mjs";
import { createDeviceSessionForRoot, deviceRootProviderStatus, ensurePreferredDeviceRoot } from "./device-root-provider.mjs";
import { convergeRemoteConfiguration } from "./remote-configuration.mjs";
import { workerHealth } from "./worker-health.mjs";
import { DOCTOR_RUNTIME_SCOPE, doctorRuntimeCheckProjection } from "./doctor-reporting.mjs";
import { supportStateProjection } from "./support-state-projection.mjs";
export { workerHealthUserReason } from "./worker-health.mjs";
import { activeStateJobs, activeStateLocks, knownProfileStates, knownWorkerNames } from "./state-inventory.mjs";
import { pruneRetiredManagedJobDirectories } from "./managed-job-directory-generation.mjs";
import { withReleaseRuntimeLock } from "./release-runtime-lock.mjs";
import {
  acquireMachineServiceLockWithWait,
  acquireMaintenanceLock,
  acquireStartupLockWithWait,
  daemonLockPathForState,
  defaultFirstRunWorkspace,
  defaultStateRoot,
  ensureWorkerSecrets,
  ensureWorkspaceDirectory,
  expandHome,
  loadGlobalConfig,
  loadState,
  readDaemonLockOwner,
  redactState,
  removeStateRoot,
  validateStateRootForRemoval,
  resolveWorkspace,
  saveGlobalConfig,
  saveState,
  selectedWorkspace,
  setSelectedWorkspace,
} from "./state.mjs";
import { packageName, packageVersion } from "./package-identity.mjs";

const localAdminCommands = createLocalAdminCommands({ chooseWorkspace, confirm });
const accountCommand = createAccountCommand({ chooseWorkspace, confirm });
const serviceCommand = createServiceCommand({ chooseWorkspace, stateRootFromArgs, structuredLogger, acquireMachineServiceLockWithWait, currentPackageVersion });
const activateCommand = createActivateCommand({
  chooseWorkspace,
  prepareRemoteState,
  createRemoteRuntime,
  currentPackageVersion,
  assertNodeVersion,
  structuredLogger,
});

const COMMAND_HANDLERS = new Map([
  ["start", startCommand],
  ["activate", activateCommand],
  ["stdio", stdioCommand],
  ["client-config", clientConfigCommand],
  ["status", statusCommand],
  ["doctor", doctorCommand],
  ["full-test", fullTestCommand],
  ["workspace", workspaceCommand],
  ["service", serviceCommand],
  ["autostart", serviceCommand],
  ["rotate-secrets", rotateSecretsCommand],
  ["resource", localAdminCommands.resourceCommand],
  ["account", accountCommand],
  ["browser", localAdminCommands.browserCommand],
  ["job", localAdminCommands.jobCommand],
  ["uninstall", uninstallCommand],
]);

export async function main(argv = process.argv.slice(2)) {
  const [command, rest] = normalizeCommand(argv);
  const args = parseArgs(rest);
  if (args.help || command === "help") return usage();
  if (args.version || command === "version") return version();
  validateCommandOptions(command, args);
  validatePositionals(command, args);
  validateLoggingOptions(args);
  const handler = COMMAND_HANDLERS.get(command);
  if (handler) return handler(args);
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
}

function stateRootFromArgs(args) {
  return args.stateDir ? expandHome(String(args.stateDir)) : defaultStateRoot();
}

async function chooseWorkspace(args, { promptOnFirstRun, save, allowPositional = false }) {
  const stateRoot = stateRootFromArgs(args);
  const explicit = args.workspace || (allowPositional ? args._[0] : undefined);
  if (explicit && explicit !== true) {
    const workspace = resolveWorkspace(String(explicit));
    if (save) setSelectedWorkspace(workspace, stateRoot);
    return workspace;
  }

  const remembered = selectedWorkspace(stateRoot);
  if (remembered) return resolveWorkspace(remembered);

  const fallback = promptOnFirstRun ? defaultFirstRunWorkspace() : process.cwd();
  if (!promptOnFirstRun || !process.stdin.isTTY) {
    const workspace = promptOnFirstRun && process.platform === "win32"
      ? ensureWorkspaceDirectory(fallback)
      : resolveWorkspace(fallback);
    if (save) setSelectedWorkspace(workspace, stateRoot);
    return workspace;
  }

  const answer = await ask(`Workspace folder [${fallback}] (press Enter to use the default): `);
  const workspace = process.platform === "win32"
    ? ensureWorkspaceDirectory(answer.trim() || fallback)
    : resolveWorkspace(answer.trim() || fallback);
  if (save) setSelectedWorkspace(workspace, stateRoot);
  return workspace;
}

async function workspaceCommand(args) {
  const action = String(args._[0] || "show");
  const stateRoot = stateRootFromArgs(args);
  if (action === "show") {
    const workspace = selectedWorkspace(stateRoot);
    console.log(workspace || "No workspace selected yet. Run `machine-mcp workspace set` or `mbm workspace set`.");
    return;
  }
  if (action === "set" || action === "select") {
    const raw = args.workspace || args._[1];
    let workspace;
    if (raw && raw !== true) workspace = resolveWorkspace(String(raw));
    else {
      const current = selectedWorkspace(stateRoot) || process.cwd();
      const answer = process.stdin.isTTY ? await ask(`Workspace path [${current}]: `) : current;
      workspace = resolveWorkspace(String(answer || current));
    }
    setSelectedWorkspace(workspace, stateRoot);
    console.log(`Selected workspace: ${workspace}`);
    console.log("Run `machine-mcp` (or `mbm`) to use this workspace.");
    return;
  }
  if (action === "reset") {
    const config = loadGlobalConfig(stateRoot);
    delete config.selectedWorkspace;
    delete config.selectedWorkspaceHash;
    saveGlobalConfig(config, stateRoot);
    console.log("Workspace selection reset. Next start will ask again.");
    return;
  }
  throw new Error(`Unknown workspace action: ${action}`);
}

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function confirm(prompt, assumeYes = false) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const answer = (await ask(`${prompt} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function startCommand(args) {
  assertNodeVersion();
  const logger = createLogger({ level: args.json ? "error" : effectiveLogLevel(args), format: effectiveLogFormat(args), component: "cli" });
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: true, save: true, allowPositional: true });
  let state = loadState(workspace, { stateDir: args.stateDir });
  let startupLock = null;
  let serviceLock = null;

  try {
    serviceLock = await acquireRuntimeStartServiceLock(args, acquireMachineServiceLockWithWait, logger);
    startupLock = await acquireStartupLockWithWait(state, { operation: "start", logger });
    state = loadState(workspace, { stateDir: args.stateDir });
    if (args.daemonOnly) {
      const serviceEnvironment = loadServiceEnvironment(state.paths.stateRoot);
      logger.debug?.("Loaded persisted service network environment", { keys: serviceEnvironment.keys });
    }
    const startMode = await prepareStartMode(args, state, logger);
    const daemonLock = await acquireDaemonLockWithTakeover(state, {
      takeOverServiceOwner: startMode.takeOverServiceOwner,
      ownerMetadata: {
        mode: args.daemonOnly ? "service" : "foreground",
        version: currentPackageVersion(),
      },
      logger,
    });
    if (!daemonLock.acquired) {
      reportExistingDaemon(args, state, daemonLock.owner, logger);
      return;
    }
    serviceLock?.release?.();
    serviceLock = null;
    await startRemoteRuntime({ args, workspace, state, daemonLock, logger });
  } finally {
    serviceLock?.release?.();
    startupLock?.release?.();
  }
}

async function prepareStartMode(args, state, logger) {
  if (args.daemonOnly) {
    const { trimAutostartLogs } = await import("./service.mjs");
    trimAutostartLogs(state.paths.stateRoot);
    return { takeOverServiceOwner: false };
  }
  // The platform service name is machine-global, while state/workspace locks
  // are scoped. Stop the platform service only when the daemon lock proves
  // that the loaded service belongs to this exact state/workspace. An
  // unrelated foreground start (including install smoke tests with isolated
  // HOME/state) must never unload another Machine Bridge deployment.
  const ownership = await stopOwnedPlatformService({
    state,
    inspectWorkspaceDaemon,
    ownsPlatformAutostart: workspaceDaemonOwnsPlatformAutostart,
    stopPlatformService: () => stopAutostartBestEffort(logger),
  });
  if (!ownership.owned) {
    logger.debug?.("foreground startup left unrelated machine autostart untouched", {
      workspace_daemon_present: ownership.daemon.present === true,
      workspace_daemon_alive: ownership.daemon.alive === true,
      identity_reason: ownership.daemon.identity_reason || "not_running",
    });
    return { takeOverServiceOwner: true, provider: null };
  }
  // Once ownership is proven, unload the provider first so KeepAlive cannot
  // respawn the service while the verified process lock is reclaimed.
  return ownership.provider;
}

function reportExistingDaemon(args, state, owner, logger) {
  if (isIdempotentDaemonOnlyStart(args)) {
    logger.debug?.("local daemon already running; daemon-only start completed as an idempotent no-op", { owner_pid_known: Boolean(owner?.pid) });
    return;
  }
  const mode = owner?.mode === "foreground" ? "foreground" : owner?.mode === "service" ? "background service" : "local";
  const version = owner?.version ? `, version ${owner.version}` : "";
  const notice = `${mode} daemon already running for this workspace${version}; it was not restarted and requested changes were not applied`;
  logger.warn(notice);
  if (args.json) {
    printStartJson(state, { requestedChangesApplied: false, notice });
    return;
  }
  if (owner?.mode === "foreground") {
    logger.safePlain("  Stop the existing foreground process with Ctrl+C in its terminal, then retry.");
  } else {
    logger.safePlain("  Run `machine-mcp service stop`, verify `machine-mcp service status`, then retry.");
  }
  logger.plain(`  Workspace: ${state.workspace.path}`);
}

export function runtimeStartRequiresMachineServiceLock(args = {}) {
  return args.daemonOnly !== true;
}

export async function acquireRuntimeStartServiceLock(args = {}, acquireLock = acquireMachineServiceLockWithWait, logger = console) {
  if (!runtimeStartRequiresMachineServiceLock(args)) return null;
  if (typeof acquireLock !== "function") throw new TypeError("runtime start requires a machine-service lock acquirer");
  const lock = await acquireLock({ operation: "runtime-start", logger });
  if (!lock?.acquired || typeof lock.release !== "function") {
    throw new Error("machine-service operation lock could not be acquired for runtime start");
  }
  return lock;
}

export function isIdempotentDaemonOnlyStart(args) {
  if (!args.daemonOnly || args.json) return false;
  return !Boolean(
    args.profile
    || args.execMode
    || args.rotateSecrets
    || args.forceWorker
    || args.workerName
    || args.noWrite
    || args.noExec
    || args.fullEnv
    || args.unrestrictedPaths
    || args.absolutePaths
  );
}

async function startRemoteRuntime({ args, workspace, state, daemonLock, logger }) {
  let runtime = null;
  try {
    const readiness = await prepareRemoteState({ args, workspace, state, logger });
    runtime = createRemoteRuntime({ args, workspace, state, daemonLock, deviceSessionIdentity: readiness.deviceSessionIdentity });
    await runtime.start();
    if (typeof daemonLock.update !== "function") throw new Error("daemon lock cannot publish startup readiness");
    daemonLock.update({ startupReady: true, startupReadyAt: new Date().toISOString() });
    reportRemoteReady(args, state, readiness, logger);
    if (args.daemonOnly) {
      const { startAutostartLogMaintenance } = await import("./autostart-log-maintenance.mjs");
      startAutostartLogMaintenance(state.paths.stateRoot, {
        onError(error) {
          logger.event?.("warn", "service.log_maintenance.failed", {
            error_class: classifyOperationalError(error),
          }, "Background log maintenance failed");
        },
      });
    }
    keepProcessAlive({ daemon: runtime, lock: daemonLock, logger });
  } catch (error) {
    throw cleanupRuntimeStartFailure(error, runtime, daemonLock);
  }
}

export function cleanupRuntimeStartFailure(error, runtime, daemonLock) {
  const cleanupErrors = [];
  try { runtime?.stop?.(); } catch (failure) { cleanupErrors.push(failure); }
  try { daemonLock?.release?.(); } catch (failure) { cleanupErrors.push(failure); }
  return cleanupErrors.length
    ? new AggregateError([error, ...cleanupErrors],
      "runtime startup failed and local cleanup was incomplete")
    : error;
}

async function prepareRemoteState({ args, workspace, state, logger, onRemotePrepared, provisionInitialOwner = true }) {
  if (!args.daemonOnly) {
    await convergeRemoteConfiguration({ args, state });
    onRemotePrepared?.();
  } else if (!state.worker.url) {
    throw new Error("--daemon-only requires an existing Worker URL; run start once without --daemon-only");
  } else if (state.worker.pendingDeviceIdentity) {
    throw new Error("--daemon-only cannot activate a pending device root; run a normal start once to deploy and promote it");
  }

  const deviceSessionIdentity = await createDeviceSessionForRoot(
    state.worker.deviceIdentity,
    state.worker.url,
    "machine-bridge-mcp",
    currentPackageVersion(),
    { profileDir: state.paths.profileDir, reason: "Authorize Machine Bridge startup" },
  );
  const initialOwner = args.daemonOnly || provisionInitialOwner === false
    ? null
    : await ensureInitialOwnerAccount(state, deviceSessionIdentity);
  if (!args.daemonOnly && !args.noAutostart) {
    await installAutostartBestEffort({ workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], logger });
  }
  return { initialOwner, deviceSessionIdentity };
}



async function ensureInitialOwnerAccount(state, deviceSessionIdentity) {
  const client = await accountAdminClient(state, deviceSessionIdentity);
  const existing = await client.list();
  if (existing.accounts.length > 0) return null;
  const password = generateAccountPassword();
  const created = await client.create({ name: "owner", role: "owner", password, displayName: "Bridge Owner" });
  return { ...created.account, password };
}

function createRemoteRuntime({ args, workspace, state, daemonLock, deviceSessionIdentity, exitOnTerminal = true }) {
  const terminalState = { error: null };
  const runtime = new LocalRuntime({
    workerUrl: state.worker.url,
    deviceIdentity: deviceSessionIdentity,
    expectedRelayVersion: currentPackageVersion(),
    workspace,
    policy: state.policy,
    logger: createLogger({ level: args.json ? "error" : effectiveLogLevel(args), format: effectiveLogFormat(args), component: "daemon" }),
    jobRoot: join(state.paths.profileDir, "jobs"),
    securityStateRoot: state.paths.profileDir,
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    browserStateRoot: state.paths.stateRoot,
    deviceRootStatus: deviceRootProviderStatus(state.worker.deviceIdentity),
    onSuperseded: () => {
      if (!exitOnTerminal) {
        terminalState.error ??= new Error("candidate daemon was superseded before service handoff");
        return;
      }
      daemonLock.release();
      process.exit(0);
    },
    onFatal: (error) => {
      if (!exitOnTerminal) {
        terminalState.error ??= error instanceof Error ? error : new Error("candidate relay failed before service handoff");
        return;
      }
      daemonLock.release();
      process.exit(1);
    },
  });
  if (!exitOnTerminal) runtime.terminalError = () => terminalState.error;
  return runtime;
}

function reportRemoteReady(args, state, readiness, logger) {
  if (args.json) {
    printStartJson(state, { initialOwner: readiness.initialOwner });
    return;
  }
  printMcpConnection(state, {
    quiet: Boolean(args.quiet),
    verbose: Boolean(args.verbose),
    initialOwner: readiness.initialOwner,
    logger,
  });
}

async function stdioCommand(args) {
  assertNodeVersion();
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const policy = resolvePolicy(args, state.policy);
  await runStdioServer({
    workspace,
    policy,
    logLevel: effectiveLogLevel(args),
    logFormat: effectiveLogFormat(args),
    jobRoot: join(state.paths.profileDir, "jobs"),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    browserStateRoot: state.paths.stateRoot,
    deviceRootStatus: state.worker?.deviceIdentity ? deviceRootProviderStatus(state.worker.deviceIdentity) : null,
  });
}

async function clientConfigCommand(args) {
  const workspaceArgs = { ...args, _: [] };
  const workspace = await chooseWorkspace(workspaceArgs, { promptOnFirstRun: false, save: false, allowPositional: false });
  const requested = String(args.client || args._[0] || "all").trim().toLowerCase();
  const profile = String(args.profile || "full").trim().toLowerCase();
  if (!Object.hasOwn(POLICY_PROFILES, profile)) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
  if (!["all", "claude", "cursor", "codex", "generic"].includes(requested)) throw new Error("client must be all, claude, cursor, codex, or generic");
  const command = process.execPath;
  const argsList = [resolve(process.argv[1]), "stdio", "--workspace", workspace, "--profile", profile];
  const jsonConfig = { mcpServers: { "machine-bridge": { command, args: argsList } } };
  const codex = `[mcp_servers.machine_bridge]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(argsList)}\n`;
  if (args.json) {
    console.log(JSON.stringify({ workspace, profile, claude: jsonConfig, cursor: jsonConfig, generic: jsonConfig, codex_toml: codex }, null, 2));
    return;
  }
  if (["all", "claude", "cursor", "generic"].includes(requested)) {
    console.log(`${requested === "all" ? "Claude Desktop / Cursor / generic stdio" : requested}:`);
    console.log(JSON.stringify(jsonConfig, null, 2));
  }
  if (["all", "codex"].includes(requested)) {
    if (requested === "all") console.log("");
    console.log("Codex CLI:");
    console.log(codex.trimEnd());
  }
}



function printStartJson(state, { requestedChangesApplied = true, notice = "", initialOwner = null } = {}) {
  createLogger({ component: "ready" }).json({
    mcp: {
      server_url: state.worker.mcpServerUrl,
      worker_url: state.worker.url,
      worker_name: state.worker.name,
    },
    ...(initialOwner ? { initial_owner: initialOwner } : {}),
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
    requested_changes_applied: requestedChangesApplied,
    ...(notice ? { notice } : {}),
  });
}

function printMcpConnection(state, { quiet = false, verbose = false, initialOwner = null, logger: readyLogger = null } = {}) {
  const output = readyLogger || createLogger({ component: "ready", quiet, level: quiet ? "error" : verbose ? "debug" : "info" });
  if (output.format === "json" && !initialOwner) {
    output.event("success", "daemon.ready", {
      mcp_server_url: state.worker.mcpServerUrl,
      worker_name: state.worker.name,
      workspace_path: state.workspace.path,
      policy_profile: state.policy.profile,
      policy_origin: state.policy.origin,
      write_enabled: state.policy.allowWrite,
      exec_mode: state.policy.execMode,
    }, "Remote MCP bridge is ready");
    return;
  }
  const logger = output;
  logger.success("Remote MCP bridge is ready");
  logger.plain(`  MCP Server URL: ${state.worker.mcpServerUrl}`);
  if (initialOwner) {
    logger.warn("Initial owner account created; save the password now because it is not stored locally or shown again. Do not share this terminal output; rotate the password immediately if it has been exposed.");
    logger.plain(`  Account: ${initialOwner.name}`);
    logger.plain(`  Password: ${initialOwner.password}`);
  } else {
    logger.safePlain("  Use `machine-mcp account` to manage account access.");
  }
  logger.plain(`  Workspace: ${state.workspace.path}`);
  logger.safePlain(`  Policy: ${formatPolicySummary(state.policy)}`);
  if (verbose) logger.plain(`  State: ${state.paths.statePath}`);
}

function formatPolicySummary(policy = {}) {
  const scope = policy.unrestrictedPaths ? "all local paths" : "workspace only";
  const environment = policy.minimalEnv ? "isolated env" : "full parent env";
  return `${policy.profile || "custom"} [${policy.origin || "unknown"}; write=${policy.allowWrite ? "on" : "off"}; exec=${policy.execMode || "off"}; ${scope}; ${environment}; absolute_paths=${policy.exposeAbsolutePaths ? "on" : "off"}]`;
}


function keepProcessAlive({ daemon = null, lock = null, logger = createLogger({ component: "cli" }) } = {}) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("stopping local services");
    try {
      await daemon?.stop?.();
    } catch (error) {
      stopping = false;
      logger.error("local service shutdown is incomplete; retaining daemon ownership for a later retry", {
        error_class: classifyOperationalError(error),
      });
      return;
    }
    try { lock?.release?.(); }
    catch (error) { logger.warn("daemon lock release failed during final shutdown", { error_class: classifyOperationalError(error) }); }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.once("exit", () => {
    try { lock?.release?.(); }
    catch { /* Process exit is the final ownership fallback; no in-process recovery remains possible. */ }
  });
  setInterval(() => {}, 2 ** 31 - 1);
}

async function statusCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  state.policy = resolvePolicy({}, state.policy);
  const health = state.worker?.url ? await workerHealth(state.worker.url, currentPackageVersion(), { expectedWorkerName: state.worker.name }) : { ok: false, error: "no worker url" };
  const payload = {
    ...redactState(state),
    workerHealth: health,
  };
  console.log(JSON.stringify(payload, null, 2));
}

async function doctorCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  state.policy = resolvePolicy({}, state.policy);
  const checks = [];
  checks.push({ name: "node", ok: isSupportedNodeVersion(), detail: process.version });
  const npmCommand = npmVersionCommand();
  const npm = await runExecutable(npmCommand.file, npmCommand.args, { capture: true, allowFailure: true, timeoutMs: 10_000 });
  const npmDetail = sanitizeLines(npm.stdout || npm.stderr);
  checks.push({ name: "npm", ok: npm.code === 0 && isSupportedNpmVersion(npmDetail), detail: npmDetail || "unavailable" });
  const wrangler = await runWrangler(["--version"], { capture: true, allowFailure: true, stateRoot: state.paths.stateRoot });
  checks.push({ name: "wrangler", ok: wrangler.code === 0, detail: (wrangler.stdout || wrangler.stderr).trim() });
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true, stateRoot: state.paths.stateRoot });
  checks.push({ name: "cloudflare-login", ok: whoami.code === 0, detail: whoami.code === 0 ? "authenticated" : sanitizeLines(whoami.stderr || whoami.stdout) });
  checks.push({ name: "policy", ok: true, detail: formatPolicySummary(state.policy) });
  checks.push({
    name: "authorization-model",
    ok: true,
    detail: state.policy.profile === "full"
      ? "local owner operations execute automatically without per-operation prompts; shell, browser, and application automation use the daemon OS user's ambient authority"
      : "operations allowed by the selected local policy execute automatically without per-operation prompts",
  });
  if (state.policy.profile === "full") {
    try {
      assertCanonicalFullPolicy(state.policy);
      checks.push({ name: "full-policy-contract", ok: true, detail: `${toolsForPolicy(state.policy).length} tools exposed` });
    } catch (error) {
      checks.push({ name: "full-policy-contract", ok: false, detail: sanitizeLines(error?.message || error) });
    }
  }
  const health = state.worker?.url ? await workerHealth(state.worker.url, currentPackageVersion(), { expectedWorkerName: state.worker.name }) : { ok: false, error: "no worker url" };
  checks.push({ name: "worker-health", ok: health.ok, detail: health.ok ? "reachable" : health.error });
  const diagnosticRuntime = new LocalRuntime({
    workspace,
    policy: state.policy,
    logger: createLogger({ level: "error", component: "doctor" }),
    jobRoot: join(state.paths.profileDir, "jobs"),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    recoverJobs: false,
  });
  let runtimeDiagnostics;
  try {
    runtimeDiagnostics = await diagnosticRuntime.diagnoseRuntime();
  } finally {
    diagnosticRuntime.stop();
  }
  for (const check of runtimeDiagnostics.checks) checks.push(doctorRuntimeCheckProjection(check));
  console.log(JSON.stringify({
    ok: checks.every(check => check.ok),
    checks,
    diagnosticScope: DOCTOR_RUNTIME_SCOPE,
    state: supportStateProjection(state),
  }, null, 2));
}

async function fullTestCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const policy = resolvePolicy({}, state.policy);
  const result = await runFullAccessTest({ workspace, policy });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function rotateSecretsCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  let state = loadState(workspace, { stateDir: args.stateDir });
  const operationLogger = createLogger({ level: args.quiet ? "error" : "warn", component: "service" });
  let startupLock = null;
  let serviceLock = null;
  try {
    serviceLock = await acquireMachineServiceLockWithWait({ operation: "rotate-secrets", logger: operationLogger });
    startupLock = await acquireStartupLockWithWait(state, { operation: "rotate-secrets", logger: operationLogger });
    state = loadState(workspace, { stateDir: args.stateDir });
    await stopOwnedPlatformService({
      state,
      inspectWorkspaceDaemon,
      ownsPlatformAutostart: workspaceDaemonOwnsPlatformAutostart,
      stopPlatformService: () => stopAutostartBestEffort(operationLogger),
    });
    const stopped = await stopWorkspaceServiceDaemon(state, { logger: operationLogger, reason: "secret rotation" });
    if (stopped.found && !stopped.ok) {
      const pid = stopped.pid ? `pid ${stopped.pid}` : "unknown pid";
      throw new Error(`refusing to rotate secrets while a daemon cannot be safely stopped (${pid}; ${stopped.reason})`);
    }
    await sleep(100);
    const daemonOwner = readDaemonLockOwner(daemonLockPathForState(state));
    const daemonIdentity = daemonOwner ? inspectProcessInstance(daemonOwner) : null;
    if (daemonIdentity?.current) {
      throw new Error(`refusing to rotate secrets while the daemon is active (pid ${daemonOwner.pid}); stop the foreground daemon and retry`);
    }
    if (state.worker.pendingDeviceIdentity) throw new Error("a device-root rotation is already pending; run machine-mcp to deploy it before rotating again");
    ensureWorkerSecrets(state, { rotateSecrets: true, deferDeviceRotation: true });
    state.worker.pendingDeviceIdentity = await ensurePreferredDeviceRoot({
      profileDir: state.paths.profileDir,
      workspaceHash: state.workspace.hash,
      existing: null,
      rotate: true,
    });
    saveState(state);
    console.log("Prepared a two-phase rotation for account administration, device root, and token-version secrets.");
    console.log("All account access tokens are invalid. Run machine-mcp to deploy, verify, and atomically promote the pending device root.");
  } finally {
    startupLock?.release?.();
    serviceLock?.release?.();
  }
}

export async function installAutostartBestEffort({ workspace, stateRoot, entryScript, logger }, options = {}) {
  let serviceLock = null;
  try {
    const acquireLock = options.acquireServiceLock || acquireMachineServiceLockWithWait;
    const acquired = await acquireLock({ operation: "runtime-start-autostart", logger });
    if (!acquired?.acquired || typeof acquired.release !== "function") {
      throw new Error("machine-service operation lock could not be acquired for automatic autostart installation");
    }
    serviceLock = acquired;
    const install = options.installAutostart || (await import("./service.mjs")).installAutostart;
    const makeLogger = options.structuredLogger || structuredLogger;
    const result = await install({ workspace, stateRoot, entryScript, version: currentPackageVersion(), logger: makeLogger(true) });
    if (result?.ok) logger.info("Autostart installed for future logins", { provider: result.provider });
    else logger.warn("Autostart installation reported a problem; run `machine-mcp service status` for details", {
      provider: result?.provider || "unknown",
      reason: result?.reason || "installation_failed",
    });
  } catch (error) {
    logger.warn("Autostart installation skipped", { error_class: classifyOperationalError(error) });
  } finally {
    serviceLock?.release?.();
  }
}

async function stopAutostartBestEffort(logger) {
  let result = null;
  try {
    const { stopAutostart } = await import("./service.mjs");
    result = await stopAutostart({ logger: structuredLogger(true) });
  } catch (error) {
    logger.warn("Autostart stop command was unavailable; checking the workspace daemon directly", { error_class: classifyOperationalError(error) });
    return { takeOverServiceOwner: true, provider: null };
  }
  if (result?.active_before && result?.ok) logger.info("stopping the background service before foreground startup");
  if (result?.ok === false && result?.active === true) {
    throw new Error("the background service is still active after the stop request; run `machine-mcp service status` for details");
  }
  return { takeOverServiceOwner: true, provider: result };
}

async function uninstallCommand(args) {
  const stateRoot = stateRootFromArgs(args);
  const deleteRemote = !args.keepWorker;
  validateStateRootForRemoval(stateRoot);
  const action = deleteRemote
    ? `delete deployed Worker(s), remove autostart entries, and remove local state at ${stateRoot}`
    : `remove autostart entries and local state at ${stateRoot} while keeping deployed Worker(s)`;
  const ok = await confirm(`Uninstall Machine Bridge MCP: ${action}?`, Boolean(args.yes));
  if (!ok) {
    console.log("Uninstall cancelled. Re-run with `machine-mcp uninstall --yes` to skip confirmation.");
    return;
  }
  await withReleaseRuntimeLock(stateRoot, () => uninstallStateRoot({ stateRoot, deleteRemote }));
}

async function uninstallStateRoot({ stateRoot, deleteRemote }) {
  const currentValidation = validateStateRootForRemoval(stateRoot);
  const maintenance = currentValidation.exists ? acquireMaintenanceLock(stateRoot, { operation: "uninstall" }) : null;
  if (maintenance && !maintenance.acquired) {
    const pid = maintenance.owner?.pid ? `pid ${maintenance.owner.pid}` : "another process";
    throw new Error(`another state maintenance operation is active (${pid})`);
  }
  let serviceLock = null;
  try {
    serviceLock = await acquireMachineServiceLockWithWait({ operation: "uninstall" });
    if (currentValidation.exists) validateStateRootForRemoval(stateRoot);
    assertNoActiveJobsForUninstall(stateRoot);
    const autostartRemoved = await removeAutostartBestEffort(stateRoot);
    if (!autostartRemoved) throw new Error("autostart removal failed; state and Worker were kept so the uninstall can be retried safely");
    await sleep(100);
    assertNoActiveJobsForUninstall(stateRoot);
    assertNoActiveLocksForUninstall(stateRoot);
    if (deleteRemote) await deleteKnownWorkers(stateRoot);
    assertNoActiveJobsForUninstall(stateRoot);
    assertNoActiveLocksForUninstall(stateRoot);
    removeStateRoot(stateRoot);
    console.log("Removed local autostart entries and state.");
    if (deleteRemote) console.log("Requested deletion for known deployed Worker(s).");
    console.log("If installed globally, remove the npm package with:");
    console.log("  npm uninstall -g machine-bridge-mcp");
  } finally {
    serviceLock?.release?.();
    maintenance?.release?.();
  }
}

function assertNoActiveJobsForUninstall(stateRoot) {
  for (const state of knownProfileStates(stateRoot)) {
    pruneRetiredManagedJobDirectories(join(state.paths.profileDir, "jobs"), { warn() {} });
  }
  const activeJobs = activeStateJobs(stateRoot);
  if (!activeJobs.length) return;
  const retiredBlocked = activeJobs.some((item) => item.state_kind === "retired_managed_job");
  const detail = activeJobs.slice(0, 5).map((item) => item.state_kind === "retired_managed_job" ? `retired-managed-job:${item.status}` : `${item.job_id}:${item.status}`).join(", ");
  const suffix = activeJobs.length > 5 ? `, and ${activeJobs.length - 5} more` : "";
  const guidance = retiredBlocked
    ? "run machine-mcp job list to retry safe retired cleanup; if retired state remains unreadable, inspect the owner-only state root instead of deleting it blindly; cancel any active jobs before retrying"
    : "inspect with machine-mcp job list/read and cancel active jobs before retrying";
  throw new Error(`refusing to uninstall while managed-job state is active or requires inspection (${detail}${suffix}); ${guidance}`);
}

function assertNoActiveLocksForUninstall(stateRoot) {
  const activeLocks = activeStateLocks(stateRoot);
  if (!activeLocks.length) return;
  const detail = activeLocks.map((item) => `${item.kind}:${item.pid || "unknown"}`).join(", ");
  throw new Error(`refusing to uninstall while Machine Bridge processes are active (${detail}); stop foreground sessions and retry`);
}

async function deleteKnownWorkers(stateRoot) {
  const names = knownWorkerNames(stateRoot);
  if (!names.length) {
    console.log("No deployed Worker name found in local state.");
    return;
  }
  const failures = [];
  for (const name of names) {
    const result = await runWrangler(["delete", name, "--force"], { capture: true, allowFailure: true, stateRoot });
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    if (result.code === 0) {
      console.log(`Deleted Worker: ${name}`);
    } else {
      failures.push({ name, detail: sanitizeLines(detail) || "unknown error" });
    }
  }
  if (failures.length) {
    throw new Error(`failed to delete Worker(s): ${failures.map((item) => `${item.name} (${item.detail})`).join(", ")}; local state was kept for retry`);
  }
}

async function removeAutostartBestEffort(stateRoot) {
  const logger = structuredLogger(false);
  try {
    const { stopAutostart, uninstallAutostart } = await import("./service.mjs");
    const lifecycle = await stopAndRemoveAutostart({
      states: knownProfileStates(stateRoot),
      stateRoot,
      logger,
      reason: "uninstall",
      stopAutostart,
      uninstallAutostart,
      stopWorkspaceServiceDaemon,
    });
    if (!lifecycle.ok) {
      console.warn(`Autostart removal stopped at ${lifecycle.reason}; service definitions and state were kept.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Autostart removal skipped or failed (${classifyOperationalError(error)}). Run machine-mcp service status for details.`);
    return false;
  }
}

function structuredLogger(quiet) {
  return createLogger({ quiet, component: "service" });
}


function sanitizeLines(text) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const homePattern = home ? new RegExp(escapeRegExp(home), "g") : null;
  let value = sanitizeLogText(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  if (homePattern) value = value.replace(homePattern, "~");
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}



export function isSupportedNodeVersion(version = process.versions.node) {
  const major = Number(String(version || "").replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= 26;
}

export function isSupportedNpmVersion(version) {
  const major = Number(String(version || "").trim().replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= 12;
}

export function npmVersionCommand(platform = process.platform, comspec = process.env.ComSpec) {
  if (platform === "win32") {
    return { file: comspec || "cmd.exe", args: ["/d", "/s", "/c", "npm --version"] };
  }
  return { file: "npm", args: ["--version"] };
}

function assertNodeVersion() {
  if (!isSupportedNodeVersion()) throw new Error(`Node.js >=26 is required; current ${process.version}`);
}

function usage() {
  console.log(`machine-bridge-mcp

Installation (run from a package-free temporary directory; Node.js >=26):
  npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp

Usage:
  npx machine-bridge-mcp@latest                  # no global install; autostart may rely on npm cache
  ./mbm                                          # from source checkout
  .\\mbm.cmd                                      # from source checkout on Windows cmd

Commands:
  start             Deploy/update Worker, take over autostart, run foreground daemon
  activate          Deploy/update Worker, replace autostart, start and verify background daemon
  stdio             Run a local MCP stdio server for Claude, Cursor, Codex, and compatible clients
  client-config     Print stdio client configuration snippets
  workspace show    Show remembered workspace
  workspace set     Re-select workspace; prompts with current/default path
  service status    Show autostart status
  service install   Install login autostart for remembered/current workspace
  service start     Ensure the installed autostart service is running (idempotent)
  service restart   Schedule an explicit service-manager restart and return before handoff
  service stop      Stop the installed autostart service
  service uninstall Remove only the autostart entry
  status            Print redacted local profile state and Worker health
  doctor            Check Node, Wrangler, Cloudflare login, Worker health
  full-test         Run real local full-profile capability tests in a temporary sandbox
  rotate-secrets    Rotate account-admin, device identity, and global token-version secrets
  account list|clients|revoke-client|add|role|enable|disable|rotate-password|remove
                    Manage remote accounts, trusted clients, and targeted revocation
  resource generate-ssh-key NAME [PATH]
                    Generate/reuse an Ed25519 key locally and register its private file by alias
  browser status    Show browser-extension bridge and connection status
  browser setup     Print the extension path and open the local pairing page
  browser path      Print the packaged unpacked-extension directory
  uninstall         Delete known Worker(s), remove autostart and local state

Start options:
  --workspace PATH      Use and remember this workspace path
  --worker-name NAME    Worker name (default: mbm-<workspace-hash>); changing an existing name requires --force-worker
  --force-worker        Force same-name deployment, or explicitly allow an intentional --worker-name replacement
  --rotate-secrets      Rotate secrets before deploying
  --daemon-only         Skip deploy and only connect daemon from existing state
  --no-autostart        Do not install login autostart during start
  --profile NAME        Policy profile: full (default), agent, edit, or review
  --exec-mode MODE      Command mode: off, direct argv, or full shell
  --no-write            Disable write_file, edit_file, and apply_patch
  --no-exec             Disable run_process and exec_command
  --full-env            Pass the full parent environment to local commands
  --unrestricted-paths  Allow filesystem tools outside the workspace
  --absolute-paths      Return absolute local paths (enabled by the full profile)
  --state-dir DIR       Override state root
  --json                Print machine-readable output; newly generated account passwords are included once
  --log-level LEVEL     error, warn, info (default), or debug
  --log-format FORMAT   text (default) or newline-delimited json
  --verbose             Alias for --log-level debug; includes per-tool success/correlation logs
  --quiet               Alias for --log-level error
  --allow-insecure-permissions
                        Permit resource registration when a file is group/other-readable
  --show-paths          Include local absolute paths in resource command output

Uninstall options:
  --keep-worker         Do not delete deployed Worker(s) during uninstall
  --yes                 Do not prompt before uninstall
`);
}

function currentPackageVersion() {
  return packageVersion;
}

function version() {
  console.log(`${packageName} ${packageVersion}`);
}

function sleep(ms) {
  return new Promise(resolvePromise => { setTimeout(resolvePromise, ms); });
}
