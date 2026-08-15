import { activatePersistentRuntime, waitForActivatedRuntime } from "../src/local/runtime-activation.mjs";
import { BridgeError } from "../src/local/errors.mjs";

await testValidationAndPreflightFailures();
await testConvergenceWait();
await testSuccessfulHandoff();
await testAuthenticationFailureRedeploysOnce();
await testAuthenticationRecoveryIsBounded();
await testCompatibleCandidateRecoveryFailureIsObservable();
await testCandidateStartCleanupFailureAggregation();
await testForegroundRefusal();
await testUnownedActiveServiceRefusal();
await testInstallFailureCleanup();
await testCandidateFatalDuringInstall();
await testUnexpectedPostReadyFailureRemainsFatal();
await testPostDeploymentPreparationFailureUsesCandidateService();
await testRemotePreparationFailureRestoresService();
await testOrphanServiceRuntimeRestoresService();
await testRestorationFailureAggregation();
await testServiceFailureAfterVerifiedCandidate();
await testServiceLockReleaseFailureAggregation();
await testCleanupFailureAggregation();

console.log("persistent runtime activation convergence and handoff test ok");

async function testValidationAndPreflightFailures() {
  await expectReject(() => activatePersistentRuntime({}), "requires acquireStartupLock");
  await expectReject(() => waitForActivatedRuntime({ inspectDaemon: async () => ({}) }), "requires daemon and Worker inspectors");

  const serviceLockEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => lock("startup", serviceLockEvents),
    acquireServiceLock: async () => ({ acquired: false, owner: { pid: 8123 }, release() {} }),
    inspectActivationOwnership: unexpected, stopAutostart: unexpected, acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
  }), "another machine-service operation is active (pid 8123)");
  assert(serviceLockEvents.length === 0,
    "machine-service lock contention touched the workspace startup lock or provider state");

  const startupFailureEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireServiceLock: async () => lock("service", startupFailureEvents),
    acquireStartupLock: async () => { throw new Error("startup lock unavailable"); },
    inspectActivationOwnership: unexpected, stopAutostart: unexpected, acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
  }), "startup lock unavailable");
  assert(startupFailureEvents.join(",") === "service:release",
    "startup lock failure leaked the machine-service transaction lock");

  const stopEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => lock("startup", stopEvents),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: false, active: true, active_before: true, restore_required: false, provider: "test" }),
    acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "could not be stopped before activation");
  assert(stopEvents.join(",") === "startup:release", "service-stop refusal did not release the startup lock");

  const ambiguousStopEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => lock("startup", ambiguousStopEvents),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: true, active: false, provider: "test" }),
    acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "stop state could not be verified");
  assert(ambiguousStopEvents.join(",") === "startup:release",
    "ambiguous service-stop result entered activation or leaked the startup lock");

  const daemonEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => lock("startup", daemonEvents),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
    acquireDaemonLock: async () => ({ acquired: false, owner: { mode: "service" } }),
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "existing daemon could not be taken over");
  assert(daemonEvents.join(",") === "startup:release", "background-daemon refusal did not release the startup lock");

  const malformedDaemonEvents = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => lock("startup", malformedDaemonEvents),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
    acquireDaemonLock: async () => ({ acquired: true }),
    prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
  }), "daemon lock must expose release");
  assert(malformedDaemonEvents.join(",") === "startup:release",
    "malformed daemon lock entered remote preparation or leaked the startup lock");

  for (const [field, value, expected] of [
    ["maximumAttempts", 0, "attempts must be between 1 and 1200"],
    ["candidateRetryWait", true, "candidateRetryWait must be a function"],
    ["wait", "later", "wait must be a function"],
    ["repairRemoteState", 42, "repairRemoteState must be a function"],
    ["startRecoveryAutostart", "later", "startRecoveryAutostart must be a function"],
    ["inspectCandidateAutostart", true, "inspectCandidateAutostart must be a function"],
  ]) {
    await expectReject(() => activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      [field]: value,
      acquireStartupLock: unexpected, stopAutostart: unexpected, acquireDaemonLock: unexpected,
      acquireServiceLock: async () => silentServiceLock(),
      prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
      startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
    }), expected);
  }
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "bad version\n",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: unexpected, stopAutostart: unexpected, acquireDaemonLock: unexpected,
    acquireServiceLock: async () => silentServiceLock(),
    prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
  }), "expectedVersion must be a bounded package version string");
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => ({}),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: unexpected, acquireDaemonLock: unexpected, prepareRemoteState: unexpected,
    createRuntime: unexpected, installAutostart: unexpected, startAutostart: unexpected,
    inspectDaemon: unexpected, checkWorker: unexpected,
  }), "startup lock must expose release");

  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    candidateStartAttempts: 0,
    acquireStartupLock: unexpected,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: unexpected,
    acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "candidate relay start attempts must be between 1 and 10");
}

async function testConvergenceWait() {
  let daemonChecks = 0;
  let workerChecks = 0;
  const ready = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    maximumAttempts: 5,
    wait: async () => {},
    inspectDaemon: async () => {
      daemonChecks += 1;
      return daemonChecks < 3
        ? { alive: true, verified_service_daemon: true, startup_readiness_verified: true, version: "2.0.0" }
        : { alive: true, verified_service_daemon: true, startup_readiness_verified: true, version: "3.0.0-beta.1" };
    },
    checkWorker: async () => {
      workerChecks += 1;
      return { ok: true, version: "3.0.0-beta.1" };
    },
  });
  assert(ready.ok && ready.attempts === 3 && workerChecks === 1, "activation did not wait for the exact daemon version before checking Worker convergence");
  const failed = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    maximumAttempts: 2,
    wait: async () => {},
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: false, identity_reason: "foreground_daemon", version: "3.0.0-beta.1" }),
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(!failed.ok && failed.reason.includes("foreground_daemon"), "activation failure omitted daemon identity mismatch");
  const unready = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1", maximumAttempts: 1,
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: true, startup_readiness_verified: false, version: "3.0.0-beta.1" }),
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(!unready.ok && unready.reason.includes("daemon_startup_readiness_unverified"),
    "activation accepted a background daemon before relay readiness was published");
  await expectReject(() => waitForActivatedRuntime({ maximumAttempts: 0, inspectDaemon: async () => ({}), checkWorker: async () => ({}) }), "between 1 and 1200");

  let defaultWaitChecks = 0;
  const defaultWaitReady = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    maximumAttempts: 2,
    inspectDaemon: async () => {
      defaultWaitChecks += 1;
      return { alive: true, verified_service_daemon: true, startup_readiness_verified: true, version: defaultWaitChecks === 1 ? "2.0.0" : "3.0.0-beta.1" };
    },
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(defaultWaitReady.ok && defaultWaitReady.attempts === 2, "activation default convergence wait did not retry");
}

async function testSuccessfulHandoff() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = {
    async start() { events.push("runtime:start"); },
    stop() { events.push("runtime:stop"); },
  };
  const result = await activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    maximumAttempts: 1,
    wait: async () => {},
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => { events.push("service:stop"); return { ok: true, active_before: false, active: false, restore_required: false, provider: "test" }; },
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => { events.push("relay:prepare"); return { session: true }; },
    createRuntime({ daemonLock, readiness }) {
      assert(daemonLock === daemon && readiness.session === true, "candidate runtime received the wrong handoff inputs");
      events.push("runtime:create");
      return runtime;
    },
    installAutostart: async () => { events.push("service:install"); return { ok: true, active: true, provider: "test" }; },
    startAutostart: async () => { events.push("service:start"); return { ok: true, active: true, provider: "test" }; },
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: true, startup_readiness_verified: true, version: "3.0.0-beta.1", pid: 42 }),
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(result.ok && result.candidateRelayVerified, "successful activation did not report candidate relay verification");
  assert(JSON.stringify(events) === JSON.stringify([
    "service:stop",
    "relay:prepare",
    "runtime:create",
    "runtime:start",
    "service:install",
    "runtime:stop",
    "daemon:release",
    "startup:release",
    "service:start",
  ]), `activation ordering drifted: ${events.join(",")}`);
}

async function testAuthenticationFailureRedeploysOnce() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let runtimeNumber = 0;
  const result = await activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    maximumAttempts: 1,
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => { events.push("service:stop"); return { ok: true, active_before: false, active: false, restore_required: false, provider: "test" }; },
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => { events.push("relay:prepare"); return { generation: 1 }; },
    repairRemoteState: async ({ attempt, error, readiness }) => {
      assert(attempt === 1 && error.code === "relay_authentication_failed" && readiness.generation === 1,
        "candidate authentication recovery received the wrong failure context");
      events.push("relay:repair");
      return { generation: 2 };
    },
    createRuntime({ readiness }) {
      runtimeNumber += 1;
      const number = runtimeNumber;
      events.push(`runtime:create:${number}:${readiness.generation}`);
      return {
        async start() {
          events.push(`runtime:start:${number}`);
          if (number === 1) {
            const error = new Error("unauthorized");
            error.code = "relay_authentication_failed";
            throw error;
          }
        },
        stop() { events.push(`runtime:stop:${number}`); },
      };
    },
    installAutostart: async () => { events.push("service:install"); return { ok: true, active: true, provider: "test" }; },
    startAutostart: async () => { events.push("service:start"); return { ok: true, active: true, provider: "test" }; },
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: true, startup_readiness_verified: true, version: "3.0.0-beta.1", pid: 43 }),
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(result.ok && result.candidateRecoveryRedeployed === true,
    "successful authentication repair was not reported");
  assert(events.filter((value) => value === "relay:repair").length === 1,
    "candidate authentication failure repeated the remote repair");
  assert(JSON.stringify(events) === JSON.stringify([
    "service:stop",
    "relay:prepare",
    "runtime:create:1:1",
    "runtime:start:1",
    "runtime:stop:1",
    "relay:repair",
    "runtime:create:2:2",
    "runtime:start:2",
    "service:install",
    "runtime:stop:2",
    "daemon:release",
    "startup:release",
    "service:start",
  ]), `candidate authentication recovery ordering drifted: ${events.join(",")}`);
}

async function testAuthenticationRecoveryIsBounded() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let runtimeNumber = 0;
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      candidateStartAttempts: 3,
      candidateRetryWait: async (attempt) => { events.push(`retry:${attempt}`); },
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => {
        events.push("service:stop");
        return { ok: true, active_before: false, active: false, restore_required: false, provider: "test" };
      },
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => { events.push("relay:prepare"); return { generation: 1 }; },
      repairRemoteState: async () => { events.push("relay:repair"); return { generation: 2 }; },
      createRuntime() {
        runtimeNumber += 1;
        const number = runtimeNumber;
        return {
          async start() {
            events.push(`runtime:start:${number}`);
            const error = new Error("unauthorized");
            error.code = "relay_authentication_failed";
            throw error;
          },
          stop() { events.push(`runtime:stop:${number}`); },
        };
      },
      installAutostart: async () => { events.push("service:install-candidate"); return { ok: true, active: true, provider: "test" }; },
      startAutostart: unexpected,
      startRecoveryAutostart: async () => { events.push("service:start-candidate"); return { ok: true, active: true, provider: "test" }; },
      inspectCandidateAutostart: async () => readyCandidateDaemon(),
      inspectDaemon: unexpected,
      checkWorker: async () => readyCandidateWorker(),
    });
  } catch (error) { caught = error; }
  assert(caught?.code === "relay_authentication_failed"
    && caught?.activationRecovery === "candidate_service_started"
    && caught.message.includes("compatible candidate service was installed, started, and verified ready"),
  "bounded authentication failure did not report forward service recovery");
  assert(events.filter((value) => value === "relay:repair").length === 1,
    "bounded authentication recovery repeated the Worker deployment");
  assert(events.filter((value) => value.startsWith("runtime:start:")).length === 3,
    "candidate authentication recovery did not honor the bounded attempt count");
  assert(events.filter((value) => value.startsWith("retry:")).length === 2,
    "candidate authentication recovery used the wrong retry count");
  assert(events.slice(-4).join(",") === "daemon:release,startup:release,service:install-candidate,service:start-candidate",
    `candidate forward recovery ordering drifted: ${events.join(",")}`);
}

async function testCompatibleCandidateRecoveryFailureIsObservable() {
  const events = [];
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      candidateStartAttempts: 1,
      maximumAttempts: 2,
      wait: async (attempt) => { events.push(`recovery:wait:${attempt}`); },
      acquireStartupLock: async () => lock("startup", events),
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
      acquireDaemonLock: async () => lock("daemon", events),
      prepareRemoteState: async () => ({}),
      createRuntime: () => ({
        async start() {
          const error = new Error("cryptographic daemon identity rejected");
          error.code = "relay_authentication_failed";
          throw error;
        },
        stop() { events.push("runtime:stop"); },
      }),
      installAutostart: async () => { events.push("service:install-candidate"); return { ok: true, active: true, provider: "test" }; },
      startAutostart: unexpected,
      startRecoveryAutostart: async () => { events.push("service:start-candidate"); return { ok: true, active: true, provider: "test" }; },
      inspectCandidateAutostart: async () => ({ alive: false, verified_service_daemon: false }),
      inspectDaemon: unexpected,
      checkWorker: async () => readyCandidateWorker(),
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError
    && caught.cleanupIncomplete === true
    && caught.code === "relay_authentication_failed"
    && caught.errors?.[0]?.message.includes("cryptographic daemon identity rejected")
    && caught.errors?.[1]?.message.includes("compatible candidate autostart recovery did not converge")
    && caught.errors?.[1]?.message.includes("daemon_not_running")
    && caught.message.includes("cryptographic daemon identity rejected")
    && caught.message.includes("daemon_not_running"),
  "failed compatible-candidate recovery did not preserve the primary authentication error and exact recovery state");
  assert(events.includes("service:start-candidate") && events.includes("recovery:wait:1"),
    "failed compatible-candidate recovery did not leave the provider retry path active while checking readiness");
}

async function testCandidateStartCleanupFailureAggregation() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: previousServiceActivationOwnership,
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => ({}),
      repairRemoteState: unexpected,
      createRuntime: () => ({
        async start() {
          const error = new Error("unauthorized");
          error.code = "relay_authentication_failed";
          throw error;
        },
        stop() { throw new Error("candidate stop failed"); },
      }),
      installAutostart: unexpected,
      startAutostart: unexpected,
      inspectDaemon: unexpected,
      checkWorker: unexpected,
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError
    && caught.activationRecovery === undefined
    && caught.cleanupIncomplete === true
    && caught.errors?.length === 2
    && caught.errors[0]?.code === "relay_authentication_failed"
    && caught.errors[1]?.message.includes("candidate stop failed"),
  "candidate-start cleanup failure did not preserve both errors while suppressing unsafe service recovery");
  assert(events.join(",") === "daemon:release,startup:release",
    `candidate-start cleanup failure leaked activation locks: ${events.join(",")}`);
}

async function testForegroundRefusal() {
  const events = [];
  const startup = lock("startup", events);
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: async () => ({
      daemon: { alive: true, verified_service_daemon: false, identity_reason: "foreground_daemon", mode: "foreground", pid: 77 },
      provider: { active: true, provider: "test" },
    }),
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => lock("service", events),
    stopAutostart: unexpected,
    acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "foreground daemon is active");
  assert(events.join(",") === "startup:release,service:release",
    "foreground ownership refusal mutated the provider or leaked the startup lock");
}

async function testUnownedActiveServiceRefusal() {
  const events = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: async () => ({
      daemon: { alive: false, verified_service_daemon: false },
      provider: { active: true, provider: "test" },
    }),
    acquireStartupLock: async () => lock("startup", events),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: unexpected,
    acquireDaemonLock: unexpected,
    prepareRemoteState: unexpected, createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
  }), "selected workspace does not own");
  assert(events.join(",") === "startup:release",
    "unowned active machine service reached provider mutation");

  for (const [ownership, expected] of [
    [{ daemon: { alive: true, verified_service_daemon: false, mode: "service", identity_reason: "command_mismatch" }, provider: { active: false, provider: "test" } }, "identity could not be verified"],
    [{ daemon: { alive: false }, provider: { active: null, provider: "test" } }, "autostart state could not be verified"],
  ]) {
    const branchEvents = [];
    await expectReject(() => activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: async () => ownership,
      acquireStartupLock: async () => lock("startup", branchEvents),
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: unexpected, acquireDaemonLock: unexpected, prepareRemoteState: unexpected,
      createRuntime: unexpected, installAutostart: unexpected, startAutostart: unexpected,
      inspectDaemon: unexpected, checkWorker: unexpected,
    }), expected);
    assert(branchEvents.join(",") === "startup:release", `ownership preflight branch leaked the startup lock: ${expected}`);
  }
}

async function testInstallFailureCleanup() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = { async start() { events.push("runtime:start"); }, stop() { events.push("runtime:stop"); } };
  let installCalls = 0;
  const result = await activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => {
      installCalls += 1;
      events.push(`service:install:${installCalls}`);
      return { ok: installCalls === 2, provider: "test" };
    },
    startAutostart: unexpected,
    startRecoveryAutostart: async () => { events.push("service:start-recovery"); return { ok: true, active: true, provider: "test" }; },
    inspectCandidateAutostart: async () => readyCandidateDaemon(),
    inspectDaemon: unexpected,
    checkWorker: async () => readyCandidateWorker(),
  });
  assert(result.ok === true && result.activationRecovered === true
    && result.recoveryReason === "autostart_install_failed"
    && result.recoveryDetail.includes("autostart installation failed")
    && result.candidateRelayVerified === true,
  "verified candidate installation recovery did not settle as a successful activation");
  assert(JSON.stringify(events) === JSON.stringify([
    "runtime:start",
    "service:install:1",
    "runtime:stop",
    "daemon:release",
    "startup:release",
    "service:install:2",
    "service:start-recovery",
  ]), `install failure recovery ordering drifted: ${events.join(",")}`);
}

async function testCandidateFatalDuringInstall() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let terminalError = null;
  let installCalls = 0;
  const runtime = {
    terminalError: () => terminalError,
    async start() { events.push("runtime:start"); },
    stop() { events.push("runtime:stop"); },
  };
  const result = await activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => {
      installCalls += 1;
      events.push(`service:install:${installCalls}`);
      if (installCalls === 1) {
        terminalError = new Error("relay fatal during install at /private/tmp/operator-secret; credential=operator-secret-value");
        terminalError.code = "relay_authentication_failed";
      }
      await Promise.resolve();
      return { ok: true, active: true, provider: "test" };
    },
    startAutostart: unexpected,
    startRecoveryAutostart: async () => { events.push("service:start-recovery"); return { ok: true, active: true, provider: "test" }; },
    inspectCandidateAutostart: async () => readyCandidateDaemon(),
    inspectDaemon: unexpected,
    checkWorker: async () => readyCandidateWorker(),
  });
  assert(result.ok === true && result.activationRecovered === true
    && result.recoveryReason === "relay_authentication_failed"
    && result.recoveryDetail === "candidate relay authentication failed after readiness"
    && !JSON.stringify(result).includes("/private/tmp/operator-secret")
    && !JSON.stringify(result).includes("operator-secret-value")
    && result.candidateRelayVerified === true,
  "post-ready candidate authentication failure did not settle through privacy-safe verified service recovery");
  assert(events.includes("runtime:stop") && events.includes("daemon:release") && events.includes("startup:release")
    && installCalls === 2 && events.includes("service:install:2") && events.at(-1) === "service:start-recovery",
  "candidate fatal did not clean up, reinstall, and verify the compatible service");
}


async function testUnexpectedPostReadyFailureRemainsFatal() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = {
    terminalError: () => new TypeError("unexpected candidate invariant failure"),
    async start() { events.push("runtime:start"); },
    stop() { events.push("runtime:stop"); },
  };
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => ({}),
      createRuntime: () => runtime,
      installAutostart: async () => ({ ok: true, active: true, provider: "test" }),
      startAutostart: unexpected,
      startRecoveryAutostart: async () => ({ ok: true, active: true, provider: "test" }),
      inspectCandidateAutostart: async () => readyCandidateDaemon(),
      inspectDaemon: unexpected,
      checkWorker: async () => readyCandidateWorker(),
    });
  } catch (error) { caught = error; }
  assert(caught instanceof TypeError
    && caught.activationRecovery === "candidate_service_started"
    && caught.message.includes("unexpected candidate invariant failure")
    && caught.message.includes("verified ready"),
  "unexpected post-ready programming error was incorrectly converted into activation success");
  assert(events.includes("runtime:start") && events.includes("runtime:stop"),
    "unexpected post-ready programming error skipped candidate cleanup");
}

async function testPostDeploymentPreparationFailureUsesCandidateService() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => {
        events.push("service:stop");
        return { ok: true, active_before: true, active: false, restore_required: true, provider: "test" };
      },
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async ({ onRemotePrepared }) => {
        events.push("relay:prepared");
        onRemotePrepared();
        throw new BridgeError("authentication_failed", "unauthorized");
      },
      createRuntime: unexpected,
      installAutostart: async () => { events.push("service:install-candidate"); return { ok: true, active: true, provider: "test" }; },
      startAutostart: unexpected,
      startRecoveryAutostart: async () => { events.push("service:start-candidate"); return { ok: true, active: true, provider: "test" }; },
      inspectCandidateAutostart: async () => readyCandidateDaemon(),
      inspectDaemon: unexpected,
      checkWorker: async () => readyCandidateWorker(),
    });
  } catch (error) { caught = error; }
  assert(caught?.code === "authentication_failed"
    && caught?.activationRecovery === "candidate_service_started"
    && caught.message.includes("unauthorized"),
  "post-deployment account-admin authentication failure did not select compatible-service recovery");
  assert(JSON.stringify(events) === JSON.stringify([
    "service:stop",
    "relay:prepared",
    "daemon:release",
    "startup:release",
    "service:install-candidate",
    "service:start-candidate",
  ]), `post-deployment preparation recovery ordering drifted: ${events.join(",")}`);
}

async function testRemotePreparationFailureRestoresService() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: previousServiceActivationOwnership,
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => {
      events.push("service:stop");
      return { ok: true, active_before: true, active: false, restore_required: true, provider: "test" };
    },
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => {
      events.push("relay:prepare");
      throw new Error("worker propagation timeout");
    },
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    restorePreviousAutostart: async () => {
      events.push("service:restore");
      return { ok: true, active: true, provider: "test" };
    },
    inspectPreviousAutostart: () => ({ alive: true, verified_service_daemon: true, mode: "service", version: "2.0.0" }),
    wait: async () => {},
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "worker propagation timeout");
  assert(JSON.stringify(events) === JSON.stringify([
    "service:stop",
    "relay:prepare",
    "daemon:release",
    "startup:release",
    "service:restore",
  ]), `failed activation did not restore the previous provider after releasing locks: ${events.join(",")}`);
}

async function testOrphanServiceRuntimeRestoresService() {
  const events = [];
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: async () => ({
      daemon: { alive: true, verified_service_daemon: true, mode: "service", pid: 91 },
      provider: { active: false, provider: "test" },
      previousRuntime: { version: "2.0.0", entryScript: "/old/bin/machine-mcp.mjs" },
    }),
    acquireStartupLock: async () => lock("startup", events),
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => {
      events.push("service:already-inactive");
      return { ok: true, active_before: false, active: false, restore_required: false, provider: "test" };
    },
    acquireDaemonLock: async () => lock("daemon", events),
    prepareRemoteState: async () => { events.push("relay:prepare"); throw new Error("pre-deployment network failure"); },
    createRuntime: unexpected, installAutostart: unexpected,
    startAutostart: unexpected,
    restorePreviousAutostart: async () => { events.push("service:restore"); return { ok: true, active: true, provider: "test" }; },
    inspectPreviousAutostart: () => ({ alive: true, verified_service_daemon: true, mode: "service", version: "2.0.0" }),
    wait: async () => {},
    inspectDaemon: unexpected, checkWorker: unexpected,
  }), "pre-deployment network failure");
  assert(JSON.stringify(events) === JSON.stringify([
    "service:already-inactive", "relay:prepare", "daemon:release", "startup:release", "service:restore",
  ]), `orphan service runtime lost provider recovery intent: ${events.join(",")}`);
}

async function testRestorationFailureAggregation() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => ({ ok: true, active_before: true, active: false, restore_required: true, provider: "test" }),
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => { throw new Error("remote preparation failed"); },
      createRuntime: unexpected,
      installAutostart: unexpected,
      startAutostart: unexpected,
      restorePreviousAutostart: async () => ({ ok: false, active: false, provider: "test" }),
      inspectDaemon: unexpected,
      checkWorker: unexpected,
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError && caught.errors?.length === 2
    && caught.errors[0]?.message.includes("remote preparation failed")
    && caught.errors[1]?.message.includes("did not reach an active persistent service"),
  "activation did not preserve both the primary and provider-restoration failures");
}

async function testServiceFailureAfterVerifiedCandidate() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = { async start() { events.push("runtime:start"); }, stop() { events.push("runtime:stop"); } };
  let startCalls = 0;
  const result = await activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    inspectActivationOwnership: inactiveActivationOwnership,
    acquireStartupLock: async () => startup,
    acquireServiceLock: async () => silentServiceLock(),
    stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => ({ ok: true, active: true, provider: "test" }),
    startAutostart: async () => {
      startCalls += 1;
      events.push(`service:start:${startCalls}`);
      return { ok: true, active: false, provider: "test", reason: "completed_without_persistence" };
    },
    startRecoveryAutostart: async () => {
      events.push("service:start-recovery");
      return { ok: true, active: true, provider: "test" };
    },
    inspectCandidateAutostart: async () => readyCandidateDaemon(),
    inspectDaemon: unexpected,
    checkWorker: async () => readyCandidateWorker(),
  });
  assert(result.ok === true && result.activationRecovered === true
    && result.recoveryReason === "autostart_start_failed"
    && result.recoveryDetail === "candidate autostart start failed after readiness"
    && result.candidateRelayVerified === true,
  "verified service-handoff recovery did not settle as a successful activation");
  assert(events.indexOf("runtime:start") < events.indexOf("runtime:stop"), "candidate relay was not verified before service handoff failure");
  assert(events.filter((value) => value === "startup:release").length === 1
    && startCalls === 1 && events.filter((value) => value === "service:start-recovery").length === 1,
    "service start failure did not separate strict handoff from compatible-service recovery");
}

async function testServiceLockReleaseFailureAggregation() {
  const events = [];
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      acquireStartupLock: async () => lock("startup", events),
      acquireServiceLock: async () => ({
        acquired: true,
        release() { events.push("service:release"); throw new Error("service lock release failed"); },
      }),
      inspectActivationOwnership: inactiveActivationOwnership,
      stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
      acquireDaemonLock: async () => lock("daemon", events),
      prepareRemoteState: async () => { throw new Error("remote preparation failed"); },
      createRuntime: unexpected, installAutostart: unexpected, startAutostart: unexpected,
      inspectDaemon: unexpected, checkWorker: unexpected,
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError && caught.errors?.length === 2
    && caught.errors[0]?.message.includes("remote preparation failed")
    && caught.errors[1]?.message.includes("service lock release failed"),
  "machine-service release failure did not preserve the primary activation error");
  assert(events.join(",") === "daemon:release,startup:release,service:release",
    `machine-service release failure ordering drifted: ${events.join(",")}`);
}

async function testCleanupFailureAggregation() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = {
    acquired: true,
    release() { events.push("daemon:release"); throw new Error("daemon release failed"); },
  };
  const runtime = {
    async start() { events.push("runtime:start"); },
    stop() { events.push("runtime:stop"); throw new Error("runtime stop failed"); },
  };
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      inspectActivationOwnership: inactiveActivationOwnership,
      acquireStartupLock: async () => startup,
      acquireServiceLock: async () => silentServiceLock(),
      stopAutostart: async () => ({ ok: true, active_before: false, active: false, restore_required: false, provider: "test" }),
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => ({}),
      createRuntime: () => runtime,
      installAutostart: async () => ({ ok: false, provider: "test" }),
      startAutostart: unexpected, inspectDaemon: unexpected, checkWorker: unexpected,
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError && caught.errors?.length === 3
    && caught.message.includes("cleanup was incomplete"),
  "activation cleanup failure did not preserve the primary, runtime-stop, and lock-release errors");
  assert(events.filter((value) => value === "startup:release").length === 1, "cleanup aggregation did not release the startup lock exactly once");
}

function readyCandidateDaemon(version = "3.0.0-beta.1") {
  return {
    alive: true,
    verified_service_daemon: true,
    startup_readiness_verified: true,
    mode: "service",
    version,
  };
}

function readyCandidateWorker(version = "3.0.0-beta.1") {
  return { ok: true, version };
}

function lock(name, events) {
  let released = false;
  return {
    acquired: true,
    release() {
      if (released) throw new Error(`${name} lock released more than once`);
      released = true;
      events.push(`${name}:release`);
    },
  };
}

function silentServiceLock() {
  return { acquired: true, release() {} };
}

async function previousServiceActivationOwnership() {
  return {
    daemon: { alive: true, verified_service_daemon: true, mode: "service", pid: 81, version: "2.0.0" },
    provider: { active: true, provider: "test" },
    previousRuntime: { version: "2.0.0", entryScript: "/old/bin/machine-mcp.mjs" },
  };
}

async function inactiveActivationOwnership() {
  return { daemon: { alive: false, verified_service_daemon: false }, provider: { active: false, provider: "test" } };
}

async function unexpected() { throw new Error("unexpected dependency call"); }
async function expectReject(callback, expected) {
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
