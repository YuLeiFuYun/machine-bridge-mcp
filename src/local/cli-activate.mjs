import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon } from "./daemon-process.mjs";
import { effectiveLogFormat, effectiveLogLevel } from "./cli-options.mjs";
import { createLogger } from "./log.mjs";
import { activatePersistentRuntime } from "./runtime-activation.mjs";
import { autostartStatus, installAutostart, startAutostart, stopAutostart } from "./service.mjs";
import { startOwnedServiceRuntime } from "./service-runtime.mjs";
import { acquireMachineServiceLockWithWait, acquireStartupLockWithWait, daemonLockPathForState, loadState, readDaemonLockOwner } from "./state.mjs";
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
      }),
      repairRemoteState: async ({ onRemotePrepared } = {}) => {
        logger.warn("candidate device authentication was rejected; redeploying the same Worker once with the current device identity");
        return prepareRemoteState({
          args: { ...activationArgs, forceWorker: true, rotateSecrets: false },
          workspace,
          state,
          logger,
          onRemotePrepared,
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
      installAutostart: () => installAutostart({
        workspace,
        stateRoot: state.paths.stateRoot,
        entryScript: process.argv[1],
        version: expectedVersion,
        logger: structuredLogger(true),
      }),
      startAutostart: () => startOwnedServiceRuntime({ logger: structuredLogger(true) }),
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
