import process from "node:process";
import * as defaultService from "./service.mjs";
import { inspectWorkspaceDaemon, stopWorkspaceServiceDaemon } from "./daemon-process.mjs";
import { stopAndRemoveAutostart } from "./service-lifecycle.mjs";
import { serviceEnvironmentSummary } from "./service-environment.mjs";
import { loadState, resolveWorkspace, selectedWorkspace } from "./state.mjs";

const SERVICE_ACTION_HANDLERS = new Map([
  ["status", serviceStatusAction],
  ["install", serviceInstallAction],
  ["start", serviceStartAction],
  ["stop", serviceStopAction],
  ["uninstall", serviceUninstallAction],
  ["remove", serviceUninstallAction],
]);

export function createServiceCommand(dependencies) {
  const context = {
    chooseWorkspace: requiredFunction(dependencies.chooseWorkspace, "chooseWorkspace"),
    stateRootFromArgs: requiredFunction(dependencies.stateRootFromArgs, "stateRootFromArgs"),
    structuredLogger: requiredFunction(dependencies.structuredLogger, "structuredLogger"),
    service: dependencies.service || defaultService,
    inspectWorkspaceDaemon: dependencies.inspectWorkspaceDaemon || inspectWorkspaceDaemon,
    stopWorkspaceServiceDaemon: dependencies.stopWorkspaceServiceDaemon || stopWorkspaceServiceDaemon,
    stopAndRemoveAutostart: dependencies.stopAndRemoveAutostart || stopAndRemoveAutostart,
    serviceEnvironmentSummary: dependencies.serviceEnvironmentSummary || serviceEnvironmentSummary,
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
  return handler({ args, stateRoot, service: context.service, context });
}

async function serviceStatusAction({ args, stateRoot, service, context }) {
  const status = await service.autostartStatus();
  const state = optionalServiceState(args, stateRoot, context);
  const workspaceDaemon = state ? context.inspectWorkspaceDaemon(state) : null;
  printServiceResult({
    ...status,
    workspace: state?.workspace?.path || null,
    workspace_daemon: workspaceDaemon,
    service_environment: context.serviceEnvironmentSummary(stateRoot),
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
  const result = await service.installAutostart({
    workspace,
    stateRoot,
    entryScript: context.entryScript,
    logger: context.structuredLogger(Boolean(args.quiet)),
  });
  printServiceResult(result, context);
}

async function serviceStartAction({ args, service, context }) {
  const result = await service.startAutostart({ logger: context.structuredLogger(Boolean(args.quiet)) });
  printServiceResult(result, context);
}

async function serviceStopAction({ args, stateRoot, service, context }) {
  const logger = context.structuredLogger(Boolean(args.quiet));
  const provider = await service.stopAutostart({ logger });
  const state = optionalServiceState(args, stateRoot, context);
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

async function serviceUninstallAction({ args, stateRoot, service, context }) {
  const logger = context.structuredLogger(Boolean(args.quiet));
  const state = optionalServiceState(args, stateRoot, context);
  const lifecycle = await context.stopAndRemoveAutostart({
    states: state ? [state] : [],
    stateRoot,
    logger,
    reason: "service uninstall",
    stopAutostart: service.stopAutostart,
    uninstallAutostart: service.uninstallAutostart,
    stopWorkspaceServiceDaemon: context.stopWorkspaceServiceDaemon,
  });
  printServiceResult({
    ...lifecycle,
    workspace: state?.workspace?.path || null,
    workspace_daemon: lifecycle.workspace_daemons[0] || null,
    autostart_removed: lifecycle.removed,
  }, context);
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
