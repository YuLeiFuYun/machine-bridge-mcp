import { EventEmitter } from "node:events";
import { BridgeError } from "../../../src/local/errors.mjs";
import { LocalRuntime } from "../../../src/local/runtime.mjs";
import { MAX_CONCURRENT_TOOL_CALLS } from "../../../src/local/execution-limits.mjs";
import { normalizeRelayResumeCalls, normalizeRelayToolCall } from "../../../src/local/runtime-relay.mjs";
import { relayHandshakeDiagnostics } from "../../../src/local/relay-peer-diagnostics.mjs";
import relayContract from "../../../src/shared/relay-contract.json" with { type: "json" };
import { RelayCallRecovery } from "../../../src/local/relay-call-recovery.mjs";
import { RuntimeRelayShutdownDrain } from "../../../src/local/runtime-relay-shutdown-drain.mjs";
import { relayRecoveryCapacityRejection, relayRecoveryCapacitySnapshot } from "../../../src/local/relay-recovery.mjs";
import { DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS, RemoteActivityIdleSleepGuard } from "../../../src/local/remote-activity-idle-sleep-guard.mjs";
import { createDeviceIdentity, createDeviceSessionIdentity } from "../../../src/local/device-identity.mjs";
import { createUnattendedDeviceSessionFactory } from "../../../src/local/device-root-provider.mjs";
import { runtimeRelayConnectionOptions } from "../../../src/local/runtime-relay-connection-options.mjs";
import { DEVICE_SESSION_RENEW_BEFORE_MS, RuntimeDeviceSession } from "../../../src/local/runtime-device-session.mjs";
import { assert } from "./common.mjs";

export async function runRelayInfrastructureTests() {
  await testDuplicateRelayCallId();
  await testRelayRecoveryAdmissionRejectsBeforeExecution();
  testRelayReadinessProbe();
  await testRelayReadinessStateGuards();
  testRelayCancellationSuppression();
  await testRelayResumeReconciliation();
  testRelayToolTimeoutNormalization();
  testRelayHandshakeDiagnostics();
  testRemoteActivityIdleSleepGuard();
  testRuntimeDeviceSessionRotation();
  testRelayRecoveryCapacity();
  testRelayReconnectDelivery();
  await testRelayShutdownDrain();
}

function testRuntimeDeviceSessionRotation() {
  const origin = "https://relay.example.invalid";
  const server = "machine-bridge-mcp";
  const version = "test";
  const root = createDeviceIdentity();
  let now = Date.now();
  const initial = createDeviceSessionIdentity(root, origin, server, version, now);
  const renew = createUnattendedDeviceSessionFactory(root, origin, server, version);
  assert(typeof renew === "function", "portable device root did not expose unattended session renewal");
  const secureRoot = {
    provider: "macos-secure-enclave-v1", brokerProtocol: 1, brokerPath: "/tmp/machine-bridge-test-broker",
    brokerIdentifier: "com.example.machinebridge", brokerTeamIdentifier: "ABCDEFGHIJ",
    keyTag: "com.machine-bridge-mcp.device.runtime-session-test", publicJwk: root.publicJwk,
    keyId: root.keyId, createdAt: root.createdAt,
  };
  assert(createUnattendedDeviceSessionFactory(secureRoot, origin, server, version) === null,
    "Secure Enclave root incorrectly exposed unattended session renewal");

  const timers = [];
  const scheduler = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() { this.unrefCalled = true; } };
      timers.push(timer); return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  };
  let rotations = 0;
  const session = new RuntimeDeviceSession({
    identity: initial, renew, scheduler, wallNow: () => now,
    onRotated() { rotations += 1; }, logger: { event() {} },
  });
  session.start();
  const firstDue = initial.certificate.expires_at * 1000 - DEVICE_SESSION_RENEW_BEFORE_MS;
  assert(timers.length === 1 && timers[0].delay === firstDue - now && timers[0].unrefCalled === true,
    "runtime device session did not schedule one unreferenced renewal ten minutes before expiry");
  const firstKey = session.current().keyId;
  now = firstDue;
  timers[0].callback();
  assert(session.current().keyId !== firstKey && rotations === 1 && session.snapshot().session_generation === 2
    && session.snapshot().automatic_renewal === true && session.snapshot().last_rotated_at !== null,
  "scheduled runtime device-session renewal did not rotate identity and request one authentication refresh");

  let emergencyNow = Date.now();
  const emergencyInitial = createDeviceSessionIdentity(root, origin, server, version, emergencyNow);
  let emergencyRefreshes = 0;
  const emergency = new RuntimeDeviceSession({
    identity: emergencyInitial, renew, scheduler: { setTimeout() { return { unref() {} }; }, clearTimeout() {} },
    wallNow: () => emergencyNow, onRotated() { emergencyRefreshes += 1; }, logger: { event() {} },
  });
  emergency.start();
  const emergencyKey = emergency.current().keyId;
  emergencyNow = emergencyInitial.certificate.expires_at * 1000 + 1;
  assert(emergency.current().keyId !== emergencyKey && emergencyRefreshes === 0,
    "authentication-boundary renewal after a delayed timer failed or recursively interrupted its own reconnect");
  emergency.stop();

  const failureTimers = [];
  let failureNow = Date.now();
  const failureInitial = createDeviceSessionIdentity(root, origin, server, version, failureNow);
  const failed = new RuntimeDeviceSession({
    identity: failureInitial, renew() { throw new Error("synthetic renewal failure"); }, wallNow: () => failureNow,
    scheduler: {
      setTimeout(callback, delay) { const timer = { callback, delay, cleared: false, unref() {} }; failureTimers.push(timer); return timer; },
      clearTimeout(timer) { timer.cleared = true; },
    }, logger: { event() {} },
  });
  failed.start();
  const retainedKey = failed.current().keyId;
  failureNow = failureInitial.certificate.expires_at * 1000 - DEVICE_SESSION_RENEW_BEFORE_MS;
  failureTimers[0].callback();
  assert(failed.current().keyId === retainedKey && failed.snapshot().renewal_failure_count === 1
    && failureTimers.length === 2 && failureTimers[1].delay === 1_000,
  "failed runtime session renewal discarded the current identity or skipped bounded retry");
  failed.stop();
  assert(failureTimers[1].cleared === true, "runtime shutdown did not cancel pending device-session renewal retry");

  let currentIdentity = createDeviceSessionIdentity(root, origin, server, version, Date.now());
  const fakeRuntime = {
    logger: {}, relayInstanceId: "daemon_runtime_session_test", policy: {}, tools: () => [], relayOwnedCallIds: () => [],
    relay: { status: () => ({}) }, stop: async () => {}, onSuperseded() {},
  };
  const relayOptions = runtimeRelayConnectionOptions(fakeRuntime, {
    workerUrl: origin, sessionIdentity: () => currentIdentity, expectedVersion: version, onFatal() {}, onMessage() {},
  });
  const firstHeaders = relayOptions.websocket.connectionHeaders();
  const nextIdentity = createDeviceSessionIdentity(root, origin, server, version, Date.now() + 1_000);
  currentIdentity = nextIdentity;
  const secondHeaders = relayOptions.websocket.connectionHeaders();
  assert(firstHeaders["X-Bridge-Device-Key"] !== secondHeaders["X-Bridge-Device-Key"]
    && relayOptions.http.deviceIdentityProvider().keyId === nextIdentity.keyId,
  "WebSocket and HTTPS fallback did not share the current runtime device-session provider");
}


function testRemoteActivityIdleSleepGuard() {
  assert(DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS === 30 * 60_000,
    "remote activity idle-sleep guard lost its bounded thirty-minute default grace");

  const timers = [];
  const spawned = [];
  const fakeChild = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.unref = () => { child.unrefCalled = true; };
    child.kill = (signal) => { child.killed = true; child.killSignal = signal; return true; };
    return child;
  };
  const defaultTimers = [];
  const defaultChild = fakeChild();
  let defaultNow = Date.UTC(2026, 7, 25, 0, 0, 0);
  const defaultGuard = new RemoteActivityIdleSleepGuard({
    platform: "darwin",
    daemonPid: 4242,
    spawnProcess() { return defaultChild; },
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() { this.unrefCalled = true; } };
      defaultTimers.push(timer);
      return timer;
    },
    clearTimer() {},
    wallNow: () => defaultNow,
    logger: { event() {} },
  });
  assert(defaultGuard.beginActivity() === true && defaultGuard.endActivity() === true
    && defaultTimers.length === 1 && defaultTimers[0].delay === 30 * 60_000
    && defaultTimers[0].unrefCalled === true && defaultGuard.snapshot().grace_ms === 30 * 60_000
    && defaultGuard.snapshot().grace_release_due_at === "2026-08-25T00:30:00.000Z"
    && defaultGuard.snapshot().last_activity_started_at === "2026-08-25T00:00:00.000Z"
    && defaultGuard.snapshot().last_activity_ended_at === "2026-08-25T00:00:00.000Z",
  "default remote inactivity lease did not retain the macOS assertion for thirty minutes after settlement");
  defaultNow += 30 * 60_000;
  defaultTimers[0].callback();
  assert(defaultChild.killed === true && defaultGuard.snapshot().active === false
    && defaultGuard.snapshot().last_release_at === "2026-08-25T00:30:00.000Z"
    && defaultGuard.snapshot().last_release_reason === "inactivity_grace_expired",
    "default remote inactivity lease did not release after its full thirty-minute window");

  const guard = new RemoteActivityIdleSleepGuard({
    platform: "darwin",
    daemonPid: 4242,
    graceMs: 5_000,
    spawnProcess(executable, args, options) {
      const child = fakeChild();
      spawned.push({ executable, args, options, child });
      return child;
    },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    logger: { event() {} },
  });
  assert(guard.beginActivity() === true && spawned.length === 1 && timers.length === 0,
    "first remote activity did not establish a handler-lifetime idle-sleep guard");
  assert(spawned[0].executable === "/usr/bin/caffeinate"
    && JSON.stringify(spawned[0].args) === JSON.stringify(["-i", "-s", "-w", "4242"])
    && guard.snapshot().requests_idle_sleep_prevention === true
    && guard.snapshot().requests_system_sleep_prevention_on_ac === true,
  "idle-sleep guard did not bind caffeinate to daemon lifetime with AC system-sleep prevention");
  assert(spawned[0].options.stdio === "ignore" && spawned[0].options.shell === false && spawned[0].child.unrefCalled === true,
    "idle-sleep guard retained unnecessary child I/O/event-loop ownership or regained shell interpretation");
  assert(guard.beginActivity() === true && spawned.length === 1 && timers.length === 0,
    "concurrent remote activity spawned a duplicate guard or started inactivity grace before settlement");
  assert(guard.endActivity() === true && timers.length === 0,
    "settling one of multiple remote activities started inactivity grace too early");
  assert(guard.endActivity() === true && timers.length === 1 && timers[0].delay === 5_000 && timers[0].unrefCalled === true,
    "last remote activity settlement did not start one unreferenced inactivity grace timer");
  assert(guard.endActivity() === true && timers.length === 1 && timers[0].cleared === false,
    "surplus activity settlement extended or replaced an already-running inactivity grace");
  assert(guard.beginActivity() === true && timers[0].cleared === true && spawned.length === 1,
    "new activity failed to cancel the inactivity grace or spawned a duplicate caffeinate child");
  timers[0].callback();
  assert(spawned[0].child.killed === false,
    "stale inactivity timer released the guard while a newer activity was running");
  assert(guard.endActivity() === true && timers.length === 2,
    "newly settled activity did not restart the full inactivity grace");
  timers[1].callback();
  assert(spawned[0].child.killed === true && spawned[0].child.killSignal === "SIGTERM" && guard.snapshot().active === false,
    "idle-sleep guard did not release after the last activity plus inactivity grace");

  const acContinuousTimers = [];
  const acContinuousSpawned = [];
  const acContinuous = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000, mode: "ac-continuous",
    spawnProcess(executable, args, options) {
      const child = fakeChild(); acContinuousSpawned.push({ executable, args, options, child }); return child;
    },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() { this.unrefCalled = true; } };
      acContinuousTimers.push(timer); return timer;
    },
    clearTimer(timer) { timer.cleared = true; }, logger: { event() {} },
  });
  assert(acContinuous.start() === true && acContinuousSpawned.length === 1
    && JSON.stringify(acContinuousSpawned[0].args) === JSON.stringify(["-s", "-w", "4242"])
    && acContinuous.snapshot().mode === "ac-continuous"
    && acContinuous.snapshot().requests_idle_sleep_prevention === false
    && acContinuous.snapshot().requests_system_sleep_prevention_on_ac === true,
  "AC-continuous mode did not establish an AC-only daemon-lifetime assertion");
  assert(acContinuous.beginActivity() === true && acContinuousSpawned.length === 2
    && JSON.stringify(acContinuousSpawned[1].args) === JSON.stringify(["-i", "-s", "-w", "4242"]),
  "AC-continuous mode did not add the normal remote-activity assertion");
  assert(acContinuous.endActivity() === true && acContinuousTimers.length === 1 && acContinuousTimers[0].delay === 5_000,
    "AC-continuous remote activity did not retain its normal inactivity grace");
  acContinuousTimers[0].callback();
  assert(acContinuousSpawned[1].child.killed === true && acContinuousSpawned[0].child.killed === false
    && acContinuous.snapshot().active === true && acContinuous.snapshot().requests_idle_sleep_prevention === false,
  "AC-continuous grace expiry released the daemon-lifetime AC assertion or retained the activity assertion");
  acContinuous.stop();
  assert(acContinuousSpawned[0].child.killed === true && acContinuous.snapshot().active === false,
    "AC-continuous stop did not release the daemon-lifetime assertion");

  const continuousTimers = [];
  const continuousSpawned = [];
  const continuous = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000, mode: "continuous",
    spawnProcess(executable, args, options) {
      const child = fakeChild(); continuousSpawned.push({ executable, args, options, child }); return child;
    },
    setTimer(callback, delay) { const timer = { callback, delay, unref() {} }; continuousTimers.push(timer); return timer; },
    clearTimer() {}, logger: { event() {} },
  });
  assert(continuous.start() === true && continuousSpawned.length === 1
    && JSON.stringify(continuousSpawned[0].args) === JSON.stringify(["-i", "-s", "-w", "4242"])
    && continuous.snapshot().mode === "continuous"
    && continuous.snapshot().requests_idle_sleep_prevention === true,
  "continuous mode did not establish a daemon-lifetime idle/system sleep assertion");
  assert(continuous.beginActivity() === true && continuousSpawned.length === 1
    && continuous.endActivity() === true && continuousTimers.length === 0 && continuous.snapshot().active === true,
  "continuous mode spawned a duplicate activity assertion or armed inactivity grace");
  continuous.stop();
  assert(continuousSpawned[0].child.killed === true && continuous.snapshot().active === false,
    "continuous stop did not release the daemon-lifetime assertion");

  let unsupportedSpawned = false;
  const unsupported = new RemoteActivityIdleSleepGuard({
    platform: "linux", mode: "continuous",
    spawnProcess() { unsupportedSpawned = true; return fakeChild(); },
  });
  assert(unsupported.start() === false && unsupported.beginActivity() === false && unsupported.endActivity() === false && unsupportedSpawned === false
    && unsupported.snapshot().supported === false && unsupported.snapshot().enabled === false
    && unsupported.snapshot().requests_system_sleep_prevention_on_ac === false,
  "non-macOS runtime attempted to establish or report support for a platform-specific idle-sleep guard");

  const failureEvents = [];
  const failureRecoveryTimers = [];
  const unavailable = new RemoteActivityIdleSleepGuard({
    platform: "darwin",
    daemonPid: 4242,
    graceMs: 5_000,
    spawnProcess() { throw new Error("FORBIDDEN_DETAIL_MARKER FORBIDDEN_LOCATION_MARKER"); },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }; failureRecoveryTimers.push(timer); return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    logger: { event(level, name, fields, message) { failureEvents.push({ level, name, fields, message }); } },
  });
  const firstUnavailableBegin = unavailable.beginActivity();
  const repeatedUnavailableBegin = unavailable.beginActivity();
  const firstUnavailableEnd = unavailable.endActivity();
  const repeatedUnavailableEnd = unavailable.endActivity();
  assert(firstUnavailableBegin === false && repeatedUnavailableBegin === false
    && firstUnavailableEnd === false && repeatedUnavailableEnd === false
    && failureRecoveryTimers.length === 1 && failureRecoveryTimers[0].delay === 1_000,
  "failed idle-sleep process setup did not coalesce one bounded recovery timer or escaped as a tool-call failure");
  assert(failureEvents.length === 1 && failureEvents[0].level === "warn"
    && failureEvents[0].name === "runtime.idle_sleep_guard.unavailable"
    && Object.keys(failureEvents[0].fields).join(",") === "error_class"
    && !JSON.stringify(failureEvents[0]).includes("FORBIDDEN_DETAIL_MARKER")
    && !JSON.stringify(failureEvents[0]).includes("FORBIDDEN_LOCATION_MARKER"),
  "idle-sleep guard failure logging exposed sensitive process error text or failed to suppress duplicate error classes");
  unavailable.stop();
  assert(failureRecoveryTimers[0].cleared === true, "idle-sleep stop did not cancel pending setup recovery");

  const timerFailureChild = fakeChild();
  const timerFailureEvents = [];
  const timerFailure = new RemoteActivityIdleSleepGuard({
    platform: "darwin",
    daemonPid: 4242,
    graceMs: 5_000,
    spawnProcess() { return timerFailureChild; },
    setTimer() { throw new Error("FORBIDDEN_TIMER_DETAIL_MARKER"); },
    logger: { event(level, name, fields) { timerFailureEvents.push({ level, name, fields }); } },
  });
  assert(timerFailure.beginActivity() === true && timerFailure.endActivity() === false && timerFailureChild.killed === true
    && timerFailure.snapshot().active === false && timerFailureEvents.length === 1
    && !JSON.stringify(timerFailureEvents[0]).includes("FORBIDDEN_TIMER_DETAIL_MARKER"),
  "idle-sleep timer setup failure blocked fail-open cleanup or left an active power assertion");

  const recoveryTimers = [];
  const recoverySpawned = [];
  let recoveryNow = 10_000;
  const unexpectedEvents = [];
  const unexpected = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000,
    spawnProcess(executable, args, options) {
      if (recoverySpawned.length === 1 || recoverySpawned.length === 2) {
        recoverySpawned.push({ executable, args, options, child: null });
        throw new Error("FORBIDDEN_RECOVERY_DETAIL_MARKER");
      }
      const child = fakeChild(); recoverySpawned.push({ executable, args, options, child }); return child;
    },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }; recoveryTimers.push(timer); return timer;
    },
    clearTimer(timer) { timer.cleared = true; }, wallNow: () => recoveryNow,
    logger: { event(level, name, fields) { unexpectedEvents.push({ level, name, fields }); } },
  });
  assert(unexpected.beginActivity() === true, "unexpected-exit fixture failed to establish the guard");
  recoverySpawned[0].child.emit("exit", 1, null);
  assert(unexpected.snapshot().active === false && unexpected.snapshot().recovery_pending === true
    && recoveryTimers.length === 1 && recoveryTimers[0].delay === 1_000 && unexpectedEvents.length === 1
    && unexpectedEvents[0].name === "runtime.idle_sleep_guard.unavailable",
  "unexpected idle-sleep child exit did not enter bounded recovery");
  recoveryNow += 1_000; recoveryTimers[0].callback();
  assert(recoveryTimers.length === 2 && recoveryTimers[1].delay === 5_000 && unexpected.snapshot().recovery_pending === true,
    "first failed idle-sleep recovery did not advance to five-second backoff");
  recoveryNow += 5_000; recoveryTimers[1].callback();
  assert(recoveryTimers.length === 3 && recoveryTimers[2].delay === 30_000 && unexpected.snapshot().recovery_pending === true,
    "second failed idle-sleep recovery did not advance to thirty-second backoff");
  recoveryNow += 30_000; recoveryTimers[2].callback();
  assert(recoverySpawned.length === 4 && unexpected.snapshot().active === true
    && unexpected.snapshot().assertion_generation === 2 && unexpected.snapshot().restart_count === 1
    && unexpected.snapshot().recovery_pending === false && unexpected.snapshot().last_unprotected_duration_ms === 36_000
    && !JSON.stringify(unexpectedEvents).includes("FORBIDDEN_RECOVERY_DETAIL_MARKER"),
  "idle-sleep recovery did not restore protection with bounded telemetry or leaked raw recovery errors");
  unexpected.stop();

  const cancelledRecoveryTimers = [];
  const cancelledRecoverySpawned = [];
  const cancelledRecovery = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000,
    spawnProcess() { const child = fakeChild(); cancelledRecoverySpawned.push(child); return child; },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }; cancelledRecoveryTimers.push(timer); return timer;
    },
    clearTimer(timer) { timer.cleared = true; }, logger: { event() {} },
  });
  assert(cancelledRecovery.beginActivity() === true, "cancelled-recovery fixture failed to establish the guard");
  cancelledRecoverySpawned[0].emit("exit", 1, null);
  assert(cancelledRecoveryTimers.length === 1 && cancelledRecoveryTimers[0].delay === 1_000,
    "cancelled-recovery fixture did not arm first recovery delay");
  cancelledRecovery.stop();
  cancelledRecoveryTimers[0].callback();
  assert(cancelledRecoveryTimers[0].cleared === true && cancelledRecoverySpawned.length === 1
    && cancelledRecovery.snapshot().recovery_pending === false,
  "explicit stop allowed a stale recovery callback to respawn caffeinate");

  const loggingFailure = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000,
    spawnProcess() { throw new Error("FORBIDDEN_LOGGING_FAILURE_MARKER"); },
    setTimer() { throw new Error("FORBIDDEN_RECOVERY_TIMER_MARKER"); },
    logger: { event() { throw new Error("logger unavailable"); } },
  });
  assert(loggingFailure.beginActivity() === false && loggingFailure.endActivity() === false,
    "auxiliary idle-sleep logging failure escaped into tool settlement");
}


async function testDuplicateRelayCallId() {
  let violation = "";
  const callId = "call_duplicate_12345678";
  const runtime = {
    activeRelayCalls: new Map([[callId, "read_file"]]),
    handleRelayProtocolViolation(reason) { violation = reason; },
  };
  await LocalRuntime.prototype.handleRelayToolCall.call(runtime, {
    type: "tool_call",
    id: callId,
    tool: "read_file",
    arguments: { path: "README.md" },
    authorization: { account_id: "acct_testowner_12345678901234567890", account_version: 1, client_id: `mcp_client_${"c".repeat(43)}`, family_id: `mcp_family_${"c".repeat(43)}`, role: "owner" },
    timeout_ms: 5_000,
  }, { sessionId: 1 });
  assert(violation === "duplicate_tool_call_id", "duplicate relay call ID was not rejected as a protocol error");
  assert(runtime.activeRelayCalls.has(callId), "duplicate relay call removed the original call lifecycle");
}


async function testRelayRecoveryAdmissionRejectsBeforeExecution() {
  let toolCalls = 0;
  let delivered = null;
  const pendingResults = new Map();
  for (let index = 0; index < 14; index += 1) pendingResults.set(`call_old_${index}`, { id: `call_old_${index}` });
  const runtime = {
    activeRelayCalls: new Map(),
    relayCallRecovery: { retainedResultCount: () => pendingResults.size },
    suppressedRelayResults: new Map(),
    relay: {
      sendForSession(value, sessionId) { delivered = { value, sessionId }; return { ok: true, reason: "sent" }; },
    },
    executeTool: async () => { toolCalls += 1; return { unexpected: true }; },
    handleRelayProtocolViolation() { throw new Error("capacity fixture unexpectedly hit a protocol violation"); },
  };
  await LocalRuntime.prototype.handleRelayToolCall.call(runtime, {
    type: "tool_call", id: "call_capacity_runtime_12345678", tool: "read_file", arguments: { path: "README.md" },
    authorization: {
      account_id: "acct_testowner_12345678901234567890", account_version: 1,
      client_id: `mcp_client_${"c".repeat(43)}`, family_id: `mcp_family_${"c".repeat(43)}`, role: "owner",
    },
    timeout_ms: 5_000,
  }, { sessionId: 77 });
  assert(toolCalls === 0 && runtime.activeRelayCalls.size === 0
    && delivered?.sessionId === 77 && delivered?.value?.error?.code === "limit_exceeded"
    && delivered.value.error?.details?.side_effects_started === false,
  "relay recovery ownership overflow executed a tool or failed to return a session-bound retry-safe rejection");
}


function testRelayReadinessProbe() {
  const delivered = [];
  let violation = "";
  const runtime = {
    relay: {
      sendForSession(response, sessionId) { delivered.push({ response, sessionId }); return { ok: true, reason: "sent" }; },
    },
    handleRelayProtocolViolation(reason) { violation = reason; },
  };
  LocalRuntime.prototype.handleRelayProbe.call(runtime, { type: "relay_probe", id: "probe_12345678" }, { sessionId: 17 });
  assert(delivered.length === 1 && delivered[0].response.type === "relay_probe_result" && delivered[0].response.id === "probe_12345678", "relay readiness probe did not return through the result-delivery path");
  assert(delivered[0].sessionId === 17, "relay readiness probe lost the inbound session generation");
  LocalRuntime.prototype.handleRelayProbe.call(runtime, { type: "relay_probe", id: "probe_12345678" }, {});
  assert(violation === "invalid_relay_probe", "relay readiness probe accepted missing session context");
}


async function testRelayReadinessStateGuards() {
  let violation = "";
  let toolCalls = 0;
  let probes = 0;
  const runtime = {
    handleRelayControlMessage() { return false; },
    handleRelayProtocolViolation(reason) { violation = reason; },
    handleRelayProbe() { probes += 1; },
    async handleRelayToolCall() { toolCalls += 1; },
  };
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7, authenticated: true, ready: false });
  assert(violation === "tool_call_before_ready" && toolCalls === 0, "relay tool call executed before end-to-end readiness");
  violation = "";
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "relay_probe", id: "probe_12345678" }), { sessionId: 7, authenticated: true, ready: true });
  assert(violation === "unexpected_relay_probe" && probes === 0, "relay readiness probe was accepted after ready state");
  violation = "";
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7, authenticated: true, ready: true });
  assert(violation === "" && toolCalls === 1, "ready relay tool call did not reach its handler");

  // Incomplete dispatch that only forwards sessionId must consult live relay readiness
  // instead of killing the first real tool call after end-to-end verification.
  violation = "";
  toolCalls = 0;
  runtime.relay = { status: () => ({ ready: true, authenticated: true }) };
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7 });
  assert(violation === "" && toolCalls === 1, "sessionId-only ready dispatch blocked a verified tool call");
  violation = "";
  toolCalls = 0;
  runtime.relay = { status: () => ({ ready: false, authenticated: true }) };
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7 });
  assert(violation === "tool_call_before_ready" && toolCalls === 0, "sessionId-only dispatch allowed a tool call before readiness");
  violation = "";
  toolCalls = 0;
  runtime.relay = { status: () => ({ ready: true, authenticated: true }) };
  await LocalRuntime.prototype.handleMessage.call(runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7, ready: false });
  assert(violation === "tool_call_before_ready" && toolCalls === 0, "explicit ready:false must remain fail-closed even when live status is ready");

  // A valid ready tool call must reach local ownership before the async control-message path can yield.
  // The HTTPS fallback commits its transport sequence immediately after onMessage returns a Promise;
  // this ordering prevents an acknowledged-but-unowned execution gap.
  let controlChecks = 0;
  toolCalls = 0;
  runtime.handleRelayControlMessage = async () => { controlChecks += 1; return false; };
  runtime.handleRelayToolCall = async () => { toolCalls += 1; };
  runtime.relay = { status: () => ({ ready: true, authenticated: true }) };
  const ownedImmediately = LocalRuntime.prototype.handleMessage.call(
    runtime, JSON.stringify({ type: "tool_call" }), { sessionId: 7, authenticated: true, ready: true },
  );
  assert(toolCalls === 1 && controlChecks === 0,
    "ready relay tool call yielded through the async control path before local execution ownership was established");
  await ownedImmediately;
}


function testRelayCancellationSuppression() {
  const runtime = {
    activeRelayCalls: new Map([["result-window", "read_file"]]),
    suppressedRelayResults: new Map(),
    relayCallRecovery: { discard() { return false; } },
    callRegistry: { cancel() { return false; } },
    cancelCall: LocalRuntime.prototype.cancelCall,
  };
  const cancelled = LocalRuntime.prototype.cancelRelayCall.call(runtime, "result-window", "caller_cancelled");
  assert(cancelled === false, "post-execution cancellation unexpectedly reported an active registry entry");
  assert(runtime.suppressedRelayResults.get("result-window") === "caller_cancelled", "post-execution cancellation did not suppress the pending relay result");

  LocalRuntime.prototype.cancelRelayCall.call(runtime, "unknown-call", "caller_cancelled");
  assert(!runtime.suppressedRelayResults.has("unknown-call"), "unknown cancellation created an unbounded suppression entry");
}


async function testRelayResumeReconciliation() {
  assert(normalizeRelayResumeCalls({ ids: ["call_valid_12345678"] }).ok, "valid resumed-call set was rejected");
  assert(!normalizeRelayResumeCalls({ ids: ["call_duplicate_12345678", "call_duplicate_12345678"] }).ok, "duplicate resumed-call ids were accepted");
  assert(!normalizeRelayResumeCalls({ ids: ["invalid"] }).ok, "malformed resumed-call id was accepted");

  const cancelled = [];
  const events = [];
  const runtime = {
    activeRelayCalls: new Map([
      ["call_keep_12345678", "read_file"], ["call_cancel_12345678", "read_file"],
    ]),
    suppressedRelayResults: new Map(),
    callRegistry: { cancel(id) { cancelled.push(id); return true; } },
    cancelCall: LocalRuntime.prototype.cancelCall,
    cancelRelayCall: LocalRuntime.prototype.cancelRelayCall,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
  };
  runtime.relayCallRecovery = new RelayCallRecovery({
    logger: runtime.logger, activeCallIds: () => runtime.activeRelayCalls.keys(),
    isRecoverable: () => true, send: () => true,
  });
  runtime.relayCallRecovery.deliver({ id: "call_keep_12345678" });
  runtime.relayCallRecovery.deliver({ id: "call_discard_12345678" });
  const missingResumedCalls = LocalRuntime.prototype.reconcileRelayCalls.call(runtime, ["call_keep_12345678", "call_missing_12345678"]);
  assert(JSON.stringify(missingResumedCalls) === JSON.stringify(["call_missing_12345678"]),
    "reconnect reconciliation did not prove which Worker-resumed call was never received by the daemon");
  assert(cancelled.join(",") === "call_cancel_12345678", "reconnect reconciliation cancelled the wrong active call");
  assert(runtime.suppressedRelayResults.get("call_cancel_12345678") === "caller_no_longer_waiting", "orphaned active call result was not suppressed");
  assert(runtime.relayCallRecovery.hasRetainedResult("call_keep_12345678")
    && !runtime.relayCallRecovery.hasRetainedResult("call_discard_12345678"), "reconnect reconciliation retained an orphaned queued result");
  const reconciledEvent = events.find((event) => event.name === "relay.calls.reconciled");
  assert(reconciledEvent?.fields?.missing_resumed_calls === 1,
    "reconnect reconciliation did not expose the aggregate daemon-proven missing-call count");
  assert(!JSON.stringify(reconciledEvent?.fields || {}).includes("call_missing_12345678"),
    "reconnect reconciliation log fields leaked a raw resumed call ID");

  const revocationAttempts = [];
  const aggregateRevocationRuntime = {
    callRegistry: { cancelAuthority() { revocationAttempts.push("calls"); return 1; } },
    processSessionManager: { revokeAuthority() { revocationAttempts.push("sessions"); throw new Error("synthetic session revocation failure"); } },
    managedJobManager: { revokeAuthority() { revocationAttempts.push("jobs"); return 2; } },
    logger: {},
  };
  let aggregateRevocationFailure = null;
  try { await LocalRuntime.prototype.applyAuthorityRevocation.call(aggregateRevocationRuntime, { accountId: `acct_${"a".repeat(32)}`, accountVersion: 1 }); }
  catch (error) { aggregateRevocationFailure = error; }
  assert(aggregateRevocationFailure instanceof BridgeError && aggregateRevocationFailure.code === "unavailable"
    && aggregateRevocationFailure.retryable === true && aggregateRevocationFailure.cause instanceof AggregateError
    && revocationAttempts.join(",") === "calls,sessions,jobs",
  "authority revocation stopped before attempting every local execution category or lost its retry classification");

  let violation = "";
  let confirmed = 0;
  let acknowledged = "";
  const cancelledControlCalls = [];
  let revokedAuthority;
  let resumeAck;
  let revocationAck;
  let revocationInterrupt = null;
  let applicationPongs = 0;
  let recoveryPulses = 0;
  const currentControlSessions = { websocket: 17, https: 1_000_000_018 };
  const controlRuntime = {
    relayResumeStates: new Map(),
    reconcileRelayCalls(ids) { this.resumed = ids; return ["call_missing_12345678"]; },
    cancelRelayCall(id, reason) { cancelledControlCalls.push({ id, reason }); return true; },
    applyAuthorityRevocation(value) { revokedAuthority = value; },
    handleRelayProtocolViolation(reason) { violation = reason; },
    relayCallRecovery: {
      pulse() { recoveryPulses += 1; },
      acknowledge(id) { acknowledged = id; return true; },
    },
    relay: {
      isCurrentSession(context) {
        return Number(context?.sessionId) === currentControlSessions[context?.transport];
      },
      acknowledge() {},
      observeApplicationPong() { applicationPongs += 1; return true; },
      confirmReady() { confirmed += 1; return true; },
      interrupt(category) { revocationInterrupt = category; return true; },
      sendForSession(message, sessionId) {
        if (message?.type === "resume_calls_ack") resumeAck = { message, sessionId };
        else revocationAck = { message, sessionId };
        return { ok: true };
      },
    },
  };
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "pong", ts: 123 },
    { sessionId: 17, authenticated: true, ready: true, transport: "websocket" },
  );
  assert(applicationPongs === 1 && recoveryPulses === 1,
    "application pong did not separately confirm WSS transport liveness and pulse retained tool results");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "resume_calls", ids: ["call_missing_source_12345678"] },
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(violation === "invalid_resume_calls" && controlRuntime.resumed === undefined,
    "resume_calls without an originating transport reached reconciliation");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "resume_calls", ids: ["call_valid_12345678"] },
    { sessionId: 17, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(controlRuntime.relayResumeStates.has("websocket:17") && controlRuntime.resumed[0] === "call_valid_12345678",
    "valid resume_calls did not establish the reconnect contract");
  assert(resumeAck === undefined
    && JSON.stringify(controlRuntime.relayResumeStates.get("websocket:17")?.missingIds) === JSON.stringify(["call_missing_12345678"]),
  "resume reconciliation acknowledged missing ownership before local ready_ack completed");
  let failedResumeInterrupt = null;
  const failedResumeRuntime = {
    relayResumeStates: new Map(),
    reconcileRelayCalls() { return []; },
    handleRelayProtocolViolation() {},
    relay: {
      isCurrentSession(context) { return context?.transport === "websocket" && Number(context?.sessionId) === 18; },
      sendForSession() { return { ok: false }; },
      confirmReady() { return true; },
      interruptForContext(category) { failedResumeInterrupt = category; return true; },
    },
  };
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    failedResumeRuntime,
    { type: "resume_calls", ids: [] },
    { sessionId: 18, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(failedResumeRuntime.relayResumeStates.has("websocket:18") && failedResumeInterrupt === null,
    "resume reconciliation attempted acknowledgement before local readiness");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    failedResumeRuntime,
    { type: "ready_ack" },
    { sessionId: 18, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(failedResumeRuntime.relayResumeStates.has("websocket:18") && failedResumeInterrupt === "relay_transport_error",
    "failed post-readiness resume acknowledgement was treated as a completed relay reconciliation");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    {
      type: "authority_revoke", revocation_id: `revoke_${"r".repeat(43)}`,
      account_id: `acct_${"r".repeat(32)}`, account_version: 4,
    },
    { sessionId: 17, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(revokedAuthority?.accountVersion === 4
    && revocationAck?.sessionId === 17
    && revocationAck.message.revocation_id === `revoke_${"r".repeat(43)}`,
  "pre-ready authority revocation was not applied and acknowledged on its authenticated relay generation");
  revocationAck = null;
  controlRuntime.applyAuthorityRevocation = () => { throw new Error("synthetic revocation application failure"); };
  let revocationFailure = null;
  try {
    await LocalRuntime.prototype.handleRelayControlMessage.call(
      controlRuntime,
      {
        type: "authority_revoke", revocation_id: `revoke_${"f".repeat(43)}`,
        account_id: `acct_${"f".repeat(32)}`, account_version: 5,
      },
      { sessionId: 17, authenticated: true, ready: false, transport: "websocket" },
    );
  } catch (error) { revocationFailure = error; }
  assert(String(revocationFailure?.message || "").includes("synthetic revocation application failure"),
    "failed local authority revocation did not propagate its application failure");
  assert(revocationAck === null, "failed local authority revocation was acknowledged and could be removed from the durable Worker queue");
  assert(revocationInterrupt === "local_authority_revocation_retry",
    "failed local authority revocation did not interrupt the relay generation for prompt durable-queue replay");
  controlRuntime.applyAuthorityRevocation = (value) => { revokedAuthority = value; };
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "ready_ack" },
    { sessionId: 17, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(confirmed === 1 && !controlRuntime.relayResumeStates.has("websocket:17")
    && resumeAck?.sessionId === 17
    && JSON.stringify(resumeAck.message?.missing_ids) === JSON.stringify(["call_missing_12345678"]),
  "ready_ack did not complete local readiness before sending the missing-call proof");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "tool_result_ack", id: "call_valid_12345678" },
    { sessionId: 17, authenticated: true, ready: true, transport: "websocket" },
  );
  assert(acknowledged === "call_valid_12345678", "valid Worker result acknowledgement was not applied");
  currentControlSessions.websocket = 18;
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "ready_ack" },
    { sessionId: 18, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(violation === "resume_calls_required", "ready_ack without resume_calls was accepted");
  violation = "";
  currentControlSessions.websocket = 17;
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "call_cancel_12345678" },
    { sessionId: 17, authenticated: true, ready: false, transport: "websocket" },
  );
  assert(violation === "invalid_cancel_call" && cancelledControlCalls.length === 0,
    "pre-ready relay cancellation bypassed the authenticated ready-generation gate");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "not-a-call-id" },
    { sessionId: 17, authenticated: true, ready: true, transport: "websocket" },
  );
  assert(violation === "invalid_cancel_call" && cancelledControlCalls.length === 0,
    "malformed relay cancellation reached the call registry");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "call_cancel_12345678" },
    { sessionId: 17, authenticated: true, ready: true, transport: "websocket" },
  );
  assert(violation === "" && cancelledControlCalls.length === 1
    && cancelledControlCalls[0].id === "call_cancel_12345678"
    && cancelledControlCalls[0].reason === "caller_cancelled",
  "ready-generation relay cancellation did not reach the call registry exactly once");

  const interleavedAcks = [];
  const interleavedViolations = [];
  const interleavedReconciliations = [];
  const currentSessions = { websocket: 21, https: 1_000_000_022 };
  const interleavedRuntime = {
    relayResumeStates: new Map(),
    logger: { event() {} },
    reconcileRelayCalls(ids) {
      interleavedReconciliations.push([...ids]);
      return [ids[0] === "call_ws_12345678" ? "call_missing_ws_12345678" : "call_missing_http_12345678"];
    },
    handleRelayProtocolViolation(reason, context) { interleavedViolations.push({ reason, context }); },
    relayCallRecovery: { pulse() {}, acknowledge() { return true; } },
    relayShutdownDrain: { acknowledge() { return false; } },
    relay: {
      isCurrentSession(context) {
        return Number(context?.sessionId) === currentSessions[context?.transport];
      },
      confirmReady() { return true; },
      sendForSession(message, sessionId) {
        interleavedAcks.push({ message, sessionId });
        return { ok: true };
      },
      interruptForContext() { throw new Error("interleaved handshake unexpectedly interrupted a transport"); },
    },
  };
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "resume_calls", ids: ["call_ws_12345678"] },
    { sessionId: 21, authenticated: true, ready: false, transport: "websocket" });
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "resume_calls", ids: ["call_http_12345678"] },
    { sessionId: 1_000_000_022, authenticated: true, ready: false, transport: "https" });
  assert(interleavedRuntime.relayResumeStates.size === 2 && interleavedReconciliations.length === 2,
    "interleaved relay handshakes overwrote one another or skipped reconciliation");
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "ready_ack" },
    { sessionId: 21, authenticated: true, ready: false, transport: "websocket" });
  assert(interleavedAcks[0]?.sessionId === 21
    && JSON.stringify(interleavedAcks[0]?.message?.missing_ids) === JSON.stringify(["call_missing_ws_12345678"])
    && interleavedRuntime.relayResumeStates.has("https:1000000022"),
  "WebSocket ready acknowledgement consumed or answered the HTTPS resume state");
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "ready_ack" },
    { sessionId: 1_000_000_022, authenticated: true, ready: false, transport: "https" });
  assert(interleavedAcks[1]?.sessionId === 1_000_000_022
    && JSON.stringify(interleavedAcks[1]?.message?.missing_ids) === JSON.stringify(["call_missing_http_12345678"])
    && interleavedRuntime.relayResumeStates.size === 0 && interleavedViolations.length === 0,
  "HTTPS ready acknowledgement crossed relay generations or produced a false protocol violation");

  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "resume_calls", ids: ["call_ws_12345678"] },
    { sessionId: 21, authenticated: true, ready: false, transport: "websocket" });
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "resume_calls", ids: ["call_ws_12345678"] },
    { sessionId: 21, authenticated: true, ready: false, transport: "websocket" });
  assert(interleavedReconciliations.length === 3
    && interleavedViolations.at(-1)?.reason === "invalid_resume_calls"
    && interleavedViolations.at(-1)?.context?.transport === "websocket",
  "duplicate resume_calls repeated destructive reconciliation or lost its source transport");

  currentSessions.websocket = 22;
  const staleViolationCount = interleavedViolations.length;
  const staleReconcileCount = interleavedReconciliations.length;
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "ready_ack" },
    { sessionId: 21, authenticated: true, ready: false, transport: "websocket" });
  assert(interleavedViolations.length === staleViolationCount && interleavedReconciliations.length === staleReconcileCount,
    "late control message from an ended WebSocket generation reached destructive protocol handling");

  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "ready_ack" },
    { sessionId: 1_000_000_022, authenticated: true, ready: false, transport: "https" });
  assert(interleavedViolations.at(-1)?.reason === "resume_calls_required"
    && interleavedViolations.at(-1)?.context?.transport === "https",
  "current HTTPS protocol violation lost its source transport");

  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "tool_result_ack", id: "bad" },
    { sessionId: 1_000_000_022, authenticated: true, ready: true, transport: "https" });
  assert(interleavedViolations.at(-1)?.reason === "invalid_tool_result_ack"
    && interleavedViolations.at(-1)?.context?.transport === "https",
  "acknowledgement protocol violation lost its source transport at the relay-control boundary");

  currentSessions.websocket = 22;
  await LocalRuntime.prototype.handleRelayControlMessage.call(interleavedRuntime,
    { type: "daemon_draining_ack", drain_id: "bad" },
    { sessionId: 22, authenticated: true, ready: true, transport: "websocket" });
  assert(interleavedViolations.at(-1)?.reason === "invalid_daemon_draining_ack"
    && interleavedViolations.at(-1)?.context?.transport === "websocket",
  "planned-drain acknowledgement protocol violation lost its source transport");
}


function testRelayToolTimeoutNormalization() {
  const authorization = {
    account_id: "acct_testowner_12345678901234567890",
    account_version: 1,
    client_id: `mcp_client_${"c".repeat(43)}`,
    family_id: `mcp_family_${"f".repeat(43)}`,
    role: "owner",
  };
  const accepted = normalizeRelayToolCall({
    id: "call_timeout_contract_12345678",
    tool: "exec_command",
    arguments: { command: "true" },
    authorization,
    timeout_ms: relayContract.maximumOrdinaryRelayToolTimeoutMs,
  });
  assert(accepted.ok && accepted.timeoutMs === relayContract.maximumOrdinaryRelayToolTimeoutMs,
    "local relay rejected the ordinary-tool maximum call deadline");
  for (const timeout_ms of [relayContract.maximumOrdinaryRelayToolTimeoutMs + 1, -1, "5000", undefined]) {
    const rejected = normalizeRelayToolCall({
      id: "call_timeout_rejected_12345678",
      tool: "exec_command",
      arguments: { command: "true" },
      authorization,
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
    });
    assert(!rejected.ok, `local relay accepted malformed or over-limit ordinary timeout ${String(timeout_ms)}`);
  }
  const acceptedManagedJobRead = normalizeRelayToolCall({
    id: "call_read_job_timeout_12345678",
    tool: "read_job",
    arguments: { job_id: "job_fixture" },
    authorization,
    timeout_ms: relayContract.maximumRelayToolTimeoutMs,
  });
  assert(acceptedManagedJobRead.ok && acceptedManagedJobRead.timeoutMs === relayContract.maximumRelayToolTimeoutMs,
    "local relay rejected the dedicated managed-job read maximum deadline");
  const rejectedManagedJobRead = normalizeRelayToolCall({
    id: "call_read_job_overlimit_12345678",
    tool: "read_job",
    arguments: { job_id: "job_fixture" },
    authorization,
    timeout_ms: relayContract.maximumRelayToolTimeoutMs + 1,
  });
  assert(!rejectedManagedJobRead.ok, "local relay accepted a managed-job read above its dedicated deadline");
  const invalidId = normalizeRelayToolCall({
    id: "arbitrary id with spaces",
    tool: "exec_command",
    arguments: { command: "true" },
    authorization,
    timeout_ms: 5_000,
  });
  assert(!invalidId.ok && invalidId.id === "", "local relay accepted an invalid call-id shape");
  const invalidTool = normalizeRelayToolCall({
    id: "call_invalid_tool_12345678",
    tool: "Exec Command",
    arguments: { command: "true" },
    authorization,
    timeout_ms: 5_000,
  });
  assert(!invalidTool.ok, "local relay accepted an invalid tool-name shape");
  for (const malformedAuthorization of [
    { ...authorization, account_version: "1" },
    { ...authorization, role: 1 },
  ]) {
    const rejected = normalizeRelayToolCall({
      id: "call_invalid_authority_12345678", tool: "exec_command", arguments: { command: "true" },
      authorization: malformedAuthorization, timeout_ms: 5_000,
    });
    assert(!rejected.ok, "local relay coerced malformed authorization fields instead of rejecting the envelope");
  }
}


function testRelayHandshakeDiagnostics() {
  const diagnostics = relayHandshakeDiagnostics({
    network_route: "system-network-stack",
    connect_timeout_ms: 30000,
    outage_count: 4,
    outage_active: true,
    outage_started_at: "2026-08-04T11:36:20.000Z",
    outage_duration_ms: 9000,
    outage_attempts: 2,
    probe_dispatch_pending_at_start: true,
    probe_dispatch_age_ms_at_start: 23,
    probe_outstanding_at_start: false,
    probe_age_ms_at_start: 0,
    transport_confirmation_pending_at_start: true,
    application_inbound_silence_ms_at_start: 4800,
    last_close_category: "relay_heartbeat_timeout",
    last_close_code: 1006,
    last_transport_error_class: "ECONNRESET",
    last_transport_error_reason: "connection_reset",
    last_transport_error_ready: false,
    last_transport_error_authenticated: false,
    heartbeat: {
      last_probe_buffered_bytes: 4096, max_probe_buffered_bytes: 8192,
      last_probe_dispatch_ms: 17, max_probe_dispatch_ms: 44,
      last_probe_dispatch_timeout_age_ms: 0,
      last_probe_timeout_age_ms: 10000, transport_confirmation_dispatch_timeout_ms: 30000,
      last_transport_confirmation_dispatch_ms: 19, max_transport_confirmation_dispatch_ms: 47,
      last_transport_confirmation_dispatch_timeout_age_ms: 30000, transport_confirmation_timeout_ms: 15000,
      last_transport_confirmation_ms: 2300, max_transport_confirmation_ms: 4100,
      last_transport_confirmation_timeout_age_ms: 15000,
    },
    last_disconnected_at: "2026-08-04T11:36:20.000Z",
    last_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 31, tcp_connected: 44, tls_established: 87, injected: 5 },
    last_failed_connect_stage: "tls_established",
    last_failed_connect_duration_ms: 93,
    last_failed_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 30, tcp_connected: 43, tls_established: 93, injected: 6 },
    last_failed_connect_http_status: 503,
    last_ready_duration_ms: 123456,
    last_ready_inbound_silence_ms: 15000,
    https_fallback_last_takeover_ms: 1350,
    https_fallback_last_takeover_outage_number: 4,
    recent_outages: Array.from({ length: 10 }, (_, index) => ({
      outage_number: 10 - index,
      disconnected_at: `2026-08-04T11:36:${String(10 + index).padStart(2, "0")}.000Z`,
      ready_at: `2026-08-04T11:36:${String(11 + index).padStart(2, "0")}.000Z`,
      duration_ms: 1000 + index,
      https_fallback_taken_over: index === 0,
      https_fallback_takeover_ms: index === 0 ? 1350 : 0,
      attempts: 1,
      close_category: "relay_heartbeat_timeout",
      close_code: 1006,
      network_route: "system-network-stack",
      last_transport_error_class: "network_error",
      last_transport_error_reason: "connection_reset",
      previous_ready_duration_ms: 5000,
      previous_ready_inbound_silence_ms: 12000,
      last_disconnect_at: `2026-08-04T11:36:${String(10 + index).padStart(2, "0")}.500Z`,
      probe_dispatch_pending_at_start: true,
      probe_dispatch_age_ms_at_start: 17,
      probe_outstanding_at_start: false,
      probe_age_ms_at_start: 0,
      transport_confirmation_pending_at_start: false,
      application_inbound_silence_ms_at_start: 4800,
      last_connect_stage: "websocket_open",
      last_connect_duration_ms: 90,
      last_connect_milestones_ms: { dns_resolved: 10, tls_established: 50, private_stage: 7 },
      private_value: "must-not-survive",
    })),
  });
  assert(diagnostics.schema_version === 1
    && diagnostics.network_route === "system-network-stack"
    && diagnostics.connect_timeout_ms === 30000
    && diagnostics.outage_count === 4
    && diagnostics.outage_attempts === 2
    && diagnostics.probe_dispatch_pending_at_start === true
    && diagnostics.probe_dispatch_age_ms_at_start === 23
    && diagnostics.probe_outstanding_at_start === false
    && diagnostics.transport_confirmation_pending_at_start === true
    && diagnostics.application_inbound_silence_ms_at_start === 4800
    && diagnostics.last_close_category === "relay_heartbeat_timeout"
    && diagnostics.last_connect_milestones_ms.dns_resolved === 31
    && diagnostics.last_connect_milestones_ms.tls_established === 87
    && diagnostics.last_connect_milestones_ms.injected === undefined
    && diagnostics.last_failed_connect_stage === "tls_established"
    && diagnostics.last_failed_connect_duration_ms === 93
    && diagnostics.last_failed_connect_milestones_ms.tls_established === 93
    && diagnostics.last_failed_connect_milestones_ms.injected === undefined
    && diagnostics.last_failed_connect_http_status === 503
    && diagnostics.last_transport_error_reason === "connection_reset"
    && diagnostics.last_transport_error_ready === false
    && diagnostics.last_transport_error_authenticated === false
    && diagnostics.last_probe_buffered_bytes === 4096
    && diagnostics.max_probe_buffered_bytes === 8192
    && diagnostics.last_probe_dispatch_ms === 17
    && diagnostics.max_probe_dispatch_ms === 44
    && diagnostics.last_probe_timeout_age_ms === 10000
    && diagnostics.transport_confirmation_dispatch_timeout_ms === 30000
    && diagnostics.last_transport_confirmation_dispatch_ms === 19
    && diagnostics.max_transport_confirmation_dispatch_ms === 47
    && diagnostics.last_transport_confirmation_dispatch_timeout_age_ms === 30000
    && diagnostics.transport_confirmation_timeout_ms === 15000
    && diagnostics.last_transport_confirmation_ms === 2300
    && diagnostics.max_transport_confirmation_ms === 4100
    && diagnostics.last_transport_confirmation_timeout_age_ms === 15000
    && diagnostics.previous_ready_duration_ms === 123456
    && diagnostics.previous_ready_inbound_silence_ms === 15000
    && diagnostics.recent_outages.length === 8
    && diagnostics.recent_outages[0].outage_number === 10
    && diagnostics.recent_outages[7].outage_number === 3
    && diagnostics.recent_outages[0].last_disconnect_at === "2026-08-04T11:36:10.500Z"
    && diagnostics.recent_outages[0].probe_dispatch_pending_at_start === true
    && diagnostics.recent_outages[0].probe_dispatch_age_ms_at_start === 17
    && diagnostics.recent_outages[0].probe_outstanding_at_start === false
    && diagnostics.recent_outages[0].transport_confirmation_pending_at_start === false
    && diagnostics.recent_outages[0].application_inbound_silence_ms_at_start === 4800
    && diagnostics.recent_outages[0].last_connect_milestones_ms.private_stage === undefined
    && diagnostics.recent_outages[0].private_value === undefined
    && diagnostics.recent_outages[0].https_fallback_taken_over === true
    && diagnostics.recent_outages[0].https_fallback_takeover_ms === 1350
    && diagnostics.recent_outages[1].https_fallback_taken_over === false
    && diagnostics.recent_outages[1].https_fallback_takeover_ms === 0
    && diagnostics.https_fallback_last_takeover_ms === 1350
    && diagnostics.https_fallback_last_takeover_outage_number === 4,
  "relay handshake diagnostics lost bounded outage evidence");
  const bounded = relayHandshakeDiagnostics({
    outage_count: -1,
    outage_duration_ms: Number.POSITIVE_INFINITY,
    last_connect_milestones_ms: { dns_resolved: Number.POSITIVE_INFINITY, tcp_connected: -1 },
    last_failed_connect_stage: "private_stage",
    last_failed_connect_duration_ms: Number.POSITIVE_INFINITY,
    last_failed_connect_milestones_ms: { tls_established: -1 },
    last_failed_connect_http_status: 999,
    last_transport_error_reason: "private-network-detail",
    heartbeat: { last_probe_buffered_bytes: Number.POSITIVE_INFINITY, last_probe_dispatch_ms: -1 },
    last_ready_inbound_silence_ms: Number.POSITIVE_INFINITY,
    https_fallback_last_takeover_ms: Number.POSITIVE_INFINITY,
    https_fallback_last_takeover_outage_number: Number.POSITIVE_INFINITY,
    recent_outages: [{ outage_number: -1, duration_ms: Number.POSITIVE_INFINITY, private_value: "x" }],
  });
  assert(bounded.outage_count === 0 && bounded.outage_duration_ms === 0
    && Object.keys(bounded.last_connect_milestones_ms).length === 0
    && bounded.last_failed_connect_stage === null
    && bounded.last_failed_connect_duration_ms === 0
    && Object.keys(bounded.last_failed_connect_milestones_ms).length === 0
    && bounded.last_failed_connect_http_status === null
    && bounded.last_transport_error_reason === "unknown"
    && bounded.last_probe_buffered_bytes === 0
    && bounded.last_probe_dispatch_ms === 0
    && bounded.previous_ready_inbound_silence_ms === 0
    && bounded.recent_outages.length === 0
    && bounded.https_fallback_last_takeover_ms === 0
    && bounded.https_fallback_last_takeover_outage_number === 0,
    "relay handshake diagnostics accepted invalid numeric fields");
}


function testRelayReconnectDelivery() {
  const events = [];
  const activeCalls = new Set(["call_reconnect"]);
  const suppressed = new Map();
  let sendSucceeds = false;
  let scheduledCallback = null;
  let scheduled = 0;
  let cancelled = 0;
  let terminated = 0;
  const recovery = new RelayCallRecovery({
    logger: {
      event(level, name, fields, message) { events.push({ level, name, fields, message }); },
      warn(message) { events.push({ level: "warn", name: "warn", message }); },
    },
    send() { return sendSucceeds; },
    isRecoverable: () => true,
    activeCallIds: () => activeCalls,
    suppressCall(callId, reason) { suppressed.set(callId, reason); },
    cancelOrigin() { cancelled += activeCalls.size; activeCalls.clear(); return cancelled; },
    terminate() { terminated += 1; },
    graceMs: 30_000,
    scheduler: {
      setTimeout(callback) { scheduled += 1; scheduledCallback = callback; return { unref() {} }; },
      clearTimeout() { scheduledCallback = null; },
    },
  });

  sendSucceeds = true;
  activeCalls.add("call_ack");
  assert(recovery.deliver({ id: "call_ack", ok: true }) === true, "connected result was not sent");
  assert(recovery.hasRetainedResult("call_ack"), "connected result was discarded before Worker acknowledgement");
  assert(recovery.acknowledge("call_ack") && !recovery.hasRetainedResult("call_ack"),
    "Worker acknowledgement did not clear a connected result");
  activeCalls.delete("call_ack");
  sendSucceeds = false;

  assert(recovery.deliver({ id: "call_reconnect", ok: true }) === false, "result queued during an outage was reported as delivered");
  assert(recovery.hasRetainedResult("call_reconnect"), "completed result was not retained for reconnect delivery");
  assert(scheduled === 1 && typeof scheduledCallback === "function", "queued result did not arm reconnect expiry");
  recovery.disconnected();
  assert(scheduled === 1, "disconnect armed a duplicate reconnect-expiry timer");
  assert(activeCalls.has("call_reconnect"), "brief disconnect cancelled an in-flight call immediately");

  sendSucceeds = true;
  recovery.ready();
  assert(recovery.hasRetainedResult("call_reconnect") && scheduledCallback === null,
    "replayed result was discarded before Worker acknowledgement");
  assert(events.some((event) => event.name === "relay.tool_results.redelivered" && event.fields.delivered_results === 1), "redelivered result was not observable");
  recovery.pulse();
  assert(recovery.hasRetainedResult("call_reconnect"), "heartbeat replay discarded an unacknowledged result");
  assert(recovery.acknowledge("call_reconnect") && recovery.retainedResultCount() === 0,
    "Worker acknowledgement did not clear the retained result");
  activeCalls.delete("call_reconnect");

  sendSucceeds = false;
  activeCalls.add("call_expire");
  recovery.deliver({ id: "call_expire", ok: true });
  const expire = scheduledCallback;
  assert(typeof expire === "function", "second outage did not arm expiry");
  expire();
  assert(cancelled === 1 && terminated === 1, "reconnect expiry did not cancel calls and terminate ordinary processes");
  assert(suppressed.get("call_expire") === "relay_reconnect_timeout", "reconnect expiry did not suppress the eventual result");
  assert(recovery.retainedResultCount() === 0, "reconnect expiry retained queued results");
  const reconnectSafety = recovery.redeliverySafetySnapshot();
  assert(reconnectSafety.automaticRedeliverySafe === false
    && reconnectSafety.unsafeCallTombstones === 1
    && reconnectSafety.globalRedeliveryDisabled === false,
  "reconnect-grace result discard did not retain bounded per-call replay-safety evidence");
  assert(JSON.stringify(recovery.reconcile(["call_expire", "call_fresh_missing"], () => false)) === JSON.stringify(["call_fresh_missing"]),
    "one unsafe completed call disabled automatic non-delivery proof for an unrelated resumed call");
  const reconnectExpired = events.find((event) => event.name === "relay.calls.reconnect_expired");
  assert(reconnectExpired?.level === "warn"
    && reconnectExpired.fields?.cancelled_calls === 1
    && reconnectExpired.fields?.discarded_results === 1
    && reconnectExpired.fields?.grace_ms === 30_000,
  "reconnect expiry did not emit structured loss diagnostics");
}


async function testRelayShutdownDrain() {
  const sent = [];
  const drain = new RuntimeRelayShutdownDrain({
    send: (value) => { sent.push(value); return true; }, ready: () => true, waitMs: 100,
  });
  const settlement = drain.begin(3);
  assert(sent.length === 1
    && sent[0].type === "daemon_draining"
    && sent[0].active_calls === 3
    && /^drain_[A-Za-z0-9_-]{24}$/.test(sent[0].drain_id),
  "planned relay shutdown did not publish one bounded drain control message");
  assert(drain.acknowledge({ type: "daemon_draining_ack", drain_id: sent[0].drain_id }) === true,
    "planned relay shutdown did not accept the matching Worker acknowledgement");
  const result = await settlement;
  assert(result.attempted === true && result.acknowledged === true && result.reason === "acknowledged",
    "planned relay shutdown did not settle on the matching acknowledgement");
  const unavailable = new RuntimeRelayShutdownDrain({ send: () => true, ready: () => false });
  assert((await unavailable.begin(1)).attempted === false,
    "planned relay shutdown emitted a control message while the relay was not ready");
}


function testRelayRecoveryCapacity() {
  const ordinary = Array(14).fill("read_file");
  assert(relayRecoveryCapacityRejection(ordinary.slice(0, 13), 0, "read_file", "call_capacity_1") === null,
    "relay recovery capacity rejected an ordinary call below its reserved-control boundary");
  const ordinaryRejection = relayRecoveryCapacityRejection(ordinary, 0, "read_file", "call_capacity_2");
  assert(ordinaryRejection?.error?.code === "limit_exceeded"
    && ordinaryRejection.error?.retryable === true
    && ordinaryRejection.error?.details?.side_effects_started === false,
  "relay recovery ownership did not reserve control-plane capacity with a retry-safe pre-dispatch rejection");
  assert(relayRecoveryCapacityRejection(ordinary, 0, "diagnose_runtime", "call_capacity_3") === null,
    "relay recovery ownership let ordinary calls consume reserved diagnosis capacity");
  assert(relayRecoveryCapacityRejection(Array(16).fill("read_file"), 0, "diagnose_runtime", "call_capacity_4")?.error?.code === "limit_exceeded",
    "relay recovery ownership exceeded the total call-capacity ceiling");
  assert(relayRecoveryCapacityRejection(["diagnose_runtime", "list_roots", ...Array(12).fill("read_file")], 0,
    "read_file", "call_capacity_5") === null,
  "relay recovery ownership conservatively misclassified active control calls as ordinary retained results");
  assert(relayRecoveryCapacityRejection([], 14, "read_file", "call_capacity_6")?.error?.code === "limit_exceeded"
    && relayRecoveryCapacityRejection([], 14, "diagnose_runtime", "call_capacity_7") === null,
  "unacknowledged relay results did not consume ordinary capacity while preserving reserved control capacity");
  const snapshot = relayRecoveryCapacitySnapshot(["read_file", "diagnose_runtime"], 3, false, 2, false);
  assert(snapshot.active_calls === 2 && snapshot.retained_results === 3 && snapshot.active_ownership === 5
    && snapshot.maximum === 16 && snapshot.ordinary_capacity === 14 && snapshot.reserved_control_capacity === 2
    && snapshot.automatic_redelivery_safe === false && snapshot.unsafe_call_tombstones === 2
    && snapshot.global_redelivery_disabled === false
    && !JSON.stringify(snapshot).includes("read_file") && !JSON.stringify(snapshot).includes("diagnose_runtime"),
  "relay recovery capacity diagnostics lost bounded aggregate-only projection");

  let overflowSends = 0;
  const overflowEvents = [];
  const recovery = new RelayCallRecovery({
    isRecoverable: () => true,
    send: () => { overflowSends += 1; return true; },
    logger: { event: (level, name, fields) => { overflowEvents.push({ level, name, fields }); } },
  });
  for (let index = 0; index < MAX_CONCURRENT_TOOL_CALLS; index += 1) {
    assert(recovery.deliver({ id: `call_retained_${index}`, ok: true }) === true,
      "relay recovery failed before the normal retained-result ceiling");
  }
  assert(recovery.deliver({ id: "call_retained_overflow", ok: true }) === true
    && recovery.retainedResultCount() === MAX_CONCURRENT_TOOL_CALLS + 1 && overflowSends === MAX_CONCURRENT_TOOL_CALLS + 1
    && recovery.hasRetainedResult("call_retained_overflow")
    && overflowEvents.some((event) => event.level === "error" && event.name === "relay.tool_result.retention_capacity"
      && event.fields?.emergency_slot_used === true),
  "relay recovery invariant failure sent a completed result without preserving acknowledgement ownership");
  assert(recovery.deliver({ id: "call_retained_second_overflow", ok: true }) === false
    && recovery.retainedResultCount() === MAX_CONCURRENT_TOOL_CALLS + 1 && overflowSends === MAX_CONCURRENT_TOOL_CALLS + 1,
  "relay recovery accepted a second result after its single emergency ownership slot was occupied");
  const resumedAfterInvariantFailure = [
    ...Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, (_, index) => `call_retained_${index}`),
    "call_retained_overflow", "call_retained_second_overflow", "call_never_owned_after_invariant_failure",
  ];
  assert(JSON.stringify(recovery.reconcile(resumedAfterInvariantFailure, () => false)) === JSON.stringify(["call_never_owned_after_invariant_failure"]),
    "per-call retention loss either replayed the unsafe call or disabled safe missing-ID recovery for an unrelated call");

  let clock = 0;
  const retentionEvents = [];
  const expiring = new RelayCallRecovery({
    isRecoverable: () => true,
    send: () => true,
    now: () => clock,
    logger: { event: (_level, name, fields) => { retentionEvents.push({ name, fields }); } },
  });
  assert(expiring.deliver({ id: "call_ack_lost_12345678", ok: true }) === true && expiring.retainedResultCount() === 1,
    "successful relay result was not retained for Worker acknowledgement");
  clock = Number(relayContract.maximumRelayToolTimeoutMs) - 1;
  expiring.pulse();
  assert(expiring.retainedResultCount() === 1, "relay result retention expired before the maximum Worker settlement lifetime");
  clock = Number(relayContract.maximumRelayToolTimeoutMs) + 1;
  expiring.pulse();
  const expiredSafety = expiring.redeliverySafetySnapshot();
  assert(expiring.retainedResultCount() === 0
    && expiredSafety.automaticRedeliverySafe === false
    && expiredSafety.unsafeCallTombstones === 1
    && expiredSafety.globalRedeliveryDisabled === false
    && retentionEvents.some((event) => event.name === "relay.tool_results.ack_expired"
      && event.fields?.expired_results === 1
      && event.fields?.acknowledgement_retention_ms === relayContract.maximumRelayToolTimeoutMs),
  "lost Worker acknowledgement retained completed relay result beyond the bounded settlement lifetime");
  assert(JSON.stringify(expiring.reconcile(["call_ack_lost_12345678", "call_safe_after_old_loss"], () => false)) === JSON.stringify(["call_safe_after_old_loss"]),
    "expired acknowledgement ownership either became replayable or globally disabled unrelated recovery");
  assert(JSON.stringify(expiring.reconcile(["call_safe_after_old_loss"], () => false)) === JSON.stringify(["call_safe_after_old_loss"]),
    "safe resumed call was not classified as daemon-proven missing after the old unsafe tombstone retired");
  const recoveredSafety = expiring.redeliverySafetySnapshot();
  assert(recoveredSafety.automaticRedeliverySafe === true && recoveredSafety.unsafeCallTombstones === 0,
    "unsafe relay call tombstone did not retire after the Worker stopped resuming that call");
}
