import { activatePersistentRuntime, waitForActivatedRuntime } from "../src/local/runtime-activation.mjs";

await testConvergenceWait();
await testSuccessfulHandoff();
await testForegroundRefusal();
await testInstallFailureCleanup();
await testCandidateFatalDuringInstall();
await testRemotePreparationFailureRestoresService();
await testRestorationFailureAggregation();
await testServiceFailureAfterVerifiedCandidate();
await testCleanupFailureAggregation();

console.log("persistent runtime activation convergence and handoff test ok");

async function testConvergenceWait() {
  let daemonChecks = 0;
  let workerChecks = 0;
  const ready = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1",
    maximumAttempts: 5,
    wait: async () => {},
    inspectDaemon: async () => {
      daemonChecks += 1;
      return daemonChecks < 3
        ? { alive: true, verified_service_daemon: true, version: "2.0.0" }
        : { alive: true, verified_service_daemon: true, version: "3.0.0-beta.1" };
    },
    checkWorker: async () => {
      workerChecks += 1;
      return { ok: true, version: "3.0.0-beta.1" };
    },
  });
  assert(ready.ok && ready.attempts === 3 && workerChecks === 1, "activation did not wait for the exact daemon version before checking Worker convergence");
  const failed = await waitForActivatedRuntime({
    expectedVersion: "3.0.0-beta.1",
    maximumAttempts: 2,
    wait: async () => {},
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: false, identity_reason: "foreground_daemon", version: "3.0.0-beta.1" }),
    checkWorker: async () => ({ ok: true, version: "3.0.0-beta.1" }),
  });
  assert(!failed.ok && failed.reason.includes("foreground_daemon"), "activation failure omitted daemon identity mismatch");
  await expectReject(() => waitForActivatedRuntime({ maximumAttempts: 0, inspectDaemon: async () => ({}), checkWorker: async () => ({}) }), "between 1 and 1200");
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
    maximumAttempts: 1,
    wait: async () => {},
    acquireStartupLock: async () => startup,
    stopAutostart: async () => { events.push("service:stop"); return { ok: true, active: false }; },
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => { events.push("relay:prepare"); return { session: true }; },
    createRuntime({ daemonLock, readiness }) {
      assert(daemonLock === daemon && readiness.session === true, "candidate runtime received the wrong handoff inputs");
      events.push("runtime:create");
      return runtime;
    },
    installAutostart: async () => { events.push("service:install"); return { ok: true, provider: "test" }; },
    startAutostart: async () => { events.push("service:start"); return { ok: true, provider: "test" }; },
    inspectDaemon: async () => ({ alive: true, verified_service_daemon: true, version: "3.0.0-beta.1", pid: 42 }),
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

async function testForegroundRefusal() {
  const events = [];
  const startup = lock("startup", events);
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => startup,
    stopAutostart: async () => ({ ok: true }),
    acquireDaemonLock: async () => ({ acquired: false, owner: { mode: "foreground", pid: 77 } }),
    prepareRemoteState: unexpected,
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "foreground daemon is active");
  assert(events.filter((value) => value === "startup:release").length === 1, "foreground refusal did not release the startup lock exactly once");
}

async function testInstallFailureCleanup() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = { async start() { events.push("runtime:start"); }, stop() { events.push("runtime:stop"); } };
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => startup,
    stopAutostart: async () => ({ ok: true }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => ({ ok: false, provider: "test" }),
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "autostart installation failed");
  assert(events.includes("runtime:stop") && events.includes("daemon:release") && events.includes("startup:release"), "install failure did not clean up runtime and locks");
}

async function testCandidateFatalDuringInstall() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let terminalError = null;
  const runtime = {
    terminalError: () => terminalError,
    async start() { events.push("runtime:start"); },
    stop() { events.push("runtime:stop"); },
  };
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => startup,
    stopAutostart: async () => ({ ok: true }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => {
      events.push("service:install");
      terminalError = new Error("relay fatal during install");
      await Promise.resolve();
      return { ok: true };
    },
    startAutostart: unexpected,
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "relay fatal during install");
  assert(events.includes("runtime:stop") && events.includes("daemon:release") && events.includes("startup:release"), "candidate fatal did not clean up runtime and locks");
}

async function testRemotePreparationFailureRestoresService() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => startup,
    stopAutostart: async () => {
      events.push("service:stop");
      return { ok: true, active_before: true, active: false, provider: "test" };
    },
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => {
      events.push("relay:prepare");
      throw new Error("worker propagation timeout");
    },
    createRuntime: unexpected,
    installAutostart: unexpected,
    startAutostart: async () => {
      events.push("service:restore");
      return { ok: true, active: true, provider: "test" };
    },
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

async function testRestorationFailureAggregation() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  let caught;
  try {
    await activatePersistentRuntime({
      expectedVersion: "3.0.0-beta.1",
      acquireStartupLock: async () => startup,
      stopAutostart: async () => ({ ok: true, active_before: true, active: false, provider: "test" }),
      acquireDaemonLock: async () => daemon,
      prepareRemoteState: async () => { throw new Error("remote preparation failed"); },
      createRuntime: unexpected,
      installAutostart: unexpected,
      startAutostart: async () => ({ ok: false, active: false, provider: "test" }),
      inspectDaemon: unexpected,
      checkWorker: unexpected,
    });
  } catch (error) { caught = error; }
  assert(caught instanceof AggregateError && caught.errors?.length === 2
    && caught.errors[0]?.message.includes("remote preparation failed")
    && caught.errors[1]?.message.includes("could not be restored"),
  "activation did not preserve both the primary and provider-restoration failures");
}

async function testServiceFailureAfterVerifiedCandidate() {
  const events = [];
  const startup = lock("startup", events);
  const daemon = lock("daemon", events);
  const runtime = { async start() { events.push("runtime:start"); }, stop() { events.push("runtime:stop"); } };
  await expectReject(() => activatePersistentRuntime({
    expectedVersion: "3.0.0-beta.1",
    acquireStartupLock: async () => startup,
    stopAutostart: async () => ({ ok: true }),
    acquireDaemonLock: async () => daemon,
    prepareRemoteState: async () => ({}),
    createRuntime: () => runtime,
    installAutostart: async () => ({ ok: true }),
    startAutostart: async () => ({ ok: false, provider: "test" }),
    inspectDaemon: unexpected,
    checkWorker: unexpected,
  }), "autostart start failed");
  assert(events.indexOf("runtime:start") < events.indexOf("runtime:stop"), "candidate relay was not verified before service handoff failure");
  assert(events.filter((value) => value === "startup:release").length === 1, "service start failure released the startup lock incorrectly");
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
      acquireStartupLock: async () => startup,
      stopAutostart: async () => ({ ok: true }),
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

async function unexpected() { throw new Error("unexpected dependency call"); }
async function expectReject(callback, expected) {
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
