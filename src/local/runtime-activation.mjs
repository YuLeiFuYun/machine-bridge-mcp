export async function activatePersistentRuntime(options = {}) {
  const required = [
    "acquireStartupLock",
    "acquireServiceLock",
    "inspectActivationOwnership",
    "stopAutostart",
    "acquireDaemonLock",
    "prepareRemoteState",
    "createRuntime",
    "installAutostart",
    "startAutostart",
    "inspectDaemon",
    "checkWorker",
  ];
  for (const name of required) {
    if (typeof options[name] !== "function") throw new TypeError(`runtime activation requires ${name}`);
  }
  const expectedVersion = requiredExpectedVersion(options.expectedVersion);
  const maximumAttempts = boundedAttempts(options.maximumAttempts ?? 240);
  const candidateStartAttempts = boundedCandidateStartAttempts(options.candidateStartAttempts ?? 10);
  const candidateRetryWait = optionalFunction(options.candidateRetryWait, "candidateRetryWait", defaultCandidateRetryWait);
  const convergenceWait = optionalFunction(options.wait, "wait", defaultWait);
  const restorePreviousAutostart = optionalFunction(options.restorePreviousAutostart, "restorePreviousAutostart", options.startAutostart);
  const startRecoveryAutostart = optionalFunction(options.startRecoveryAutostart, "startRecoveryAutostart", options.startAutostart);
  const inspectCandidateAutostart = optionalFunction(options.inspectCandidateAutostart, "inspectCandidateAutostart", options.inspectDaemon);
  if (options.repairRemoteState !== undefined && typeof options.repairRemoteState !== "function") {
    throw new TypeError("runtime activation repairRemoteState must be a function");
  }

  let startupLock = null;
  let startupReleased = false;
  let serviceLock = null;
  let daemonLock = null;
  let candidateRuntime = null;
  let candidateRelayVerified = false;
  let candidateRecoveryRedeployed = false;
  let remotePrepared = false;
  let autostartInstalled = false;
  let providerStopped = false;
  let previousServiceRuntime = null;
  let serviceStarted = false;
  try {
    const acquiredServiceLock = await options.acquireServiceLock();
    if (!acquiredServiceLock?.acquired) {
      const owner = acquiredServiceLock?.owner || {};
      throw new Error(`another machine-service operation is active (pid ${owner.pid || "unknown"})`);
    }
    requireReleasableLock(acquiredServiceLock, "machine-service");
    serviceLock = acquiredServiceLock;
    const acquiredStartupLock = await options.acquireStartupLock();
    requireReleasableLock(acquiredStartupLock, "startup");
    startupLock = acquiredStartupLock;
    const ownership = validateActivationOwnership(await options.inspectActivationOwnership());
    providerStopped = ownership.previousServiceRuntimeActive;
    previousServiceRuntime = ownership.previousServiceRuntime;
    const providerStop = await options.stopAutostart();
    providerStopped = validateProviderStop(providerStop) || providerStopped;

    daemonLock = await options.acquireDaemonLock();
    if (!daemonLock?.acquired) {
      const owner = daemonLock?.owner || {};
      if (owner.mode === "foreground") {
        throw new Error(`a foreground daemon is active (pid ${owner.pid || "unknown"}); stop it explicitly before activation`);
      }
      throw new Error(`the existing daemon could not be taken over (pid ${owner.pid || "unknown"})`);
    }
    requireReleasableLock(daemonLock, "daemon");

    let readiness;
    try {
      readiness = await options.prepareRemoteState({
        onRemotePrepared() { remotePrepared = true; },
      });
      remotePrepared = true;
    } catch (error) {
      if (error?.deploymentSucceeded === true) remotePrepared = true;
      throw error;
    }

    const candidate = await startCandidateWithRecovery({
      attempts: candidateStartAttempts,
      daemonLock,
      readiness,
      createRuntime: options.createRuntime,
      repairRemoteState: options.repairRemoteState,
      wait: candidateRetryWait,
      onRuntimeCreated(runtime) { candidateRuntime = runtime; },
      onRuntimeStopped() { candidateRuntime = null; },
      onRemoteRepaired() { remotePrepared = true; },
    });
    candidateRuntime = candidate.runtime;
    candidateRelayVerified = true;
    candidateRecoveryRedeployed = candidate.repaired;

    const installed = await options.installAutostart();
    const terminalError = candidateRuntime.terminalError?.();
    if (terminalError) throw terminalError;
    if (installed?.ok !== true) {
      throw activationOperationalError(
        `autostart installation failed (${installed?.provider || "unknown"})`,
        "autostart_install_failed",
      );
    }
    autostartInstalled = true;

    candidateRuntime.stop();
    candidateRuntime = null;
    daemonLock.release();
    daemonLock = null;
    startupLock.release();
    startupReleased = true;

    const serviceStart = await options.startAutostart();
    requireActiveServiceStart(serviceStart, "autostart start", "autostart_start_failed");
    serviceStarted = true;

    const convergence = await waitForActivatedRuntime({
      expectedVersion,
      inspectDaemon: options.inspectDaemon,
      checkWorker: options.checkWorker,
      maximumAttempts,
      wait: convergenceWait,
    });
    if (!convergence.ok) {
      throw new Error(`persistent runtime activation did not converge (${convergence.reason})`);
    }
    serviceLock.release();
    serviceLock = null;
    return {
      ok: true,
      serviceStart,
      convergence,
      candidateRelayVerified,
      candidateRecoveryRedeployed,
    };
  } catch (error) {
    const settlement = await failedActivationSettlement({
      error,
      candidateRuntime,
      daemonLock,
      startupLock,
      startupReleased,
      serviceLock,
      providerStopped,
      serviceStarted,
      remotePrepared,
      autostartInstalled,
      installAutostart: options.installAutostart,
      startRecoveryAutostart,
      restorePreviousAutostart,
      inspectCandidateAutostart,
      inspectPreviousAutostart: options.inspectPreviousAutostart,
      checkWorker: options.checkWorker,
      expectedVersion,
      previousServiceRuntime,
      restoreWait: convergenceWait,
      restoreMaximumAttempts: options.maximumAttempts,
      candidateRelayVerified,
      candidateRecoveryRedeployed,
    });
    if (settlement?.ok === true) return settlement;
    throw settlement;
  }
}

async function failedActivationSettlement({
  error,
  candidateRuntime,
  daemonLock,
  startupLock,
  startupReleased,
  serviceLock,
  providerStopped,
  serviceStarted,
  remotePrepared,
  autostartInstalled,
  installAutostart,
  startRecoveryAutostart,
  restorePreviousAutostart,
  inspectCandidateAutostart,
  inspectPreviousAutostart,
  checkWorker,
  expectedVersion,
  previousServiceRuntime,
  restoreWait,
  restoreMaximumAttempts,
  candidateRelayVerified,
  candidateRecoveryRedeployed,
}) {
  const cleanupErrors = [];
  try { candidateRuntime?.stop?.(); } catch (failure) { cleanupErrors.push(failure); }
  try { daemonLock?.release?.(); } catch (failure) { cleanupErrors.push(failure); }
  if (!startupReleased && startupLock) {
    try { startupLock.release(); }
    catch (failure) { cleanupErrors.push(failure); }
  }
  let recovery = null;
  const cleanupIncomplete = error?.cleanupIncomplete === true || cleanupErrors.length > 0;
  if (!cleanupIncomplete) {
    try {
      recovery = await restoreCompatibleProvider({
        installAutostart,
        startRecoveryAutostart,
        restorePreviousAutostart,
        inspectCandidateAutostart,
        inspectPreviousAutostart,
        checkWorker,
        expectedVersion,
        previousServiceRuntime,
        restoreWait,
        restoreMaximumAttempts,
        providerStopped,
        serviceStarted,
        candidateServiceRequired: remotePrepared,
        candidateDefinitionRequired: remotePrepared && !autostartInstalled,
      });
    } catch (failure) { cleanupErrors.push(failure); }
  }
  if (serviceLock) {
    try { serviceLock.release(); } catch (failure) { cleanupErrors.push(failure); }
  }
  if (cleanupErrors.length) return activationCleanupFailure(error, cleanupErrors);
  if (recovery?.candidateServiceStarted && candidateRelayVerified && recoverablePostReadySettlement(error)) {
    return {
      ok: true,
      serviceStart: recovery.serviceStart,
      convergence: recovery.convergence,
      candidateRelayVerified: true,
      candidateRecoveryRedeployed,
      activationRecovered: true,
      recoveryReason: activationRecoveryReason(error),
      recoveryDetail: activationRecoveryDetail(error),
    };
  }
  if (recovery?.candidateServiceStarted) return activationFailureWithRecovery(error);
  return error;
}

async function startCandidateWithRecovery({
  attempts = 3,
  daemonLock,
  readiness,
  createRuntime,
  repairRemoteState,
  wait = defaultCandidateRetryWait,
  onRuntimeCreated,
  onRuntimeStopped,
  onRemoteRepaired,
} = {}) {
  const maximumAttempts = boundedCandidateStartAttempts(attempts);
  let currentReadiness = readiness;
  let repaired = false;
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const runtime = createRuntime({ daemonLock, readiness: currentReadiness });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("runtime activation candidate must expose start and stop");
    }
    onRuntimeCreated(runtime);
    try {
      await runtime.start();
      return { runtime, repaired };
    } catch (error) {
      lastError = error;
      let stopFailure = null;
      try { await runtime.stop(); } catch (failure) { stopFailure = failure; }
      finally { onRuntimeStopped(); }
      if (stopFailure) {
        const cleanupError = new AggregateError(
          [error, stopFailure],
          "candidate relay start failed and runtime cleanup was incomplete",
        );
        cleanupError.cleanupIncomplete = true;
        throw cleanupError;
      }
      if (!recoverableCandidateStartError(error) || attempt >= maximumAttempts) throw error;
      if (!repaired && typeof repairRemoteState === "function") {
        let repairPrepared = false;
        const markRemoteRepaired = () => {
          if (repairPrepared) return;
          repairPrepared = true;
          onRemoteRepaired();
        };
        currentReadiness = await repairRemoteState({
          attempt,
          error,
          readiness: currentReadiness,
          onRemotePrepared: markRemoteRepaired,
        });
        repaired = true;
        markRemoteRepaired();
      }
      await wait(attempt);
    }
  }
  throw lastError || new Error("candidate relay did not start");
}

function recoverableCandidateStartError(error) {
  return error?.code === "relay_authentication_failed";
}

async function restoreCompatibleProvider({
  installAutostart,
  startRecoveryAutostart,
  restorePreviousAutostart,
  inspectCandidateAutostart,
  inspectPreviousAutostart,
  checkWorker,
  expectedVersion,
  previousServiceRuntime,
  restoreWait,
  restoreMaximumAttempts,
  providerStopped,
  serviceStarted,
  candidateServiceRequired,
  candidateDefinitionRequired,
}) {
  if (serviceStarted || (!candidateServiceRequired && !providerStopped)) {
    return { candidateServiceStarted: false };
  }
  if (candidateDefinitionRequired) {
    const installed = await installAutostart();
    if (installed?.ok !== true) {
      throw new Error(`compatible candidate autostart could not be installed (${installed?.provider || "unknown"})`);
    }
  }
  const restored = candidateServiceRequired
    ? await startRecoveryAutostart()
    : await restorePreviousAutostart();
  const qualifier = candidateServiceRequired ? "compatible candidate" : "previous";
  requireActiveServiceStart(restored, `${qualifier} autostart service recovery`);
  if (candidateServiceRequired) {
    const convergence = await waitForActivatedRuntime({
      inspectDaemon: inspectCandidateAutostart,
      checkWorker,
      expectedVersion,
      maximumAttempts: restoreMaximumAttempts,
      wait: restoreWait,
    });
    if (!convergence.ok) {
      throw new Error(`compatible candidate autostart recovery did not converge (${convergence.reason})`);
    }
    return { candidateServiceStarted: true, convergence, serviceStart: restored };
  }
  if (!previousServiceRuntime || typeof inspectPreviousAutostart !== "function") {
    throw new Error("previous autostart service recovery lacks verified runtime identity evidence");
  }
  const convergence = await waitForRestoredServiceRuntime({
    inspectDaemon: () => inspectPreviousAutostart(previousServiceRuntime),
    expectedVersion: previousServiceRuntime.version,
    maximumAttempts: restoreMaximumAttempts,
    wait: restoreWait,
  });
  if (!convergence.ok) {
    throw new Error(`previous autostart service recovery did not converge (${convergence.reason})`);
  }
  return { candidateServiceStarted: false, convergence };
}

function validateActivationOwnership(value) {
  const daemon = value?.daemon || {};
  const provider = value?.provider || {};
  if (typeof provider.active !== "boolean") {
    throw new Error(`the machine autostart state could not be verified before activation (${provider.provider || "unknown"})`);
  }
  if (daemon.alive === true) {
    if (daemon.mode === "foreground" || daemon.identity_reason === "foreground_daemon") {
      throw new Error(`a foreground daemon is active (pid ${daemon.pid || "unknown"}); stop it explicitly before activation`);
    }
    if (daemon.verified_service_daemon !== true || daemon.mode !== "service") {
      throw new Error(`the existing workspace daemon identity could not be verified before activation (${daemon.identity_reason || "unknown"})`);
    }
  }
  const previousServiceRuntimeActive = daemon.alive === true
    && daemon.verified_service_daemon === true
    && daemon.mode === "service";
  if (provider.active === true && !previousServiceRuntimeActive) {
    throw new Error("refusing to stop the active machine service because the selected workspace does not own its verified daemon");
  }
  let previousServiceRuntime = null;
  if (previousServiceRuntimeActive) {
    const evidence = value?.previousRuntime || {};
    if (typeof evidence.version !== "string" || !evidence.version
        || typeof evidence.entryScript !== "string" || !evidence.entryScript) {
      throw new Error("the previous service daemon identity evidence is incomplete before activation");
    }
    previousServiceRuntime = { version: evidence.version, entryScript: evidence.entryScript };
  }
  return { previousServiceRuntimeActive, previousServiceRuntime };
}

function validateProviderStop(result) {
  if (result?.ok !== true) {
    throw new Error(`the existing autostart service could not be stopped before activation (${result?.provider || "unknown"})`);
  }
  if (typeof result.active_before !== "boolean" || result.active !== false || typeof result.restore_required !== "boolean") {
    throw new Error(`the existing autostart stop state could not be verified before activation (${result?.provider || "unknown"})`);
  }
  return result.restore_required;
}

function requireActiveServiceStart(result, operation, code = "") {
  if (result?.ok !== true || result.active !== true) {
    const message = `${operation} did not reach an active persistent service (${result?.provider || "unknown"})`;
    if (code) throw activationOperationalError(message, code);
    throw new Error(message);
  }
}

const RECOVERABLE_POST_READY_CODES = new Set([
  "relay_authentication_failed",
  "autostart_install_failed",
  "autostart_start_failed",
]);

function activationOperationalError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function recoverablePostReadySettlement(error) {
  return RECOVERABLE_POST_READY_CODES.has(String(error?.code || ""));
}

function activationRecoveryDetail(error) {
  return activationErrorMessage(error).replace(/[\r\n\t]+/g, " ").slice(0, 600);
}

function activationFailureWithRecovery(error) {
  const message = activationErrorMessage(error);
  const recoveredMessage = `${message}; a compatible candidate service was installed, started, and verified ready for automatic recovery`;
  const recovered = error instanceof AggregateError
    ? new AggregateError(error.errors, recoveredMessage, { cause: error })
    : error instanceof TypeError
      ? new TypeError(recoveredMessage, { cause: error })
      : error instanceof RangeError
        ? new RangeError(recoveredMessage, { cause: error })
        : new Error(recoveredMessage, { cause: error });
  if (error?.code) recovered.code = error.code;
  recovered.activationRecovery = "candidate_service_started";
  return recovered;
}

function activationCleanupFailure(error, cleanupErrors) {
  const details = cleanupErrors.slice(0, 4).map(activationErrorMessage).join("; ");
  const aggregate = new AggregateError(
    [error, ...cleanupErrors],
    `persistent runtime activation failed: ${activationErrorMessage(error)}; local cleanup was incomplete: ${details}`,
  );
  aggregate.cleanupIncomplete = true;
  if (error?.code) aggregate.code = error.code;
  return aggregate;
}

function activationErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "activation failed");
}

function activationRecoveryReason(error) {
  const code = String(error?.code || "activation_failure");
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "activation_failure";
}

export async function waitForRestoredServiceRuntime({
  inspectDaemon, expectedVersion, maximumAttempts = 240, wait = defaultWait,
} = {}) {
  if (typeof inspectDaemon !== "function") throw new TypeError("previous runtime recovery requires a daemon inspector");
  const attempts = boundedAttempts(maximumAttempts);
  let daemon = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    daemon = await inspectDaemon();
    if (daemon?.alive && daemon?.verified_service_daemon
        && daemon?.mode === "service" && daemon?.version === expectedVersion) {
      return { ok: true, attempts: attempt, daemon };
    }
    if (attempt < attempts) await wait(attempt);
  }
  const reason = !daemon?.alive ? "daemon_not_running"
    : daemon?.verified_service_daemon !== true ? `daemon_identity_${daemon?.identity_reason || "unverified"}`
      : daemon?.mode !== "service" ? `daemon_mode_${daemon?.mode || "unknown"}`
        : `daemon_version_${daemon?.version || "unknown"}`;
  return { ok: false, attempts, daemon, reason };
}

export async function waitForActivatedRuntime({
  inspectDaemon,
  checkWorker,
  expectedVersion,
  maximumAttempts = 240,
  wait = defaultWait,
} = {}) {
  if (typeof inspectDaemon !== "function" || typeof checkWorker !== "function") {
    throw new TypeError("runtime activation requires daemon and Worker inspectors");
  }
  const attempts = boundedAttempts(maximumAttempts);
  let daemon = null;
  let worker = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    daemon = await inspectDaemon();
    if (daemon?.alive && daemon?.verified_service_daemon
        && daemon?.startup_readiness_verified === true
        && daemon?.version === expectedVersion) {
      worker = await checkWorker();
      if (worker?.ok && worker?.version === expectedVersion) {
        return { ok: true, attempts: attempt, daemon, worker };
      }
    }
    if (attempt < attempts) await wait(attempt);
  }
  const reasons = [];
  if (!daemon?.alive) reasons.push("daemon_not_running");
  else if (!daemon?.verified_service_daemon) reasons.push(`daemon_identity_${daemon?.identity_reason || "unverified"}`);
  else if (daemon?.startup_readiness_verified !== true) reasons.push("daemon_startup_readiness_unverified");
  else if (daemon?.version !== expectedVersion) reasons.push(`daemon_version_${daemon?.version || "unknown"}`);
  if (!worker?.ok) reasons.push(`worker_${worker?.error || "not_ready"}`);
  else if (worker?.version !== expectedVersion) reasons.push(`worker_version_${worker?.version || "unknown"}`);
  return { ok: false, attempts, daemon, worker, reason: reasons.join(",") || "activation_not_converged" };
}

function requiredExpectedVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z.+-]{1,128}$/.test(value)) {
    throw new TypeError("runtime activation expectedVersion must be a bounded package version string");
  }
  return value;
}

function optionalFunction(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "function") throw new TypeError(`runtime activation ${name} must be a function`);
  return value;
}

function requireReleasableLock(lock, name) {
  if (!lock || typeof lock.release !== "function") {
    throw new TypeError(`runtime activation ${name} lock must expose release`);
  }
}

function boundedAttempts(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1200) {
    throw new Error("runtime activation attempts must be between 1 and 1200");
  }
  return parsed;
}

function boundedCandidateStartAttempts(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("candidate relay start attempts must be between 1 and 10");
  }
  return parsed;
}

function defaultWait(attempt) {
  const delay = Math.min(1_000, 100 + attempt * 25);
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, delay); });
}

function defaultCandidateRetryWait(attempt) {
  const delay = Math.min(15_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, delay); });
}
