export async function activatePersistentRuntime(options = {}) {
  const required = [
    "acquireStartupLock",
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

  const startupLock = await options.acquireStartupLock();
  let startupReleased = false;
  let daemonLock = null;
  let candidateRuntime = null;
  let candidateRelayVerified = false;
  let providerStopped = false;
  let serviceStarted = false;
  try {
    const providerStop = await options.stopAutostart();
    if (providerStop?.ok === false && providerStop?.active === true) {
      throw new Error("the existing autostart service could not be stopped before activation");
    }
    providerStopped = providerStop?.active_before === true && providerStop?.active === false;

    daemonLock = await options.acquireDaemonLock();
    if (!daemonLock?.acquired) {
      const owner = daemonLock?.owner || {};
      if (owner.mode === "foreground") {
        throw new Error(`a foreground daemon is active (pid ${owner.pid || "unknown"}); stop it explicitly before activation`);
      }
      throw new Error(`the existing daemon could not be taken over (pid ${owner.pid || "unknown"})`);
    }

    const readiness = await options.prepareRemoteState();
    candidateRuntime = options.createRuntime({ daemonLock, readiness });
    if (!candidateRuntime || typeof candidateRuntime.start !== "function" || typeof candidateRuntime.stop !== "function") {
      throw new TypeError("runtime activation candidate must expose start and stop");
    }
    await candidateRuntime.start();
    candidateRelayVerified = true;

    const installed = await options.installAutostart();
    const terminalError = candidateRuntime.terminalError?.();
    if (terminalError) throw terminalError;
    if (installed?.ok === false) {
      throw new Error(`autostart installation failed (${installed.provider || "unknown"})`);
    }

    candidateRuntime.stop();
    candidateRuntime = null;
    daemonLock.release();
    daemonLock = null;
    startupLock.release();
    startupReleased = true;

    const serviceStart = await options.startAutostart();
    if (serviceStart?.ok === false) {
      throw new Error(`autostart start failed (${serviceStart.provider || "unknown"})`);
    }
    serviceStarted = true;

    const convergence = await waitForActivatedRuntime({
      expectedVersion: options.expectedVersion,
      inspectDaemon: options.inspectDaemon,
      checkWorker: options.checkWorker,
      maximumAttempts: options.maximumAttempts,
      wait: options.wait,
    });
    if (!convergence.ok) {
      throw new Error(`persistent runtime activation did not converge (${convergence.reason})`);
    }
    return {
      ok: true,
      serviceStart,
      convergence,
      candidateRelayVerified,
    };
  } catch (error) {
    const cleanupErrors = [];
    try { candidateRuntime?.stop?.(); } catch (failure) { cleanupErrors.push(failure); }
    try { daemonLock?.release?.(); } catch (failure) { cleanupErrors.push(failure); }
    if (!startupReleased) {
      try { startupLock.release(); }
      catch (failure) { cleanupErrors.push(failure); }
    }
    try {
      await restoreStoppedProvider(options.startAutostart, { providerStopped, serviceStarted });
    } catch (failure) { cleanupErrors.push(failure); }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "persistent runtime activation failed and local cleanup was incomplete; inspect the daemon and service state before retrying",
      );
    }
    throw error;
  }
}


async function restoreStoppedProvider(startAutostart, { providerStopped, serviceStarted }) {
  if (!providerStopped || serviceStarted) return;
  const restored = await startAutostart();
  if (restored?.ok === false) {
    throw new Error(`previous autostart service could not be restored (${restored.provider || "unknown"})`);
  }
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
    if (daemon?.alive && daemon?.verified_service_daemon && daemon?.version === expectedVersion) {
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
  else if (daemon?.version !== expectedVersion) reasons.push(`daemon_version_${daemon?.version || "unknown"}`);
  if (!worker?.ok) reasons.push(`worker_${worker?.error || "not_ready"}`);
  else if (worker?.version !== expectedVersion) reasons.push(`worker_version_${worker?.version || "unknown"}`);
  return { ok: false, attempts, daemon, worker, reason: reasons.join(",") || "activation_not_converged" };
}

function boundedAttempts(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1200) {
    throw new Error("runtime activation attempts must be between 1 and 1200");
  }
  return parsed;
}

function defaultWait(attempt) {
  const delay = Math.min(1_000, 100 + attempt * 25);
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, delay); });
}
