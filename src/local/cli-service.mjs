import process from "node:process";
import * as defaultService from "./service.mjs";
import { inspectWorkspaceDaemon, stopWorkspaceServiceDaemon } from "./daemon-process.mjs";
import { stopAndRemoveAutostart } from "./service-lifecycle.mjs";
import { serviceEnvironmentSummary } from "./service-environment.mjs";
import { scheduleServiceRestart } from "./service-restart-scheduler.mjs";
import { startOwnedServiceRuntime } from "./service-runtime.mjs";
import { loadServiceOwner } from "./service-owner.mjs";
import { loadState, resolveWorkspace, selectedWorkspace } from "./state.mjs";

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
    effective_active: Boolean(status.active || workspaceDaemon?.alive),
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
  const state = optionalServiceState(args, stateRoot, context);
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
