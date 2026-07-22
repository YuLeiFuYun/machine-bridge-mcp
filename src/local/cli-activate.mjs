import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon } from "./daemon-process.mjs";
import { effectiveLogFormat, effectiveLogLevel } from "./cli-options.mjs";
import { createLogger } from "./log.mjs";
import { activatePersistentRuntime } from "./runtime-activation.mjs";
import { installAutostart, startAutostart, stopAutostart } from "./service.mjs";
import { acquireStartupLockWithWait, loadState } from "./state.mjs";
import { workerHealth } from "./worker-health.mjs";

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
    const state = loadState(workspace, { stateDir: args.stateDir });
    if (!state.worker?.url) {
      throw new Error("activate requires an existing deployment; run machine-mcp once interactively before persistent activation");
    }
    const activationArgs = { ...args, noAutostart: true, daemonOnly: false };
    const expectedVersion = currentPackageVersion();
    const result = await activatePersistentRuntime({
      expectedVersion,
      acquireStartupLock: () => acquireStartupLockWithWait(state, { operation: "activate", logger }),
      stopAutostart: () => stopAutostart({ logger: structuredLogger(true) }),
      acquireDaemonLock: () => acquireDaemonLockWithTakeover(state, {
        takeOverServiceOwner: true,
        ownerMetadata: { mode: "foreground", version: expectedVersion },
        logger,
      }),
      prepareRemoteState: () => prepareRemoteState({ args: activationArgs, workspace, state, logger }),
      createRuntime: ({ daemonLock, readiness }) => createRemoteRuntime({
        args: activationArgs,
        workspace,
        state,
        daemonLock,
        deviceSessionIdentity: readiness.deviceSessionIdentity,
        exitOnTerminal: false,
      }),
      installAutostart: () => installAutostart({
        workspace,
        stateRoot: state.paths.stateRoot,
        entryScript: process.argv[1],
        logger: structuredLogger(true),
      }),
      startAutostart: () => startAutostart({ logger: structuredLogger(true) }),
      inspectDaemon: async () => inspectWorkspaceDaemon(state),
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
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      logger.success(`Persistent runtime activated: ${expectedVersion}`);
      logger.safePlain(`  Worker: ${state.worker.name}`);
      logger.safePlain(`  Daemon: pid ${convergence.daemon.pid}`);
      logger.safePlain("  Candidate relay readiness was verified before the login service handoff.");
      logger.safePlain("  The login service now owns the daemon; the activation terminal may close.");
    }
    return payload;
  };
}
