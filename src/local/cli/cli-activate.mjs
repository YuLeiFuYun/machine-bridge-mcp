import { normalizeLogLevel, createLogger } from "../core/log.mjs";
import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon, stopWorkspaceServiceDaemon } from "../transport/daemon-process.mjs";
import { activatePersistentRuntime } from "../runtime/runtime-activation.mjs";
import * as defaultService from "../deploy/service.mjs";
const { autostartStatus, installAutostart, startAutostart, stopAutostart } = defaultService;
import { preflightServiceRestartability, startOwnedServiceRuntime } from "../deploy/service-runtime.mjs";
import { acquireMachineServiceLockWithWait, acquireStartupLockWithWait, daemonLockPathForState, loadState, readDaemonLockOwner, resolveWorkspace, selectedWorkspace } from "../state/state.mjs";
import { workerHealth } from "../transport/network-proxy.mjs";
import process from "node:process";
import { stopAndRemoveAutostart, serviceEnvironmentSummary } from "../deploy/service-support.mjs";
import { scheduleServiceRestart } from "../deploy/service-handoff.mjs";
import { loadServiceOwner } from "../deploy/service-owner.mjs";

const BOOLEAN_OPTIONS = new Set([
  "help", "version", "quiet", "json", "verbose", "rotateSecrets", "forceWorker",
  "daemonOnly", "noAutostart", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  "yes", "keepWorker", "allowInsecurePermissions", "showPaths", "repairResourceCoordinator", "progressive", "allTools",
]);

const VALUE_OPTIONS = new Set([
  "workspace", "stateDir", "workerName", "profile", "execMode", "client", "logLevel", "logFormat", "ttl", "role",
]);

const LOG_FORMATS = new Set(["text", "json"]);

const COMMAND_OPTIONS = new Map(Object.entries({
  start: new Set([
    "workspace", "stateDir", "workerName", "quiet", "json", "verbose", "logLevel", "logFormat", "rotateSecrets", "forceWorker",
    "daemonOnly", "noAutostart",
    "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  ]),
  activate: new Set([
    "workspace", "stateDir", "workerName", "quiet", "json", "verbose", "logLevel", "logFormat", "rotateSecrets", "forceWorker",
    "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  ]),
  stdio: new Set(["workspace", "stateDir", "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths", "verbose", "quiet", "logLevel", "logFormat", "progressive", "allTools"]),
  "client-config": new Set(["workspace", "stateDir", "profile", "client", "json", "progressive", "allTools"]),
  status: new Set(["workspace", "stateDir"]),
  doctor: new Set(["workspace", "stateDir", "repairResourceCoordinator"]),
  verify: new Set(["workspace", "stateDir", "json"]),
  pair: new Set(["stateDir", "ttl", "role", "json"]),
  "full-test": new Set(["workspace", "stateDir", "json"]),
  "rotate-secrets": new Set(["workspace", "stateDir", "quiet"]),
  workspace: new Set(["workspace", "stateDir"]),
  "idle-sleep": new Set(["stateDir"]),
  service: new Set(["workspace", "stateDir", "quiet"]),
  autostart: new Set(["workspace", "stateDir", "quiet"]),
  resource: new Set(["workspace", "stateDir", "allowInsecurePermissions", "showPaths", "json"]),
  account: new Set(["workspace", "stateDir", "json", "yes"]),
  browser: new Set(["workspace", "stateDir", "json"]),
  job: new Set(["workspace", "stateDir", "json", "yes"]),
  uninstall: new Set(["stateDir", "keepWorker", "yes"]),
}));

const SINGLE_WORKSPACE_POSITIONAL_COMMANDS = new Set(["start", "activate", "stdio", "status", "doctor", "full-test", "rotate-secrets"]);

const STATIC_POSITIONAL_RULES = new Map([
  ["client-config", Object.freeze({ max: 1, tooMany: "client-config accepts at most one positional client name" })],
  ["uninstall", Object.freeze({ max: 0, tooMany: "uninstall does not accept positional arguments" })],
  ["verify", Object.freeze({ max: 0, tooMany: "verify does not accept positional arguments" })],
  ["pair", Object.freeze({ max: 0, tooMany: "pair does not accept positional arguments" })],
]);

const RESOURCE_POSITIONAL_LIMITS = new Map(Object.entries({ add: 3, "generate-ssh-key": 3, remove: 2, check: 2 }));

const JOB_POSITIONAL_LIMITS = new Map(Object.entries({ read: 2, inspect: 2, cancel: 2, submit: 2 }));

const ACCOUNT_POSITIONAL_LIMITS = new Map(Object.entries({ list: 1, clients: 1, "revoke-client": 2, add: 3, role: 3, enable: 2, disable: 2, "rotate-password": 2, remove: 2 }));

const ACTION_POSITIONAL_RULES = new Map(Object.entries({
  workspace(args) {
    const action = String(args._[0] || "show");
    const max = action === "migrate" ? 3 : action === "set" || action === "select" ? 2 : 1;
    return { max, tooMany: `workspace ${action} received too many positional arguments`, workspaceConflictAfter: action === "set" || action === "select" ? 1 : undefined };
  },
  "idle-sleep"(args) {
    const action = String(args._[0] || "show");
    return { max: action === "set" ? 2 : 1, tooMany: `idle-sleep ${action} received too many positional arguments` };
  },
  service(args) {
    const action = String(args._[0] || "status");
    return { max: ["install", "status", "stop"].includes(action) ? 2 : 1, tooMany: `service ${action} received too many positional arguments`, workspaceConflictAfter: 1 };
  },
  autostart(args) { return ACTION_POSITIONAL_RULES.get("service")(args); },
  resource(args) {
    const action = String(args._[0] || "list");
    return { max: RESOURCE_POSITIONAL_LIMITS.get(action) ?? 1, tooMany: `resource ${action} received too many positional arguments` };
  },
  account(args) {
    const action = String(args._[0] || "list");
    return { max: ACCOUNT_POSITIONAL_LIMITS.get(action) ?? 1, tooMany: `account ${action} received too many positional arguments` };
  },
  browser(args) {
    const action = String(args._[0] || "status");
    return { max: 1, tooMany: `browser ${action} received too many positional arguments` };
  },
  job(args) {
    const action = String(args._[0] || "list");
    const max = JOB_POSITIONAL_LIMITS.get(action);
    return max === undefined ? null : { max, tooMany: `job ${action} received too many positional arguments` };
  },
}));

export function normalizeCommand(argv) {
  if (!argv.length || argv[0].startsWith("--")) return ["start", argv];
  return [argv[0], argv.slice(1)];
}

export function parseArgs(argv) {
  const out = { _: [] };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (positionalOnly || raw === "-" || !raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    if (raw === "--") {
      positionalOnly = true;
      continue;
    }
    const separator = raw.indexOf("=");
    const rawKey = raw.slice(2, separator >= 0 ? separator : undefined);
    if (!rawKey) throw new Error("invalid empty option");
    const key = toCamel(rawKey);
    if (!BOOLEAN_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${rawKey}`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`Duplicate option: --${rawKey}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      out[key] = separator >= 0 ? parseBooleanOption(raw.slice(separator + 1), rawKey) : true;
      continue;
    }
    const value = separator >= 0 ? raw.slice(separator + 1) : argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Option --${rawKey} requires a value`);
    out[key] = value;
  }
  return out;
}

export function validateCommandOptions(command, args) {
  if ((command === "stdio" || command === "client-config") && args.progressive) {
    throw new Error("--progressive is unsupported by MCP 2026-07-28; use host-side tool discovery or --all-tools");
  }
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) return;
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || key === "version") continue;
    if (!allowed.has(key)) throw new Error(`Option --${toKebab(key)} is not valid for ${command}`);
  }
}

export function validateLoggingOptions(args = {}) {
  if (args.quiet && args.verbose) throw new Error("--quiet and --verbose cannot be used together");
  if (args.logLevel !== undefined && (args.quiet || args.verbose)) throw new Error("--log-level cannot be combined with --quiet or --verbose");
  if (args.logLevel !== undefined) normalizeLogLevel(args.logLevel);
  if (args.logFormat !== undefined && !LOG_FORMATS.has(String(args.logFormat).toLowerCase())) throw new Error("--log-format must be text or json");
}

export function validatePositionals(command, args) {
  const rule = positionalRule(command, args);
  if (!rule) return;
  if (args._.length > rule.max) throw new Error(rule.tooMany);
  if (args.workspace && Number.isInteger(rule.workspaceConflictAfter) && args._.length > rule.workspaceConflictAfter) {
    throw new Error("workspace path was provided both positionally and with --workspace");
  }
}

export function effectiveLogLevel(args = {}) {
  if (args.logLevel !== undefined) return normalizeLogLevel(args.logLevel);
  if (args.quiet) return "error";
  if (args.verbose) return "debug";
  return "info";
}

export function effectiveLogFormat(args = {}) {
  return String(args.logFormat || "text").toLowerCase();
}

function positionalRule(command, args) {
  if (SINGLE_WORKSPACE_POSITIONAL_COMMANDS.has(command)) {
    return { max: 1, tooMany: `${command} accepts at most one positional workspace path`, workspaceConflictAfter: 0 };
  }
  if (STATIC_POSITIONAL_RULES.has(command)) return STATIC_POSITIONAL_RULES.get(command);
  return ACTION_POSITIONAL_RULES.get(command)?.(args) || null;
}

function parseBooleanOption(value, key) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Option --${key} expects true or false when using =`);
}

function toCamel(key) { return key.replace(/-([a-z])/g, (_, character) => character.toUpperCase()); }

function toKebab(value) { return String(value).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`); }
export function createActivateCommand({
  chooseWorkspace,
  prepareRemoteState,
  createRemoteRuntime,
  currentPackageVersion,
  assertNodeVersion,
  structuredLogger,
} = {}) {
  for (const [name, value] of Object.entries({
    chooseWorkspace,
    prepareRemoteState,
    createRemoteRuntime,
    currentPackageVersion,
    assertNodeVersion,
    structuredLogger,
  })) {
    if (typeof value !== "function") throw new TypeError(`activate command requires ${name}`);
  }

  return async function activateCommand(args) {
    assertNodeVersion();
    const logger = createLogger({
      level: args.json ? "error" : effectiveLogLevel(args),
      format: effectiveLogFormat(args),
      component: "activate",
    });
    const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: true, allowPositional: true });
    let state = loadState(workspace, { stateDir: args.stateDir });
    if (!state.worker?.url) {
      throw new Error("activate requires an existing deployment; run machine-mcp once interactively before persistent activation");
    }
    const activationArgs = { ...args, noAutostart: true, daemonOnly: false };
    const expectedVersion = currentPackageVersion();
    const result = await activatePersistentRuntime({
      expectedVersion,
      acquireStartupLock: async () => {
        const lock = await acquireStartupLockWithWait(state, { operation: "activate", logger });
        try {
          state = loadState(workspace, { stateDir: args.stateDir });
          if (!state.worker?.url) throw new Error("activate requires an existing deployment; run machine-mcp once interactively before persistent activation");
          return lock;
        } catch (error) {
          lock.release();
          throw error;
        }
      },
      acquireServiceLock: () => acquireMachineServiceLockWithWait({ operation: "activate", logger }),
      inspectActivationOwnership: async () => {
        const daemon = inspectWorkspaceDaemon(state);
        const owner = daemon.alive && daemon.verified_service_daemon
          ? readDaemonLockOwner(daemonLockPathForState(state))
          : null;
        return {
          daemon,
          provider: await autostartStatus(),
          previousRuntime: owner ? { version: owner.version, entryScript: owner.entryScript } : null,
        };
      },
      preflightRestartability: () => preflightServiceRestartability({
        workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], expectedVersion,
      }),
      stopAutostart: () => stopAutostart({ logger: structuredLogger(true) }),
      acquireDaemonLock: () => acquireDaemonLockWithTakeover(state, {
        takeOverServiceOwner: true,
        ownerMetadata: { mode: "foreground", version: expectedVersion },
        logger,
      }),
      prepareRemoteState: ({ onRemotePrepared } = {}) => prepareRemoteState({
        args: activationArgs,
        workspace,
        state,
        logger,
        onRemotePrepared,
        // Candidate activation requires an existing deployment. Do not repeat
        // first-run account provisioning after Worker convergence: that extra
        // admin-auth round trip can fail independently before relay readiness.
        provisionInitialOwner: false,
      }),
      repairRemoteState: async ({ onRemotePrepared } = {}) => {
        logger.warn("candidate device authentication was rejected; redeploying the same Worker once with the current device identity");
        return prepareRemoteState({
          args: { ...activationArgs, forceWorker: true, rotateSecrets: false },
          workspace,
          state,
          logger,
          onRemotePrepared,
          provisionInitialOwner: false,
        });
      },
      createRuntime: ({ daemonLock, readiness }) => createRemoteRuntime({
        args: activationArgs,
        workspace,
        state,
        daemonLock,
        deviceSessionIdentity: readiness.deviceSessionIdentity,
        exitOnTerminal: false,
      }),
      installAutostart: ({ deferOwnerCommit } = {}) => {
        if (deferOwnerCommit !== true) throw new Error("persistent activation requires deferred service-owner commit");
        return installAutostart({
          workspace,
          stateRoot: state.paths.stateRoot,
          entryScript: process.argv[1],
          version: expectedVersion,
          logger: structuredLogger(true),
          deferOwnerCommit: true,
        });
      },
      startAutostart: ({ owner } = {}) => {
        if (!owner || owner.status !== "pending") throw new Error("persistent activation requires the pending candidate service owner");
        return startOwnedServiceRuntime({ logger: structuredLogger(true), owner });
      },
      startRecoveryAutostart: () => startAutostart({ logger: structuredLogger(true) }),
      restorePreviousAutostart: () => startAutostart({ logger: structuredLogger(true) }),
      inspectCandidateAutostart: () => inspectWorkspaceDaemon(state, {
        expectedVersion, expectedEntryScript: process.argv[1],
      }),
      inspectPreviousAutostart: (identity) => inspectWorkspaceDaemon(state, {
        expectedVersion: identity.version, expectedEntryScript: identity.entryScript,
      }),
      inspectDaemon: async () => inspectWorkspaceDaemon(state, {
        expectedVersion, expectedEntryScript: process.argv[1],
      }),
      checkWorker: async () => workerHealth(state.worker.url, expectedVersion, { expectedWorkerName: state.worker.name }),
    });
    const convergence = result.convergence;
    const payload = {
      ok: true,
      version: expectedVersion,
      workspace: state.workspace.path,
      worker: { name: state.worker.name, url: state.worker.url, health: convergence.worker },
      daemon: convergence.daemon,
      service: result.serviceStart,
      candidate_relay_verified_before_handoff: result.candidateRelayVerified,
      candidate_auth_recovery_redeployed: result.candidateRecoveryRedeployed,
      activation_recovered: result.activationRecovered === true,
      activation_recovery_reason: result.activationRecovered === true ? result.recoveryReason : null,
      activation_recovery_detail: result.activationRecovered === true ? result.recoveryDetail : null,
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      if (result.activationRecovered === true) {
        logger.warn(`persistent activation completed through verified candidate-service recovery (${result.recoveryReason}): ${result.recoveryDetail}`);
      }
      logger.success(`Persistent runtime activated: ${expectedVersion}`);
      logger.safePlain(`  Worker: ${state.worker.name}`);
      logger.safePlain(`  Daemon: pid ${convergence.daemon.pid}`);
      logger.safePlain("  Candidate relay readiness was verified before the login service handoff.");
      if (result.activationRecovered === true) {
        logger.safePlain("  The exact candidate login service was independently verified after the foreground candidate ended.");
      }
      logger.safePlain("  The login service now owns the daemon; the activation terminal may close.");
    }
    return payload;
  };
}
const SERVICE_ACTION_HANDLERS = new Map([
  ["status", serviceStatusAction],
  ["install", serviceInstallAction],
  ["start", serviceStartAction],
  ["restart", serviceRestartAction],
  ["stop", serviceStopAction],
  ["uninstall", serviceUninstallAction],
  ["remove", serviceUninstallAction],
]);

export function createServiceCommand(dependencies) {
  const context = {
    chooseWorkspace: requiredFunction(dependencies.chooseWorkspace, "chooseWorkspace"),
    stateRootFromArgs: requiredFunction(dependencies.stateRootFromArgs, "stateRootFromArgs"),
    structuredLogger: requiredFunction(dependencies.structuredLogger, "structuredLogger"),
    currentPackageVersion: requiredFunction(dependencies.currentPackageVersion, "currentPackageVersion"),
    service: dependencies.service || defaultService,
    inspectWorkspaceDaemon: dependencies.inspectWorkspaceDaemon || inspectWorkspaceDaemon,
    stopWorkspaceServiceDaemon: dependencies.stopWorkspaceServiceDaemon || stopWorkspaceServiceDaemon,
    stopAndRemoveAutostart: dependencies.stopAndRemoveAutostart || stopAndRemoveAutostart,
    serviceEnvironmentSummary: dependencies.serviceEnvironmentSummary || serviceEnvironmentSummary,
    loadServiceOwner: dependencies.loadServiceOwner || loadServiceOwner,
    scheduleServiceRestart: dependencies.scheduleServiceRestart || scheduleServiceRestart,
    startOwnedServiceRuntime: dependencies.startOwnedServiceRuntime || startOwnedServiceRuntime,
    acquireMachineServiceLockWithWait: requiredFunction(
      dependencies.acquireMachineServiceLockWithWait, "acquireMachineServiceLockWithWait",
    ),
    loadState: dependencies.loadState || loadState,
    resolveWorkspace: dependencies.resolveWorkspace || resolveWorkspace,
    selectedWorkspace: dependencies.selectedWorkspace || selectedWorkspace,
    entryScript: dependencies.entryScript || process.argv[1],
    setExitCode: dependencies.setExitCode || setProcessExitCode,
    print: dependencies.print || printLine,
  };
  return (args) => serviceCommand(args, context);
}

async function serviceCommand(args, context) {
  const action = String(args._[0] || "status").toLowerCase();
  const handler = SERVICE_ACTION_HANDLERS.get(action);
  if (!handler) throw new Error(`Unknown service action: ${action}`);
  const stateRoot = context.stateRootFromArgs(args);
  if (!new Set(["install", "start", "stop", "uninstall", "remove"]).has(action)) {
    return handler({ args, stateRoot, service: context.service, context });
  }
  const lock = await context.acquireMachineServiceLockWithWait({ operation: `service-${action}` });
  if (!lock?.acquired || typeof lock.release !== "function") {
    throw new Error("machine-service operation lock could not be acquired");
  }
  try {
    return await handler({ args, stateRoot, service: context.service, context });
  } finally {
    lock.release();
  }
}

async function serviceStatusAction({ args, stateRoot, service, context }) {
  const status = await service.autostartStatus();
  let owner = null;
  let ownerProjection = { status: "missing", version: null };
  try {
    owner = context.loadServiceOwner();
    if (owner) ownerProjection = { status: owner.status, version: owner.version };
  } catch {
    ownerProjection = { status: "invalid", version: null, error_class: "invalid_state" };
  }
  const explicitState = hasExplicitServiceTarget(args) ? optionalServiceState(args, stateRoot, context) : null;
  const ownerState = !explicitState && owner?.status === "committed"
    ? context.loadState(owner.workspace, { stateDir: owner.stateRoot })
    : null;
  const state = explicitState || ownerState || optionalServiceState(args, stateRoot, context);
  const effectiveStateRoot = ownerState ? owner.stateRoot : stateRoot;
  const workspaceDaemon = state ? context.inspectWorkspaceDaemon(state, ownerState ? {
    expectedVersion: owner.version, expectedEntryScript: owner.entryScript,
  } : {}) : null;
  printServiceResult({
    ...status,
    workspace: state?.workspace?.path || null,
    workspace_daemon: workspaceDaemon,
    service_owner: ownerProjection,
    service_environment: context.serviceEnvironmentSummary(effectiveStateRoot),
    effective_active: status.active === true || workspaceDaemon?.alive === true ? true : status.active === false ? false : null,
    orphaned_workspace_daemon: Boolean(status.active === false && workspaceDaemon?.alive && workspaceDaemon?.verified_service_daemon),
  }, context, false);
}

async function serviceInstallAction({ args, stateRoot, service, context }) {
  const workspaceArgs = { ...args, _: args._.slice(1) };
  const workspace = await context.chooseWorkspace(workspaceArgs, { promptOnFirstRun: true, save: true, allowPositional: true });
  const state = context.loadState(workspace, { stateDir: stateRoot });
  if (!state.worker?.url) {
    throw new Error("No deployed Worker is recorded for this workspace. Run `machine-mcp` once before `machine-mcp service install`.");
  }
  const provider = await service.autostartStatus();
  const daemon = context.inspectWorkspaceDaemon(state);
  if (typeof provider?.active !== "boolean") {
    throw new Error("machine service activity could not be verified before installation");
  }
  if (provider.active || daemon?.alive) {
    throw new Error("refusing to replace the machine service definition while a provider or workspace daemon is active");
  }
  const result = await service.installAutostart({
    workspace,
    stateRoot,
    entryScript: context.entryScript,
    version: context.currentPackageVersion(),
    logger: context.structuredLogger(Boolean(args.quiet)),
  });
  printServiceResult(result, context);
}

async function serviceStartAction({ args, service, context }) {
  assertGlobalServiceAction(args, "start");
  const logger = context.structuredLogger(Boolean(args.quiet));
  const result = await context.startOwnedServiceRuntime({
    logger,
    readProvider: service.autostartStatus,
    mutateProvider: service.startAutostart,
    stopProvider: service.stopAutostart,
  });
  printServiceResult(result, context);
}

async function serviceRestartAction({ args, context }) {
  assertGlobalServiceAction(args, "restart");
  const result = await context.scheduleServiceRestart();
  printServiceResult({ ...result, provider: "detached-handoff", reason: "restart_scheduled" }, context);
}

async function serviceStopAction({ args, stateRoot, service, context }) {
  const logger = context.structuredLogger(Boolean(args.quiet));
  const state = hasExplicitServiceTarget(args)
    ? optionalServiceState(args, stateRoot, context)
    : null;
  const status = await service.autostartStatus();
  const before = state ? context.inspectWorkspaceDaemon(state) : null;
  assertExplicitStopTarget(args, status, before);
  const provider = await service.stopAutostart({ logger });
  const workspaceDaemon = state
    ? await context.stopWorkspaceServiceDaemon(state, { logger, reason: "service stop" })
    : { ok: true, found: false, stopped: false, verified_service_daemon: false, reason: "workspace_not_selected" };
  printServiceResult({
    ...provider,
    ok: provider?.ok !== false && workspaceDaemon.ok,
    workspace: state?.workspace?.path || null,
    workspace_daemon: workspaceDaemon,
  }, context);
}

async function serviceUninstallAction({ args, stateRoot, context }) {
  assertGlobalServiceAction(args, "uninstall");
  const logger = context.structuredLogger(Boolean(args.quiet));
  const state = optionalServiceState({ ...args, workspace: undefined, stateDir: undefined }, stateRoot, context);
  const lifecycle = await context.stopAndRemoveAutostart({
    states: state ? [state] : [],
    stateRoot,
    logger,
    reason: "service uninstall",
    stopAutostart: context.service.stopAutostart,
    uninstallAutostart: context.service.uninstallAutostart,
    stopWorkspaceServiceDaemon: context.stopWorkspaceServiceDaemon,
  });
  printServiceResult({
    ...lifecycle,
    workspace: state?.workspace?.path || null,
    workspace_daemon: lifecycle.workspace_daemons[0] || null,
    autostart_removed: lifecycle.removed,
  }, context);
}

function assertGlobalServiceAction(args, action) {
  if (args.workspace || args.stateDir || args._[1]) {
    throw new Error(`service ${action} acts on the single installed machine service and does not accept workspace or state overrides; use service install to change its owner`);
  }
}

function assertExplicitStopTarget(args, status, workspaceDaemon) {
  if (!hasExplicitServiceTarget(args) || status?.active !== true) return;
  if (workspaceDaemon?.alive === true && workspaceDaemon?.verified_service_daemon === true) return;
  throw new Error("refusing to stop the active machine service because the requested workspace/state does not own its verified daemon; omit the target to stop the installed service globally");
}

function hasExplicitServiceTarget(args) {
  return Boolean(args.workspace || args.stateDir || args._[1]);
}

function optionalServiceState(args, stateRoot, context) {
  const requested = args.workspace || args._[1] || context.selectedWorkspace(stateRoot);
  if (!requested || requested === true) return null;
  return context.loadState(context.resolveWorkspace(String(requested)), { stateDir: stateRoot });
}

function printServiceResult(result, context, updateExitCode = true) {
  context.print(JSON.stringify(result, null, 2));
  if (updateExitCode && result?.ok === false) context.setExitCode(1);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`service command requires ${name}`);
  return value;
}

function setProcessExitCode(value) { process.exitCode = value; }

function printLine(value) { console.log(value); }
