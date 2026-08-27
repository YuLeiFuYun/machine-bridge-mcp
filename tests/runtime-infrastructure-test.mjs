import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BridgeError, errorCode, publicError } from "../src/local/errors.mjs";
import { CallRegistry } from "../src/local/call-registry.mjs";
import { RuntimeObservability } from "../src/local/observability.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { childExitedBeforeTimeout, createChildProcessSettlement } from "../src/local/child-process-settlement.mjs";
import { processState } from "../src/local/process-identity.mjs";
import { captureProcessTreeOwnership, processTreeOwnershipStillCurrent, refreshProcessTreeOwnership, terminateProcessTree, terminateProcessTreeAndWait, terminateProcessTreeWithEscalation } from "../src/local/process-tree.mjs";
import { executionGuardrailsSnapshot, MAX_CONCURRENT_TOOL_CALLS } from "../src/local/execution-limits.mjs";
import { ToolExecutor, composeMiddleware } from "../src/local/tool-executor.mjs";
import { MAX_TOOL_RESULT_BYTES, normalizeToolResult } from "../src/local/tool-result-boundary.mjs";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import { boundedProcessErrorMessage } from "../src/local/process-error-message.mjs";
import { runExecutable, workspaceShellCommand } from "../src/local/shell.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { LocalRuntime } from "../src/local/runtime.mjs";
import { FileMutationCoordinator } from "../src/local/file-mutation-coordinator.mjs";
import { DIRECTORY_METADATA_BATCH_SIZE, directoryEntriesWithMetadata } from "../src/local/directory-metadata.mjs";
import { SEARCH_FILE_BATCH_SIZE, searchWorkspaceFiles } from "../src/local/workspace-search.mjs";
import { projectRuntimeInfo } from "../src/local/runtime-info-projection.mjs";
import { normalizeRelayResumeCalls, normalizeRelayToolCall } from "../src/local/runtime-relay.mjs";
import { relayHandshakeDiagnostics } from "../src/local/relay-peer-diagnostics.mjs";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { RelayCallRecovery } from "../src/local/relay-call-recovery.mjs";
import { RuntimeRelayShutdownDrain } from "../src/local/runtime-relay-shutdown-drain.mjs";
import { relayRecoveryCapacityRejection } from "../src/local/relay-recovery-admission.mjs";
import { relayRecoveryCapacitySnapshot } from "../src/local/relay-recovery-diagnostics.mjs";
import { startAutostartLogMaintenance } from "../src/local/autostart-log-maintenance.mjs";
import { createSecurityAuditFailureReporter } from "../src/local/security-audit-warning.mjs";
import { resourceAdmissionLogFields } from "../src/local/resource-admission-diagnostics.mjs";
import { LifecycleController } from "../src/local/lifecycle.mjs";
import { DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS, RemoteActivityIdleSleepGuard } from "../src/local/remote-activity-idle-sleep-guard.mjs";

const PROCESS_FIXTURE_TIMEOUT_MS = 30_000;

await testCallRegistry();
await testToolExecutor();
await testToolExecutorConcurrency();
await testToolExecutorLateCancellationSettlement();
await testFileMutationCoordinator();
await testDirectoryMetadataFanout();
await testWorkspaceSearchFanout();
await testRuntimeInfoProjection();
testToolResultBoundary();
await testDuplicateRelayCallId();
await testRelayRecoveryAdmissionRejectsBeforeExecution();
testRelayReadinessProbe();
await testRelayReadinessStateGuards();
testRelayCancellationSuppression();
await testRelayResumeReconciliation();
testRelayToolTimeoutNormalization();
testRelayHandshakeDiagnostics();
testRuntimeConvenienceMethods();
await testRuntimeStartStopRace();
testRemoteActivityIdleSleepGuard();
testRelayRecoveryCapacity();
testRelayReconnectDelivery();
await testRelayShutdownDrain();
testAutostartLogMaintenance();
await testProcessExecutionNoShell();
await testForegroundTimeoutAlignment();
await testFixedInternalProcessBoundary();
await testProcessExitFallbackSettlement();
testTrustedGitExecutable();
await testProcessCancellationSettlesBeforeClose();
await testProcessErrorRetainsOwnershipUntilClose();
await testRunExecutableErrorWaitsForClose();
await testRunExecutableHardTimeoutWaitsForTreeSettlement();
await testProcessTimeoutIsNotSafeToRetry();
await testProcessTracker();
await testProcessTreeSupervisor();
await testChildProcessSettlement();
testHardSpawnSyncTimeout();
testExecutionGuardrails();
testSecurityAuditWarningRateLimit();
testErrors();
testWorkspaceShellSelection();
testBoundedOutput();
console.log("runtime infrastructure test ok");

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

  let unsupportedSpawned = false;
  const unsupported = new RemoteActivityIdleSleepGuard({
    platform: "linux",
    spawnProcess() { unsupportedSpawned = true; return fakeChild(); },
  });
  assert(unsupported.beginActivity() === false && unsupported.endActivity() === false && unsupportedSpawned === false
    && unsupported.snapshot().supported === false && unsupported.snapshot().enabled === false
    && unsupported.snapshot().requests_system_sleep_prevention_on_ac === false,
  "non-macOS runtime attempted to establish or report support for a platform-specific idle-sleep guard");

  const failureEvents = [];
  let failureTimers = 0;
  const unavailable = new RemoteActivityIdleSleepGuard({
    platform: "darwin",
    daemonPid: 4242,
    graceMs: 5_000,
    spawnProcess() { throw new Error("FORBIDDEN_DETAIL_MARKER FORBIDDEN_LOCATION_MARKER"); },
    setTimer() { failureTimers += 1; throw new Error("timer should not be armed"); },
    logger: { event(level, name, fields, message) { failureEvents.push({ level, name, fields, message }); } },
  });
  const firstUnavailableBegin = unavailable.beginActivity();
  const repeatedUnavailableBegin = unavailable.beginActivity();
  const firstUnavailableEnd = unavailable.endActivity();
  const repeatedUnavailableEnd = unavailable.endActivity();
  assert(firstUnavailableBegin === false && repeatedUnavailableBegin === false
    && firstUnavailableEnd === false && repeatedUnavailableEnd === false && failureTimers === 0,
  "failed idle-sleep process setup armed timers or escaped as a tool-call failure");
  assert(failureEvents.length === 1 && failureEvents[0].level === "warn"
    && failureEvents[0].name === "runtime.idle_sleep_guard.unavailable"
    && Object.keys(failureEvents[0].fields).join(",") === "error_class"
    && !JSON.stringify(failureEvents[0]).includes("FORBIDDEN_DETAIL_MARKER")
    && !JSON.stringify(failureEvents[0]).includes("FORBIDDEN_LOCATION_MARKER"),
  "idle-sleep guard failure logging exposed sensitive process error text or failed to suppress duplicate error classes");

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

  const unexpectedChild = fakeChild();
  const unexpectedEvents = [];
  const unexpected = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000,
    spawnProcess() { return unexpectedChild; },
    logger: { event(level, name, fields) { unexpectedEvents.push({ level, name, fields }); } },
  });
  assert(unexpected.beginActivity() === true, "unexpected-exit fixture failed to establish the guard");
  unexpectedChild.emit("exit", 1, null);
  assert(unexpected.snapshot().active === false && unexpectedEvents.length === 1
    && unexpectedEvents[0].name === "runtime.idle_sleep_guard.unavailable" && unexpected.endActivity() === false,
  "unexpected idle-sleep child exit during active work was silent or armed an invalid grace timer");

  const loggingFailure = new RemoteActivityIdleSleepGuard({
    platform: "darwin", daemonPid: 4242, graceMs: 5_000,
    spawnProcess() { throw new Error("FORBIDDEN_LOGGING_FAILURE_MARKER"); },
    logger: { event() { throw new Error("logger unavailable"); } },
  });
  assert(loggingFailure.beginActivity() === false && loggingFailure.endActivity() === false,
    "auxiliary idle-sleep logging failure escaped into tool settlement");
}

async function testWorkspaceSearchFanout() {
  const files = Array.from({ length: 20 }, (_value, index) => `/synthetic/file-${String(index).padStart(2, "0")}`);
  const makeWalk = (items) => async (onFile) => {
    for (const file of items) {
      if (await onFile(file) === false) return { truncated: true, visitedEntries: items.indexOf(file) + 1 };
    }
    return { truncated: false, visitedEntries: items.length };
  };
  let active = 0;
  let maximumActive = 0;
  const result = await searchWorkspaceFiles({
    maximumFiles: files.length,
    maximumMatches: 100,
    walk: makeWalk(files),
    async searchFile(file) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return [{ path: file, line: 1, text: file }];
    },
  });
  assert(maximumActive === SEARCH_FILE_BATCH_SIZE,
    `workspace search fan-out exceeded or failed to use its bounded concurrency (${maximumActive})`);
  assert(JSON.stringify(result.matches.map((match) => match.path)) === JSON.stringify(files),
    "workspace search fan-out changed file or match ordering");
  assert(result.visitedFiles === files.length && result.truncated === true,
    "workspace search fan-out lost exact max_files accounting");

  const lateError = new Error("later search failed");
  const early = await searchWorkspaceFiles({
    maximumFiles: 2,
    maximumMatches: 1,
    batchSize: 2,
    walk: makeWalk(["/synthetic/first", "/synthetic/second"]),
    async searchFile(file) {
      if (file.endsWith("second")) throw lateError;
      return [{ path: file, line: 1, text: "match" }];
    },
  });
  assert(early.matches.length === 1 && early.visitedFiles === 1 && early.truncated === true,
    "workspace search exposed work beyond an earlier max_matches stop");

  let consumedError;
  try {
    await searchWorkspaceFiles({
      maximumFiles: 2,
      maximumMatches: 1,
      batchSize: 2,
      walk: makeWalk(["/synthetic/first", "/synthetic/second"]),
      async searchFile(file) {
        if (file.endsWith("second")) throw lateError;
        return [];
      },
    });
  } catch (error) { consumedError = error; }
  assert(consumedError === lateError, "workspace search hid or replaced a consumed file-search error");

  let searched = 0;
  const capped = await searchWorkspaceFiles({
    maximumFiles: 2,
    maximumMatches: 100,
    batchSize: 16,
    walk: makeWalk(files.slice(0, 4)),
    async searchFile() { searched += 1; return []; },
  });
  assert(searched === 2 && capped.visitedFiles === 2 && capped.truncated === true,
    "workspace search scheduled or counted files beyond max_files");

  const cancellationError = new Error("search cancelled during file I/O");
  let cancelled = false;
  let cancellationObserved;
  try {
    await searchWorkspaceFiles({
      maximumFiles: 1,
      maximumMatches: 1,
      walk: makeWalk(["/synthetic/cancel"]),
      async searchFile() { await Promise.resolve(); cancelled = true; return []; },
      throwIfCancelled() { if (cancelled) throw cancellationError; },
    });
  } catch (error) { cancellationObserved = error; }
  assert(cancellationObserved === cancellationError, "workspace search ignored cancellation after prefetched file I/O");
}

async function testDirectoryMetadataFanout() {
  const fakeEntries = Array.from({ length: 20 }, (_value, index) => ({ name: `entry-${String(index).padStart(2, "0")}` }));
  const openDirectory = async () => ({
    async *[Symbol.asyncIterator]() { for (const entry of fakeEntries) yield entry; },
  });
  let active = 0;
  let maximumActive = 0;
  const inspect = async (path) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { size: path.length };
  };
  const observed = [];
  for await (const item of directoryEntriesWithMetadata("/synthetic", { openDirectory, inspect })) observed.push(item.entry.name);
  assert(maximumActive === DIRECTORY_METADATA_BATCH_SIZE,
    `directory metadata fan-out exceeded or failed to use its bounded concurrency (${maximumActive})`);
  assert(JSON.stringify(observed) === JSON.stringify(fakeEntries.map((entry) => entry.name)),
    "directory metadata fan-out changed directory enumeration order");

  const deferredError = new Error("later metadata failed");
  const twoEntries = async () => ({
    async *[Symbol.asyncIterator]() { yield { name: "first" }; yield { name: "second" }; },
  });
  const inspectWithLateFailure = async (path) => {
    if (path.endsWith("second")) throw deferredError;
    return { size: 1 };
  };
  const truncated = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries, inspect: inspectWithLateFailure, batchSize: 2,
  });
  const first = await truncated.next();
  assert(first.value?.entry?.name === "first", "directory metadata fan-out lost the first settled entry");
  await truncated.return();

  const consumed = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries, inspect: inspectWithLateFailure, batchSize: 2,
  });
  assert((await consumed.next()).value?.entry?.name === "first", "directory metadata error fixture lost its leading entry");
  let consumedError;
  try { await consumed.next(); } catch (error) { consumedError = error; }
  assert(consumedError === deferredError, "directory metadata fan-out hid or replaced an error that was actually consumed");

  let cancelled = false;
  const cancellationError = new Error("cancelled between prefetched entries");
  const cancellable = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries,
    inspect: async () => ({ size: 1 }),
    batchSize: 2,
    throwIfCancelled() { if (cancelled) throw cancellationError; },
  });
  assert((await cancellable.next()).value?.entry?.name === "first", "directory metadata cancellation fixture did not yield first entry");
  cancelled = true;
  let cancellationObserved;
  try { await cancellable.next(); } catch (error) { cancellationObserved = error; }
  assert(cancellationObserved === cancellationError, "directory metadata fan-out ignored cancellation between prefetched entries");

  const empty = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: async () => ({ async *[Symbol.asyncIterator]() {} }),
    inspect,
    batchSize: 65,
  });
  assert((await empty.next()).done === true, "directory metadata fan-out did not settle an empty directory");

  const tailError = new Error("tail metadata failed");
  const tail = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: async () => ({
      async *[Symbol.asyncIterator]() { yield { name: "a" }; yield { name: "b" }; yield { name: "tail" }; },
    }),
    batchSize: 2,
    inspect: async (path) => { if (path.endsWith("tail")) throw tailError; return { size: 1 }; },
  });
  assert((await tail.next()).value?.entry?.name === "a" && (await tail.next()).value?.entry?.name === "b",
    "directory metadata tail-error fixture lost its full leading batch");
  let tailObserved;
  try { await tail.next(); } catch (error) { tailObserved = error; }
  assert(tailObserved === tailError, "directory metadata fan-out hid or replaced a consumed tail-batch error");
}

async function testCallRegistry() {
  const timers = new Map();
  let nextTimer = 1;
  const cancelled = [];
  const registry = new CallRegistry({
    maximum: 2,
    now: () => 100,
    scheduler: {
      setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    onCancel(record) { cancelled.push({ id: record.id, reason: record.cancelReason }); },
  });
  const first = registry.open({ callId: "one", tool: "read_file", origin: "stdio", timeoutMs: 50 });
  registry.open({ callId: "two", tool: "git_status", origin: "relay" });
  assert(registry.idsByOrigin("relay").join(",") === "two", "origin index did not expose the active relay call");
  expectBridgeError(() => registry.open({ callId: "three" }), "limit_exceeded");
  expectBridgeError(() => registry.open({ callId: "one" }), "conflict");
  [...timers.values()][0]();
  expectBridgeError(() => registry.throwIfCancelled(first), "timeout");
  assert(cancelled[0]?.reason === "deadline exceeded", "deadline did not use the central cancellation path");
  assert(registry.snapshot().active === 2, "cancelled call vanished before lifecycle finish");
  const prototypeOriginRegistry = new CallRegistry({ maximum: 1 });
  prototypeOriginRegistry.open({ callId: "prototype-origin", tool: "read_file", origin: "__proto__" });
  const prototypeOriginSnapshot = prototypeOriginRegistry.snapshot();
  assert(Object.hasOwn(prototypeOriginSnapshot.by_origin, "__proto__") && prototypeOriginSnapshot.by_origin.__proto__ === 1,
    "call-registry diagnostics lost a prototype-shaped origin key");
  assert(Object.getPrototypeOf(prototypeOriginSnapshot.by_origin) === null, "call-registry origin diagnostics regained prototype semantics");
  prototypeOriginRegistry.finish("prototype-origin");
  registry.finish("one");
  assert(registry.cancelOrigin("relay", "relay disconnected") === 1, "relay origin cancellation did not find its call");
  assert(cancelled.at(-1)?.reason === "relay disconnected", "relay origin cancellation lost its reason");
  registry.finish("two");
  assert(registry.snapshot().active === 0, "finished calls leaked from registry");

  const authority = new CallRegistry({ maximum: 3 });
  const accountId = `acct_${"r".repeat(32)}`;
  const clientId = `mcp_client_${"r".repeat(43)}`;
  const familyId = `mcp_family_${"r".repeat(43)}`;
  authority.open({ callId: "family-call", tool: "run_process", origin: "relay" });
  authority.bindPrincipal("family-call", { kind: "account", accountId, accountVersion: 4, clientId, familyId, role: "operator" });
  authority.open({ callId: "new-version", tool: "read_file", origin: "relay" });
  authority.bindPrincipal("new-version", { kind: "account", accountId, accountVersion: 5, clientId, familyId, role: "operator" });
  assert(authority.cancelAuthority({ accountId, accountVersion: 4, clientId, familyId }) === 1,
    "family authority revocation did not cancel the exact old-version call");
  expectBridgeError(() => authority.throwIfCancelled({ callId: "family-call" }), "authorization_denied");
  authority.throwIfCancelled({ callId: "new-version" });
  authority.finish("family-call");
  authority.finish("new-version");

  const defaultCapacity = new CallRegistry();
  assert(defaultCapacity.snapshot().maximum === 16,
    "default local call capacity drifted from the sixteen-call runtime contract");

  const reserved = new CallRegistry({ maximum: 3, reserved: 1, reservedTools: ["diagnose_runtime"] });
  reserved.open({ callId: "ordinary-one", tool: "exec_command" });
  reserved.open({ callId: "ordinary-two", tool: "read_file" });
  expectBridgeError(() => reserved.open({ callId: "ordinary-three", tool: "git_status" }), "limit_exceeded");
  reserved.open({ callId: "control", tool: "diagnose_runtime" });
  assert(reserved.snapshot().active_reserved === 1 && reserved.snapshot().ordinary_capacity === 2,
    "control-plane reservation did not preserve diagnostic capacity");

  registry.open({ callId: "stop-one", tool: "read_file" });
  registry.open({ callId: "stop-two", tool: "git_status" });
  const callDrain = registry.cancelAllAndWait("runtime stopped", 100);
  assert(registry.snapshot().active === 2, "call shutdown discarded handlers before lifecycle settlement");
  expectBridgeError(() => registry.open({ callId: "late-stop-call", tool: "read_file" }), "unavailable");
  registry.finish("stop-one");
  let drainSettled = false;
  callDrain.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert(!drainSettled, "call shutdown settled while a handler was still registered");
  registry.finish("stop-two");
  await callDrain;
  assert(registry.snapshot().active === 0, "call shutdown left settled calls registered");

  const stalledCalls = new CallRegistry({ maximum: 1 });
  stalledCalls.open({ callId: "stalled-stop-call", tool: "run_process" });
  await expectReject(() => stalledCalls.cancelAllAndWait("runtime stopped", 20), "unavailable", "tool call shutdown did not settle");
  assert(stalledCalls.snapshot().active === 1, "failed call shutdown discarded the retained in-flight handler");
  expectBridgeError(() => stalledCalls.open({ callId: "post-timeout-call", tool: "read_file" }), "unavailable");
  stalledCalls.finish("stalled-stop-call");
}

async function testToolExecutor() {
  const events = [];
  const metrics = new RuntimeObservability({ now: () => 1000 });
  const registry = new CallRegistry({ maximum: 4 });
  const fullPolicy = { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true };
  const gate = { policy: fullPolicy, assert(name) { if (name === "write_file") throw new BridgeError("policy_denied", "denied"); } };
  const accountAccessGate = {
    assert(role, name) { if (role !== "owner" || name === "account-denied") throw new BridgeError("policy_denied", "account denied"); },
    authority() { return { principal: { kind: "account", role: "owner" }, effectivePolicy: fullPolicy, owner: true }; },
  };
  const executor = new ToolExecutor({
    handlers: {
      read_file: async (args, context) => ({ value: args.path, call_id: context.callId }),
      git_status: async () => { throw new Error("raw implementation failure"); },
      exec_command: async () => ({ unexpected: true }),
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: {
      async authorize(operation) {
        if (operation.tool === "exec_command") throw new BridgeError("authorization_denied", "request exceeds the account role ceiling");
        return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] };
      },
    },
    callRegistry: registry,
    observability: metrics,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
    safeMessage: () => "safe failure",
  });
  const result = await executor.execute("read_file", { path: "fixture.txt" }, { callId: "ok-call", origin: "stdio" });
  assert(result.value === "fixture.txt" && result.call_id === "ok-call", "tool executor lost arguments or lifecycle context");
  await expectReject(() => executor.execute("git_status", {}, { callId: "fail-call", origin: "relay", authorization: { role: "owner" } }), "execution_failed", "safe failure");
  await expectReject(() => executor.execute("write_file", { path: "denied.txt", content: "x" }, { callId: "deny-call" }), "policy_denied", "denied");
  const authorityError = await expectReject(
    () => executor.execute("exec_command", { command: "true" }, { callId: "authority-call", origin: "relay", authorization: { role: "owner" } }),
    "authorization_denied",
    "request exceeds the account role ceiling",
  );
  assert(authorityError.retryable === false, "role-ceiling denial was incorrectly made retryable");
  const snapshot = metrics.snapshot();
  assert(snapshot.calls.started === 4, "authorization attempts are missing from execution metrics");
  assert(snapshot.calls.completed === 1 && snapshot.calls.failed === 3, "tool metrics lost terminal outcomes");
  assert(snapshot.errors.execution_failed === 1 && snapshot.errors.policy_denied === 1 && snapshot.errors.authorization_denied === 1, "tool metrics lost stable error codes");
  assert(events.some((event) => event.name === "tool.call.started") && events.some((event) => event.name === "tool.call.failed"), "structured lifecycle events were not emitted");
  assert(registry.snapshot().active === 0, "tool executor leaked call lifecycle state");

  const managedJobReadExecutor = new ToolExecutor({
    handlers: { read_job: async (args) => ({ wait_ms: args.wait_ms }) },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event() {} },
  });
  assert((await managedJobReadExecutor.execute("read_job", { job_id: "job_123456789012345678901234", wait_ms: 40_001 }, {
    callId: "relay-read-job-over-local-maximum", origin: "relay", authorization: { role: "owner" },
  })).wait_ms === 40_001, "relay read_job did not accept the hosted wait extension above the local schema maximum");
  assert((await managedJobReadExecutor.execute("read_job", { job_id: "job_123456789012345678901234", wait_ms: 300_000 }, {
    callId: "relay-read-job-hosted-maximum", origin: "relay", authorization: { role: "owner" },
  })).wait_ms === 300_000, "relay read_job did not accept the hosted maximum wait");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 300_001,
  }, { callId: "relay-read-job-over-hosted-maximum", origin: "relay", authorization: { role: "owner" } }),
  "invalid_request", "tool arguments do not match the input schema");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 40_001,
  }, { callId: "local-read-job-over-local-maximum", origin: "stdio" }),
  "invalid_request", "tool arguments do not match the input schema");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 40_000.5,
  }, { callId: "relay-read-job-non-integer", origin: "relay", authorization: { role: "owner" } }),
  "invalid_request", "tool arguments do not match the input schema");

  let authorizedRelayActivityStarts = 0;
  let authorizedRelayActivityEnds = 0;
  let authorizedHandlerRuns = 0;
  const activityExecutor = new ToolExecutor({
    handlers: { read_file: async ({ path }) => {
      authorizedHandlerRuns += 1;
      if (path === "handler-failure.txt") throw new BridgeError("unavailable", "handler failed after activity start");
      return "authorized";
    } },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event() {} },
    onAuthorizedRelayActivityStart() { authorizedRelayActivityStarts += 1; },
    onAuthorizedRelayActivityEnd() { authorizedRelayActivityEnds += 1; },
  });
  assert(await activityExecutor.execute("read_file", { path: "authorized.txt" }, {
    callId: "authorized-activity", origin: "relay", authorization: { role: "owner" },
  }) === "authorized", "authorized relay activity did not reach its handler");
  assert(authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 1,
    "authorized schema-valid relay activity did not hold one balanced auxiliary activity lease");
  await expectReject(() => activityExecutor.execute("read_file", {}, {
    callId: "invalid-activity", origin: "relay", authorization: { role: "owner" },
  }), "invalid_request", "tool arguments do not match the input schema");
  await expectReject(() => activityExecutor.execute("read_file", { path: "denied.txt" }, {
    callId: "denied-activity", origin: "relay", authorization: { role: "viewer" },
  }), "policy_denied", "account denied");
  assert(authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 1,
    "invalid or unauthorized relay traffic was able to hold remote activity or invoke a handler");
  assert(await activityExecutor.execute("read_file", { path: "local.txt" }, {
    callId: "local-activity", origin: "stdio",
  }) === "authorized" && authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 2,
  "local activity incorrectly held the remote idle-sleep lease");
  await expectReject(() => activityExecutor.execute("read_file", { path: "handler-failure.txt" }, {
    callId: "failing-activity", origin: "relay", authorization: { role: "owner" },
  }), "unavailable", "handler failed after activity start");
  assert(authorizedRelayActivityStarts === 2 && authorizedRelayActivityEnds === 2 && authorizedHandlerRuns === 3,
    "relay handler failure leaked or skipped the balanced remote-activity end hook");

  const resourceEvents = [];
  const resourceExecutor = new ToolExecutor({
    handlers: {
      list_roots: async () => {
        throw new BridgeError("unavailable", "local heavy-resource capacity is temporarily unavailable", {
          retryable: true,
          details: { reason: "resource_admission", pressure_state: "red", admission_reason: "host_pressure_red" },
        });
      },
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "ordinary operation" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event(level, name, fields) { resourceEvents.push({ level, name, fields }); } },
  });
  await expectReject(
    () => resourceExecutor.execute("list_roots", {}, { callId: "resource-pressure", origin: "stdio" }),
    "unavailable",
    "local heavy-resource capacity is temporarily unavailable",
  );
  const resourceFailure = resourceEvents.find((event) => event.name === "tool.call.failed");
  assert(resourceFailure?.level === "debug"
    && resourceFailure.fields?.resource_admission_reason === "host_pressure_red"
    && resourceFailure.fields?.resource_pressure_state === "red",
  "resource-admission failure lost its coarse privacy-safe debug diagnosis");
  const redactedResourceFields = resourceAdmissionLogFields({
    details: { reason: "resource_admission", admission_reason: "private/path/value", pressure_state: "red\nsecret" },
  });
  assert(redactedResourceFields.resource_admission_reason === "resource_busy"
    && redactedResourceFields.resource_pressure_state === "unknown"
    && Object.keys(redactedResourceFields).length === 2,
  "resource-admission debug projection allowed free-form diagnostic text into logs");
  const unrelatedResourceFields = resourceAdmissionLogFields({
    details: { reason: "unrelated", admission_reason: "host_pressure_red", pressure_state: "red" },
  });
  assert(Object.keys(unrelatedResourceFields).length === 0, "non-resource failures gained resource-admission log fields");

  let releaseAudit;
  let auditQueued = 0;
  const auditPending = new Promise((resolvePromise) => { releaseAudit = resolvePromise; });
  const nonBlockingAuditExecutor = new ToolExecutor({
    handlers: { read_file: async () => "audit-independent-result" },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "ordinary operation", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    securityAudit: { record() { auditQueued += 1; return auditPending; } },
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
  });
  const auditIndependentResult = await Promise.race([
    nonBlockingAuditExecutor.execute("read_file", { path: "fixture.txt" }, {
      callId: "audit-independent", origin: "relay", authorization: { role: "owner" },
    }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error("tool result waited for security-audit persistence")), 100); }),
  ]);
  assert(auditIndependentResult === "audit-independent-result" && auditQueued === 1,
    "security audit was not queued independently from result delivery");
  releaseAudit(true);
  await Promise.resolve();

  const order = [];
  const pipeline = composeMiddleware([
    async (operation, next) => { order.push("a-before"); const value = await next(operation); order.push("a-after"); return value; },
    async (operation, next) => { order.push("b-before"); const value = await next(operation); order.push("b-after"); return value; },
  ], async () => { order.push("handler"); return true; });
  await pipeline({});
  assert(order.join(",") === "a-before,b-before,handler,b-after,a-after", "middleware composition order is invalid");
}

async function testToolExecutorConcurrency() {
  let releaseBlocked;
  let markStarted;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = new CallRegistry({ maximum: 4 });
  const executor = new ToolExecutor({
    handlers: {
      read_file: async () => {
        markStarted();
        await blocked;
        return "blocked-complete";
      },
      git_status: async () => "fast-complete",
    },
    policyGate: { policy: { profile: 'full', origin: 'explicit', revision: 5, allowWrite: true, allowExec: true, execMode: 'shell', unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true }, assert() {} },
    accountAccessGate: { assert() {}, authority(_authorization, policy) { return { principal: { kind: 'account', role: 'owner' }, effectivePolicy: policy, owner: true }; } },
    callRegistry: registry,
    observability: new RuntimeObservability(),
    logger: { event() {} },
  });

  const first = executor.execute("read_file", { path: "blocked.txt" }, { callId: "concurrent-first", origin: "relay", authorization: { role: "owner" } });
  await started;
  assert(registry.snapshot().active === 1, "blocked tool was not registered as active");
  const second = await Promise.race([
    executor.execute("git_status", {}, { callId: "concurrent-second", origin: "relay", authorization: { role: "owner" } }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error("independent tool call was serialized behind another call")), 250); }),
  ]);
  assert(second === "fast-complete", "concurrent tool returned the wrong result");
  assert(registry.snapshot().active === 1, "completing one concurrent call corrupted the other lifecycle");
  releaseBlocked();
  assert(await first === "blocked-complete", "blocked concurrent tool did not resume");
  assert(registry.snapshot().active === 0, "concurrent tool calls leaked lifecycle state");
}

async function testToolExecutorLateCancellationSettlement() {
  const registry = new CallRegistry({ maximum: 2 });
  const observability = new RuntimeObservability();
  const commitStarted = deferred();
  const finishCommit = deferred();
  let committed = false;
  const fullPolicy = { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true };
  const executor = new ToolExecutor({
    handlers: {
      write_file: async () => {
        commitStarted.resolve();
        await finishCommit.promise;
        committed = true;
        return { ok: true, committed: true };
      },
    },
    policyGate: { policy: fullPolicy, assert() {} },
    accountAccessGate: { assert() {}, authority() { return { principal: { kind: "local", role: "owner" }, effectivePolicy: fullPolicy, owner: true }; } },
    callRegistry: registry,
    observability,
    logger: { event() {} },
  });
  const pending = executor.execute("write_file", { path: "settled.txt", content: "x" }, { callId: "late-cancel-settlement" });
  await commitStarted.promise;
  assert(registry.cancel("late-cancel-settlement", "caller stopped waiting") === true, "late cancellation did not reach the in-flight call");
  finishCommit.resolve();
  const result = await pending;
  const metrics = observability.snapshot();
  assert(committed && result.committed === true, "late cancellation replaced an already-settling mutation result");
  assert(metrics.calls.completed === 1 && metrics.calls.cancelled === 0 && metrics.calls.failed === 0,
    "late cancellation made local observability disagree with the completed handler result");
  assert(registry.snapshot().active === 0, "late-cancelled settled call leaked registry state");
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
  const controlRuntime = {
    relayResumeSessionId: 0,
    relayResumeMissingIds: [],
    reconcileRelayCalls(ids) { this.resumed = ids; return ["call_missing_12345678"]; },
    cancelRelayCall(id, reason) { cancelledControlCalls.push({ id, reason }); return true; },
    applyAuthorityRevocation(value) { revokedAuthority = value; },
    handleRelayProtocolViolation(reason) { violation = reason; },
    relayCallRecovery: {
      pulse() { recoveryPulses += 1; },
      acknowledge(id) { acknowledged = id; return true; },
    },
    relay: {
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
    { type: "resume_calls", ids: ["call_valid_12345678"] },
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(controlRuntime.relayResumeSessionId === 17 && controlRuntime.resumed[0] === "call_valid_12345678", "valid resume_calls did not establish the reconnect contract");
  assert(resumeAck === undefined
    && JSON.stringify(controlRuntime.relayResumeMissingIds) === JSON.stringify(["call_missing_12345678"]),
  "resume reconciliation acknowledged missing ownership before local ready_ack completed");
  let failedResumeInterrupt = null;
  const failedResumeRuntime = {
    relayResumeSessionId: 0,
    relayResumeMissingIds: [],
    reconcileRelayCalls() { return []; },
    handleRelayProtocolViolation() {},
    relay: {
      sendForSession() { return { ok: false }; },
      confirmReady() { return true; },
      interrupt(category) { failedResumeInterrupt = category; return true; },
    },
  };
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    failedResumeRuntime,
    { type: "resume_calls", ids: [] },
    { sessionId: 18, authenticated: true, ready: false },
  );
  assert(failedResumeRuntime.relayResumeSessionId === 18 && failedResumeInterrupt === null,
    "resume reconciliation attempted acknowledgement before local readiness");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    failedResumeRuntime,
    { type: "ready_ack" },
    { sessionId: 18, authenticated: true, ready: false },
  );
  assert(failedResumeRuntime.relayResumeSessionId === 18 && failedResumeInterrupt === "relay_transport_error",
    "failed post-readiness resume acknowledgement was treated as a completed relay reconciliation");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    {
      type: "authority_revoke", revocation_id: `revoke_${"r".repeat(43)}`,
      account_id: `acct_${"r".repeat(32)}`, account_version: 4,
    },
    { sessionId: 17, authenticated: true, ready: false },
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
      { sessionId: 17, authenticated: true, ready: false },
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
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(confirmed === 1 && controlRuntime.relayResumeSessionId === 0
    && resumeAck?.sessionId === 17
    && JSON.stringify(resumeAck.message?.missing_ids) === JSON.stringify(["call_missing_12345678"]),
  "ready_ack did not complete local readiness before sending the missing-call proof");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "tool_result_ack", id: "call_valid_12345678" },
    { sessionId: 17, authenticated: true, ready: true },
  );
  assert(acknowledged === "call_valid_12345678", "valid Worker result acknowledgement was not applied");
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "ready_ack" },
    { sessionId: 18, authenticated: true, ready: false },
  );
  assert(violation === "resume_calls_required", "ready_ack without resume_calls was accepted");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "call_cancel_12345678" },
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(violation === "invalid_cancel_call" && cancelledControlCalls.length === 0,
    "pre-ready relay cancellation bypassed the authenticated ready-generation gate");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "not-a-call-id" },
    { sessionId: 17, authenticated: true, ready: true },
  );
  assert(violation === "invalid_cancel_call" && cancelledControlCalls.length === 0,
    "malformed relay cancellation reached the call registry");
  violation = "";
  await LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "cancel_call", id: "call_cancel_12345678" },
    { sessionId: 17, authenticated: true, ready: true },
  );
  assert(violation === "" && cancelledControlCalls.length === 1
    && cancelledControlCalls[0].id === "call_cancel_12345678"
    && cancelledControlCalls[0].reason === "caller_cancelled",
  "ready-generation relay cancellation did not reach the call registry exactly once");
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
    recent_outages: Array.from({ length: 10 }, (_, index) => ({
      outage_number: 10 - index,
      disconnected_at: `2026-08-04T11:36:${String(10 + index).padStart(2, "0")}.000Z`,
      ready_at: `2026-08-04T11:36:${String(11 + index).padStart(2, "0")}.000Z`,
      duration_ms: 1000 + index,
      attempts: 1,
      close_category: "relay_heartbeat_timeout",
      close_code: 1006,
      network_route: "system-network-stack",
      last_transport_error_class: "network_error",
      last_transport_error_reason: "connection_reset",
      previous_ready_duration_ms: 5000,
      previous_ready_inbound_silence_ms: 12000,
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
    && diagnostics.recent_outages[0].last_connect_milestones_ms.private_stage === undefined
    && diagnostics.recent_outages[0].private_value === undefined
    && diagnostics.https_fallback_last_takeover_ms === 1350,
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
    && bounded.https_fallback_last_takeover_ms === 0,
    "relay handshake diagnostics accepted invalid numeric fields");
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

function testRuntimeConvenienceMethods() {
  let finished = "";
  const delegated = [];
  const runtime = {
    relay: null,
    relayResumeSessionId: 9,
    callRegistry: { finish(callId) { finished = callId; } },
    relayCallRecovery: {
      deliver(value) { delegated.push(["deliver", value.id]); return true; },
      reconcile(ids, cancel) { delegated.push(["reconcile", ids.join(","), typeof cancel]); },
      disconnected() { delegated.push(["disconnected"]); },
      ready() { delegated.push(["ready"]); },
    },
    cancelRelayCall() { return false; },
  };
  assert(LocalRuntime.prototype.send.call(runtime, { type: "noop" }) === false, "runtime send reported success without a relay");
  LocalRuntime.prototype.finishCall.call(runtime, "finished-call");
  assert(finished === "finished-call", "runtime finishCall did not delegate to the call registry");
  LocalRuntime.prototype.finishCall.call(runtime, "");
  assert(finished === "finished-call", "runtime finishCall mutated state for an empty call id");
  assert(LocalRuntime.prototype.deliverRelayToolResult.call(runtime, { id: "delegated-call" }) === true, "runtime did not delegate relay result delivery");
  LocalRuntime.prototype.reconcileRelayCalls.call(runtime, ["call_keep_12345678"]);
  LocalRuntime.prototype.handleRelayDisconnect.call(runtime);
  LocalRuntime.prototype.handleRelayReady.call(runtime);
  assert(runtime.relayResumeSessionId === 0, "runtime disconnect did not reset resume-session state");
  assert(JSON.stringify(delegated) === JSON.stringify([
    ["deliver", "delegated-call"],
    ["reconcile", "call_keep_12345678", "function"],
    ["disconnected"],
    ["ready"],
  ]), "runtime relay-recovery delegation drifted");
}

async function testRuntimeStartStopRace() {
  let rejectRelayStart;
  const lifecycle = new LifecycleController("test runtime");
  const runtime = {
    relay: { start: () => new Promise((_, reject) => { rejectRelayStart = reject; }) },
    lifecycle,
    policy: { profile: "agent" },
  };
  const starting = LocalRuntime.prototype.start.call(runtime);
  await Promise.resolve();
  assert(lifecycle.snapshot().state === "starting", "runtime start-stop fixture did not enter starting state");
  lifecycle.beginStop();
  lifecycle.markStopped();
  rejectRelayStart(new Error("relay stopped during startup"));
  await starting;
  assert(lifecycle.snapshot().state === "stopped", "a late relay-start rejection overwrote an already-stopped runtime lifecycle");
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


function testAutostartLogMaintenance() {
  let callback = null;
  let delay = 0;
  let unref = 0;
  let trims = 0;
  let failures = 0;
  const maintenance = startAutostartLogMaintenance("/state", {
    intervalMs: 1234,
    trim(root) {
      assert(root === "/state", "log maintenance changed its state root");
      trims += 1;
      if (trims === 2) throw new Error("synthetic trim failure");
    },
    onError() { failures += 1; },
    scheduler: {
      setInterval(fn, value) { callback = fn; delay = value; return { unref() { unref += 1; } }; },
    },
  });
  assert(maintenance.intervalMs === 1234 && delay === 1234 && unref === 1,
    "background log maintenance lost its bounded unreferenced schedule");
  callback();
  callback();
  assert(trims === 2 && failures === 1, "background log maintenance did not contain a trim failure");
}

async function testProcessExecutionNoShell() {
  const temp = mkdtempSync(join(tmpdir(), "mbm-process-execution-"));
  const marker = join(temp, "must-not-exist");
  const tracker = new ProcessTracker();
  const service = new ProcessExecutionService({
    workspace: temp,
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: temp,
    processTracker: tracker,
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled() {},
  });
  try {
    const payload = `$(touch ${marker}); echo injected`;
    const result = await service.run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", payload], PROCESS_FIXTURE_TIMEOUT_MS, false, 1024);
    assert(result.stdout === payload, "direct process execution changed an argv value through shell interpretation");
    assert(!existsSync(marker), "direct process execution evaluated shell syntax from argv");
    assert(tracker.snapshot().active_processes === 0, "direct process execution leaked process tracking state");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}


async function testForegroundTimeoutAlignment() {
  const temp = mkdtempSync(join(tmpdir(), "mbm-foreground-timeout-"));
  const observed = [];
  const service = new ProcessExecutionService({
    workspace: temp,
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: temp,
    processTracker: new ProcessTracker(),
    resolveExistingPath: async () => temp,
    resolveLocalCommand: async () => ({
      name: "long-command",
      argv: [process.execPath, "-e", ""],
      cwd: temp,
      timeoutSeconds: 600,
    }),
    displayPath: (value) => value,
    throwIfCancelled() {},
  });
  service.runPublic = async (_cmd, _args, timeoutMs, context) => {
    observed.push({ timeoutMs, origin: context.origin || "local" });
    return { code: 0, stdout: "", stderr: "", stdout_truncated_bytes: 0, stderr_truncated_bytes: 0 };
  };
  try {
    await service.runDirect({ argv: [process.execPath] }, { origin: "relay" });
    await service.runShell("printf ok", undefined, { origin: "relay" });
    const remoteRegistered = await service.runRegistered({}, { origin: "relay" });
    const remoteExplicit = await service.runRegistered({ timeout_seconds: 30 }, { origin: "relay" });
    let remoteOversized;
    try { await service.runRegistered({ timeout_seconds: 31 }, { origin: "relay" }); }
    catch (error) { remoteOversized = error; }
    const localRegistered = await service.runRegistered({}, { origin: "local" });
    assert(observed[0].timeoutMs === 20_000 && observed[1].timeoutMs === 20_000,
      "relay process and shell defaults drifted from the short foreground budget");
    assert(remoteRegistered.timeout_seconds === 20 && remoteExplicit.timeout_seconds === 30,
      "relay registered-command timeout did not honor the shared default and ceiling");
    assert(remoteOversized instanceof RangeError && remoteOversized.message.includes("1 to 30"),
      "relay registered command accepted an oversized foreground timeout");
    assert(localRegistered.timeout_seconds === 600,
      "local registered-command execution lost the owner manifest timeout");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testFixedInternalProcessBoundary() {
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4343;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "mbm-internal-process-"));
  const child = new ClosingChild();
  let spawnInvocation = null;
  const service = new ProcessExecutionService({
    workspace: temp,
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    policyForContext: () => ({ minimalEnv: false }),
    runtimeDir: temp,
    processTracker: new ProcessTracker(),
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled() {},
    spawnProcess: (cmd, args, options) => {
      spawnInvocation = { cmd, args, options };
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  try {
    const result = await service.runFixedInternal(
      "git",
      ["status", "--short"],
      5000,
      true,
      1024,
      { callId: "fixed-internal", authority: { principal: { kind: "account", role: "reviewer" } } },
      temp,
      null,
      { GIT_OPTIONAL_LOCKS: "0" },
    );
    assert(result.code === 0, "fixed internal process did not complete");
    assert(spawnInvocation?.cmd === "git" && spawnInvocation?.args?.[0] === "status", "fixed internal process was wrapped as delegated arbitrary execution");
    assert(spawnInvocation?.options?.shell === false, "fixed internal process enabled shell interpretation");
    assert(spawnInvocation?.options?.env?.HOME === join(temp, "home"), "fixed internal process did not use an isolated minimal environment");
    assert(spawnInvocation?.options?.env?.GIT_OPTIONAL_LOCKS === "0", "fixed internal process lost an approved implementation-owned environment override");
    await expectReject(
      () => service.runFixedInternal("git", ["status"], 5000, true, 1024, {}, temp, null, { NODE_OPTIONS: "--require=fixture" }),
      "invalid_request", "internal process environment override is not approved",
    );
    await expectReject(
      () => service.runFixedInternal("git", ["status"], 5000, true, 1024, {}, temp, null, { GIT_OPTIONAL_LOCKS: "1" }),
      "invalid_request", "internal process environment override is not approved",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testProcessExitFallbackSettlement() {
  class ExitOnlyChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4344;
      this.exitCode = null;
      this.signalCode = null;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
      this.unrefCount = 0;
    }
    unref() { this.unrefCount += 1; }
  }
  const child = new ExitOnlyChild();
  const tracker = new ProcessTracker();
  const service = new ProcessExecutionService({
    workspace: process.cwd(),
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: process.cwd(),
    processTracker: tracker,
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled() {},
    childSettlementOptions: { fallbackMs: 0 },
    spawnProcess: () => {
      queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); });
      return child;
    },
  });
  const result = await service.runFixedInternal(process.execPath, ["-e", ""], 5_000, false, 1024);
  assert(result.code === 0, "one-shot process exit fallback changed a successful exit result");
  assert(tracker.snapshot().active_processes === 0, "one-shot process exit fallback retained process ownership without close");
  assert(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed && child.unrefCount === 1,
    "one-shot process exit fallback did not close residual stdio handles before settlement");
}

async function testProcessCancellationSettlesBeforeClose() {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4242;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }
  }
  const child = new NeverClosingChild();
  let terminated = 0;
  let spawnInvocation = null;
  const tracker = new ProcessTracker({ terminateWithEscalation() { terminated += 1; } });
  const service = new ProcessExecutionService({
    workspace: process.cwd(),
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: process.cwd(),
    processTracker: tracker,
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled(context) { if (context.signal?.aborted) throw context.signal.reason; },
    spawnProcess: (cmd, args, options) => {
      spawnInvocation = { cmd, args, options };
      return child;
    },
    terminateProcess: () => { terminated += 1; return null; },
  });
  const controller = new AbortController();
  const running = service.run("never", [], 60_000, false, 1024, { callId: "stuck", signal: controller.signal });
  assert(spawnInvocation?.options?.shell === false, "direct process execution did not explicitly disable shell interpretation");
  controller.abort(new BridgeError("cancelled", "relay disconnected"));
  const cancellation = await expectReject(() => Promise.race([running, new Promise((_, reject) => { setTimeout(() => reject(new Error("cancellation did not settle")), 100); })]), "cancelled", "relay disconnected");
  assert(cancellation.retryable === false && cancellation.details?.side_effects_started === true
    && cancellation.details?.termination_requested === true && cancellation.details?.effect_settlement === "pending",
  "cancelled process implied its already-started side effects had settled or were safe to retry");
  assert(terminated === 1, "cancelled process was not terminated");
  assert(tracker.snapshot().active_processes === 1, "process tracker released a child before close");
  child.emit("close", null);
  assert(tracker.snapshot().active_processes === 0, "process tracker retained child after close");

  const deadlineChild = new NeverClosingChild();
  service.spawnProcess = () => deadlineChild;
  const deadlineController = new AbortController();
  const deadlineRun = service.run("never", [], 60_000, false, 1024, { callId: "deadline", signal: deadlineController.signal });
  deadlineController.abort(new BridgeError("timeout", "tool call timed out"));
  const deadline = await expectReject(() => deadlineRun, "timeout", "tool call timed out");
  assert(deadline.retryable === false && deadline.details?.effect_settlement === "pending",
    "registry deadline lost its timeout code or became safe to retry after process dispatch");
  deadlineChild.emit("close", null);
}

async function testProcessErrorRetainsOwnershipUntilClose() {
  class ErrorThenCloseChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4_242_425;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
    }
  }
  const child = new ErrorThenCloseChild();
  let releases = 0;
  const tracker = new ProcessTracker();
  const service = new ProcessExecutionService({
    workspace: process.cwd(), policy: { minimalEnv: false }, policyGate: { assert() {} }, runtimeDir: process.cwd(),
    processTracker: tracker,
    resourceCoordinator: { acquire: async () => ({ async bindProcess() { return this; }, async release() { releases += 1; return true; } }) },
    resolveExistingPath: async (value) => value, resolveLocalCommand: async () => ({}), displayPath: (value) => value,
    throwIfCancelled() {}, spawnProcess: () => child,
  });
  const running = service.run("synthetic-child", [], 60_000, false, 1024, { callId: "error-before-close" });
  for (let attempt = 0; attempt < 20 && child.listenerCount("error") === 0; attempt += 1) {
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  }
  assert(child.listenerCount("error") > 0, "child error fixture never reached process ownership registration");
  child.emit("error", new Error("synthetic child error before close"));
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(tracker.snapshot().active_processes === 1 && releases === 0,
    "child error released process ownership or resources before close");
  child.emit("close", null);
  let childFailure = null;
  try { await running; } catch (error) { childFailure = error; }
  assert(childFailure?.message === "synthetic child error before close", "child error changed meaning while ownership was retained");
  assert(tracker.snapshot().active_processes === 0 && releases === 1,
    "child close did not release retained process ownership exactly once after an error");
}

async function testRunExecutableErrorWaitsForClose() {
  class ErrorThenCloseChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4_242_426;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }
  const child = new ErrorThenCloseChild();
  let settled = false;
  const running = runExecutable("synthetic-internal", [], {
    capture: true, timeoutMs: 60_000,
    spawnProcess(_command, _args, options) {
      assert(options.shell === false && options.detached === (process.platform !== "win32"),
        "runExecutable test seam changed the fixed production spawn boundary");
      return child;
    },
  }).finally(() => { settled = true; });
  child.emit("error", new Error("synthetic internal child error before close"));
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(settled === false, "runExecutable settled directly from child error before close");
  child.emit("close", null);
  let failure = null;
  try { await running; } catch (error) { failure = error; }
  assert(failure?.message === "synthetic internal child error before close" && settled === true,
    "runExecutable did not preserve the child error until close settlement");
}

async function testRunExecutableHardTimeoutWaitsForTreeSettlement() {
  class TimeoutChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4_242_427;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }
  const child = new TimeoutChild();
  let releaseTree;
  const treeBarrier = new Promise((resolvePromise) => { releaseTree = resolvePromise; });
  let settled = false;
  const running = runExecutable("synthetic-hard-timeout", [], {
    capture: true, allowFailure: true, hardTimeout: true, timeoutMs: 1,
    spawnProcess: () => child,
    terminateTreeAndWait: () => treeBarrier,
  }).finally(() => { settled = true; });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  child.emit("close", null);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(settled === false, "hard-timeout runExecutable settled from direct child close before tree termination proof");
  releaseTree(true);
  const result = await running;
  assert(result.code === 124 && result.timed_out === true && result.termination_settled === true,
    "hard-timeout runExecutable lost explicit whole-tree settlement evidence");
}

async function testProcessTimeoutIsNotSafeToRetry() {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4_242_424;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
    }
  }
  const child = new NeverClosingChild();
  let terminated = 0;
  const tracker = new ProcessTracker();
  const service = new ProcessExecutionService({
    workspace: process.cwd(),
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: process.cwd(),
    processTracker: tracker,
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled() {},
    spawnProcess: () => child,
    terminateProcess: () => { terminated += 1; return null; },
  });
  let timeoutError = null;
  try { await service.run("never", [], 10, false, 1024, { callId: "timeout-ambiguous" }); }
  catch (error) { timeoutError = error; }
  assert(timeoutError instanceof BridgeError && timeoutError.code === "timeout", "process timeout did not retain its stable error code");
  assert(timeoutError.retryable === false, "process timeout advertised an ambiguous started side effect as safely retryable");
  assert(timeoutError.details?.side_effects_started === true
    && timeoutError.details?.termination_requested === true
    && timeoutError.details?.effect_settlement === "pending",
  "process timeout omitted its pending side-effect settlement metadata");
  assert(terminated === 1 && tracker.snapshot().active_processes === 1,
    "process timeout test did not preserve the intended fast-return/background-termination contract");
  child.emit("close", null);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(tracker.snapshot().active_processes === 0, "timed-out process remained tracked after close");
}

async function testProcessTracker() {
  const terminations = [];
  const escalations = [];
  const tracker = new ProcessTracker({
    terminate(child, signal) { terminations.push({ child, signal }); },
    terminateWithEscalation(child) { escalations.push(child); },
  });
  const first = { pid: 101 };
  const second = { pid: 102 };
  const unowned = { pid: 103 };
  tracker.track(null, "ignored");
  tracker.track(first, "call");
  tracker.track(second, "call");
  tracker.track(unowned);
  assert(tracker.snapshot().active_processes === 3 && tracker.snapshot().calls_with_processes === 1, "process tracker did not register child ownership");

  assert(tracker.terminateCall("call") === 2 && escalations.length === 2, "graceful call termination did not escalate owned children");
  assert(tracker.terminateCall("call", { force: true }) === 2, "forced call termination lost owned children");
  assert(terminations.length === 2 && terminations.every((entry) => entry.signal === "SIGKILL"), "forced call termination did not use SIGKILL");
  assert(tracker.terminateCall("missing") === 0, "missing call reported terminated children");

  tracker.terminateAll("SIGTERM", true);
  assert(escalations.length === 5, "terminateAll escalation did not cover every active child");
  tracker.terminateAll("SIGKILL", true);
  assert(terminations.slice(-3).every((entry) => entry.signal === "SIGKILL"), "SIGKILL terminateAll incorrectly used escalation");
  tracker.terminateAll("SIGTERM", false);
  assert(terminations.slice(-3).every((entry) => entry.signal === "SIGTERM"), "non-escalating terminateAll changed the signal");

  tracker.releaseCall("call");
  tracker.releaseCall("");
  assert(tracker.snapshot().active_processes === 3
    && tracker.snapshot().calls_with_processes === 0
    && tracker.snapshot().draining_calls === 1
    && tracker.snapshot().draining_processes === 2,
  "call completion lost draining process ownership");
  tracker.untrack(first);
  tracker.untrack(second);
  tracker.untrack(unowned);
  tracker.untrack(null);
  assert(tracker.snapshot().active_processes === 0, "process tracker did not release children");

  const clearedTimers = [];
  let scheduledCount = 0;
  let terminationSettled = null;
  const timerTracker = new ProcessTracker({
    terminate() {},
    terminateWithEscalation(_child, options) { scheduledCount += 1; terminationSettled = options.onTerminationSettled; return "timer-" + scheduledCount; },
    clearScheduledTermination(timer) { clearedTimers.push(timer); },
  });
  const timedChild = { pid: 201 };
  timerTracker.track(timedChild, "timed");
  timerTracker.terminateCall("timed");
  timerTracker.terminateCall("timed");
  assert(scheduledCount === 1, "process tracker scheduled duplicate escalation timers");
  timerTracker.untrack(timedChild);
  assert(clearedTimers.length === 0, "process tracker cancelled descendant escalation when the parent closed");
  assert(timerTracker.snapshot().termination_escalations_pending === 1,
    "process tracker hid a pending descendant escalation after parent close");
  terminationSettled();
  timerTracker.track(timedChild, "timed-again");
  timerTracker.terminateCall("timed-again");
  assert(scheduledCount === 2, "settled process escalation was not released from the tracker");

  const drainTerminations = [];
  const drainTracker = new ProcessTracker({
    terminate(child, signal) { drainTerminations.push({ child, signal }); return true; },
  });
  const drainingChild = { pid: 301 };
  drainTracker.track(drainingChild, "drain");
  const drained = drainTracker.drain("SIGKILL", 100);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  assert(drainTerminations.length === 1 && drainTerminations[0].signal === "SIGKILL",
    "process tracker drain did not request forced termination");
  drainTracker.untrack(drainingChild);
  await drained;
  const lateChild = { pid: 302 };
  drainTracker.track(lateChild, "late-during-drain");
  assert(drainTerminations.length === 2 && drainTerminations[1].child === lateChild,
    "process tracker allowed a new child to escape after runtime drain began");
  drainTracker.untrack(lateChild);

  let stalledDrainRequests = 0;
  const stalledDrainTracker = new ProcessTracker({ terminate() { stalledDrainRequests += 1; return true; } });
  const stalledDrainChild = { pid: 303 };
  stalledDrainTracker.track(stalledDrainChild, "stalled-drain");
  await expectReject(() => stalledDrainTracker.drain("SIGKILL", 20), "unavailable", "process shutdown did not settle");
  assert(stalledDrainTracker.snapshot().active_processes === 1,
    "failed process drain discarded the only retained ownership handle");
  const retriedDrain = stalledDrainTracker.drain("SIGKILL", 100);
  assert(stalledDrainRequests === 2, "failed process drain permanently suppressed a later termination retry");
  stalledDrainTracker.untrack(stalledDrainChild);
  await retriedDrain;
  timerTracker.terminateCall("timed-again", { force: true });
  assert(clearedTimers.join(",") === "timer-2", "forced process termination did not clear the pending escalation timer");
}


async function testProcessTreeSupervisor() {
  const signals = [];
  let scheduled = null;
  let escalated = false;
  const child = { pid: 4242, kill(signal) { signals.push(["child", signal]); return true; } };
  const ordering = [];
  const timer = terminateProcessTreeWithEscalation(child, {
    graceMs: 25,
    captureOwnership: () => { ordering.push("capture-started"); return { synthetic: true }; },
    isTerminationTargetOwned: () => true,
    terminate(_child, signal) { ordering.push(signal); signals.push(["tree", signal]); },
    setTimeout(callback, delay) { scheduled = { callback, delay }; return "termination-timer"; },
    onEscalated() { escalated = true; },
  });
  assert(timer === "termination-timer", "process-tree escalation did not return the scheduler handle");
  assert(ordering.slice(0, 2).join(",") === "capture-started,SIGTERM",
    "process ownership capture did not start before graceful termination");
  assert(signals.length === 1 && signals[0][1] === "SIGTERM", "process-tree escalation did not begin gracefully");
  assert(scheduled?.delay === 25, "process-tree escalation lost the configured grace period");
  await scheduled.callback();
  assert(signals.length === 2 && signals[1][1] === "SIGKILL" && escalated, "process-tree escalation did not force termination after the grace period");

  let boundedCallback = null;
  const boundedPrecheckTimeouts = [];
  let boundedPrecheckKills = 0;
  terminateProcessTreeWithEscalation({ pid: 4292 }, {
    graceMs: 0,
    ownershipCheckBudgetMs: 90,
    monotonicNow: () => 0,
    captureOwnership(_child, phaseOptions) {
      boundedPrecheckTimeouts.push(phaseOptions.processSnapshotTimeoutMs);
      return { pid: 4292 };
    },
    refreshOwnership(value, phaseOptions) {
      boundedPrecheckTimeouts.push(phaseOptions.processSnapshotTimeoutMs);
      return value;
    },
    isTerminationTargetOwned: () => true,
    terminate(_child, signal) { if (signal === "SIGKILL") boundedPrecheckKills += 1; },
    setTimeout(callback) { boundedCallback = callback; return "bounded-precheck-timer"; },
  });
  await boundedCallback();
  assert(boundedPrecheckKills === 1 && boundedPrecheckTimeouts.length === 2
    && boundedPrecheckTimeouts.every((value) => value > 0)
    && boundedPrecheckTimeouts.reduce((sum, value) => sum + value, 0) <= 90,
  `process-tree capture/refresh exceeded their shared ownership budget: ${boundedPrecheckTimeouts.join(",")}`);

  let expiredCallback = null;
  let expiredRefreshes = 0;
  let expiredKills = 0;
  let precheckNow = 0;
  terminateProcessTreeWithEscalation({ pid: 4293 }, {
    graceMs: 0,
    ownershipCheckBudgetMs: 20,
    monotonicNow: () => precheckNow,
    captureOwnership() { precheckNow = 21; return { pid: 4293 }; },
    refreshOwnership(value) { expiredRefreshes += 1; return value; },
    isTerminationTargetOwned: () => true,
    terminate(_child, signal) { if (signal === "SIGKILL") expiredKills += 1; },
    setTimeout(callback) { expiredCallback = callback; return "expired-precheck-timer"; },
  });
  await expiredCallback();
  assert(expiredRefreshes === 0 && expiredKills === 0,
    "expired pre-escalation ownership budget refreshed or forced an unverified process tree");

  let exitedCallback = null;
  let exitedSignals = 0;
  const exitedChild = { pid: 4343, exitCode: null, signalCode: null };
  terminateProcessTreeWithEscalation(exitedChild, {
    captureOwnership: () => ({ synthetic: true }),
    isTerminationTargetOwned: (_ownership, currentChild) => currentChild.exitCode === null,
    terminate(_child, signal) { if (signal === "SIGKILL") exitedSignals += 1; },
    setTimeout(callback) { exitedCallback = callback; return "exited-timer"; },
  });
  exitedChild.exitCode = 0;
  await exitedCallback();
  assert(exitedSignals === 0, "process-tree escalation signalled a child after it had exited");

  let failedCallback = null;
  let failedSettled = 0;
  let failedKills = 0;
  terminateProcessTreeWithEscalation({ pid: 4444 }, {
    captureOwnership: () => ({ synthetic: true }),
    isTerminationTargetOwned() { throw new Error("synthetic ownership failure"); },
    terminate(_child, signal) { if (signal === "SIGKILL") failedKills += 1; },
    setTimeout(callback) { failedCallback = callback; return "failed-timer"; },
    onTerminationSettled() { failedSettled += 1; throw new Error("synthetic settlement callback failure"); },
  });
  await failedCallback();
  assert(failedKills === 0 && failedSettled === 1,
    "process-tree supervision did not fail closed and settle after an ownership-check exception");

  let signalFailureCallback = null;
  let signalFailureSettled = 0;
  terminateProcessTreeWithEscalation({ pid: 4545 }, {
    captureOwnership: () => ({ synthetic: true }),
    isTerminationTargetOwned: () => true,
    terminate(_child, signal) { if (signal === "SIGKILL") throw new Error("synthetic signal failure"); },
    setTimeout(callback) { signalFailureCallback = callback; return "signal-failure-timer"; },
    onTerminationSettled() { signalFailureSettled += 1; },
  });
  await signalFailureCallback();
  assert(signalFailureSettled === 1,
    "process-tree supervision lost settlement after a forced-signal exception");

  const taskkillCalls = [];
  const killer = new EventEmitter();
  killer.unrefCalled = false;
  killer.unref = () => { killer.unrefCalled = true; };
  const spawnProcess = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    return killer;
  };
  assert(terminateProcessTree(child, "SIGTERM", { platform: "win32", spawnProcess }), "Windows graceful tree termination was not requested");
  assert(!taskkillCalls[0].args.includes("/F") && taskkillCalls[0].options.shell === false, "Windows graceful tree termination forced or enabled a shell");
  assert(terminateProcessTree(child, "SIGKILL", { platform: "win32", spawnProcess }), "Windows forced tree termination was not requested");
  assert(taskkillCalls[1].args.includes("/F") && killer.unrefCalled, "Windows forced tree termination omitted /F or retained the helper process");
  killer.emit("error", new Error("taskkill unavailable"));
  assert(signals.some(([kind, signal]) => kind === "child" && signal === "SIGTERM"), "asynchronous taskkill failure was unhandled or did not fall back to ChildProcess.kill");

  const snapshotRows = [
    { pid: 4242, pgid: 4242, startedAt: Date.parse("2026-07-22T00:00:00Z") },
    { pid: 4243, pgid: 4242, startedAt: Date.parse("2026-07-22T00:00:01Z") },
  ];
  const darwinQueries = [];
  const darwinCommands = [];
  const darwinEnvironments = [];
  const darwinOwnership = await captureProcessTreeOwnership(child, {
    platform: "darwin",
    execFileProcess(command, args, processOptions) {
      darwinCommands.push(command);
      darwinQueries.push(args);
      darwinEnvironments.push(processOptions.env);
      return { status: 0, stdout: " 4242  4242 Tue Jul 22 00:00:00 2026\n 4243  4242 Tue Jul 22 00:00:01 2026\n" };
    },
  });
  assert(darwinOwnership.members.length === 2
    && darwinQueries[0]?.[0] === "-g" && darwinQueries[0]?.[1] === "4242"
    && !darwinQueries[0]?.includes("-axo"),
  "macOS process ownership capture scanned the full process table instead of the target process group");
  assert(darwinCommands[0] === "ps"
    && Object.keys(darwinEnvironments[0]).sort().join(",") === "LANG,LC_ALL,PATH"
    && darwinEnvironments[0].PATH === "/usr/bin:/bin",
  "process ownership snapshot did not use a fixed minimal command environment");

  const ownership = await captureProcessTreeOwnership(child, { platform: "linux", listProcessGroups: () => snapshotRows });
  assert(ownership.members.length === 2, "process group snapshot omitted a descendant");
  assert(await processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, { listProcessGroups: () => [snapshotRows[1]] }), "surviving original descendant did not preserve process-group ownership");
  assert(!await processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, { listProcessGroups: () => [{ pid: 4243, pgid: 4242, startedAt: Date.parse("2026-07-22T00:01:00Z") }] }), "PID-reused process group was accepted for escalation");
  assert(!await processTreeOwnershipStillCurrent({ platform: "linux", pid: 4242, members: [] }, { ...child, exitCode: 0 }, { listProcessGroups: () => [] }), "empty ownership snapshot ignored parent exit");
  assert(!await processTreeOwnershipStillCurrent({ platform: "linux", pid: 4242, members: [] }, child, { listProcessGroups: () => snapshotRows }), "empty ownership snapshot authorized forced termination without process identity");
  assert(!await processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, {
    listProcessGroups: () => [{ ...snapshotRows[0], startedAt: snapshotRows[0].startedAt + 1000 }],
  }), "adjacent-second PID reuse was accepted as the captured process identity");
  const refreshed = await refreshProcessTreeOwnership(
    { platform: "linux", pid: 4242, members: [snapshotRows[0]] },
    { listProcessGroups: () => snapshotRows },
  );
  assert(refreshed.members.length === 2, "post-SIGTERM ownership refresh did not capture a surviving descendant");
  let ownershipQueries = 0;
  assert(await processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    listProcessGroups(_options, pid) {
      ownershipQueries += 1;
      return pid === 4243 ? [snapshotRows[1]] : [];
    },
  }), "targeted ownership fallback lost a captured descendant when the full process table was unavailable");
  assert(ownershipQueries > 1, "targeted ownership fallback was not exercised");

  const boundedTimeouts = [];
  const boundedKillSignals = [];
  assert(!await processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    ownershipCheckBudgetMs: 90,
    monotonicNow: () => 0,
    execFileProcess(_command, _args, processOptions) {
      boundedTimeouts.push(processOptions.timeout);
      boundedKillSignals.push(processOptions.killSignal);
      return { status: 1, stdout: "" };
    },
  }), "failed process snapshots were treated as current ownership");
  assert(boundedTimeouts.length === 3 && boundedTimeouts.every((value) => value > 0)
    && boundedTimeouts.reduce((sum, value) => sum + value, 0) <= 90,
  `targeted ownership fallback exceeded its global budget: ${boundedTimeouts.join(",")}`);
  assert(boundedKillSignals.every((value) => value === "SIGKILL"),
    "bounded process snapshots did not request hard asynchronous termination");

  let expiredSnapshotCalls = 0;
  let clockSample = 0;
  assert(!await processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    ownershipCheckBudgetMs: 1,
    monotonicNow: () => clockSample++ === 0 ? 0 : 2,
    execFileProcess() { expiredSnapshotCalls += 1; return { status: 0, stdout: "" }; },
  }), "expired process ownership budget was treated as current ownership");
  assert(expiredSnapshotCalls === 0, "expired process ownership budget invoked an unbounded timeout-zero process snapshot");

  const groupSignals = [];
  assert(terminateProcessTree(child, "SIGTERM", {
    platform: "linux",
    killProcess(pid, signal) { groupSignals.push({ pid, signal }); },
  }), "POSIX process-group termination was not requested");
  assert(groupSignals[0].pid === -child.pid && groupSignals[0].signal === "SIGTERM", "POSIX termination did not target the child process group");

  const forceKiller = new EventEmitter();
  let forceKillSettled = false;
  const windowsForceBarrier = terminateProcessTreeAndWait(child, "SIGKILL", {
    platform: "win32",
    spawnProcess(command, args, options) {
      assert(command === "taskkill.exe" && args.includes("/T") && args.includes("/F") && options.shell === false,
        "Windows hard tree barrier did not use forced taskkill tree semantics");
      return forceKiller;
    },
  }).then((value) => { forceKillSettled = value; return value; });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(forceKillSettled === false, "Windows hard tree barrier settled before taskkill helper completion");
  forceKiller.emit("close", 0);
  assert(await windowsForceBarrier, "Windows hard tree barrier did not accept successful taskkill completion");
}

async function testChildProcessSettlement() {
  const direct = [];
  const closeGuard = createChildProcessSettlement({ onSettle: (...args) => direct.push(args) });
  assert(closeGuard.onClose(0, null) && !closeGuard.onExit(0, null), "direct child close did not settle exactly once");
  assert(direct.length === 1 && direct[0][2] === "close", "direct child close used the wrong settlement source");

  let scheduled = null;
  let cleared = null;
  let fallbackCount = 0;
  const fallback = [];
  const exitGuard = createChildProcessSettlement({
    fallbackMs: 25,
    schedule(callback, delay) { scheduled = { callback, delay }; return "exit-fallback"; },
    clearSchedule(timer) { cleared = timer; },
    onFallback() { fallbackCount += 1; },
    onSettle: (...args) => fallback.push(args),
  });
  assert(exitGuard.onExit(7, "SIGTERM") && scheduled?.delay === 25, "child exit did not schedule bounded close fallback");
  scheduled.callback();
  assert(fallbackCount === 1 && fallback.length === 1 && fallback[0][0] === 7
    && fallback[0][1] === "SIGTERM" && fallback[0][2] === "exit_fallback",
  "child exit fallback did not preserve terminal identity");

  scheduled = null;
  const refreshed = [];
  let refreshedState = { code: null, signal: null };
  const refreshGuard = createChildProcessSettlement({
    schedule(callback) { scheduled = { callback }; return "refresh-timer"; },
    readExitState() { return refreshedState; },
    onSettle: (...args) => refreshed.push(args),
  });
  refreshGuard.onExit(null, null);
  refreshedState = { code: 0, signal: null };
  scheduled.callback();
  assert(refreshed.length === 1 && refreshed[0][0] === 0 && refreshed[0][2] === "exit_fallback",
    "child exit fallback did not refresh a delayed terminal code");

  assert(childExitedBeforeTimeout({ processState: "zombie" }), "zombie child was not recognized as already exited");
  assert(childExitedBeforeTimeout({ exitCode: 0 }), "known child exit code was not recognized before timeout");
  assert(!childExitedBeforeTimeout({ processState: "running" }), "running child bypassed timeout termination");

  if (process.platform !== "win32") {
    const marker = join(tmpdir(), `mbm-zombie-child-${process.pid}`);
    const child = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    child.stdin.end();
    const terminal = new Promise((resolvePromise) => { child.once("close", resolvePromise); });
    const deadline = Date.now() + PROCESS_FIXTURE_TIMEOUT_MS;
    let observed = "unknown";
    while (Date.now() < deadline) {
      if (existsSync(marker)) observed = processState(child.pid);
      if (observed === "zombie") break;
    }
    assert(observed === "zombie", `completed child was not observable as zombie before event drain: ${observed}`);
    assert(childExitedBeforeTimeout({ exitCode: child.exitCode, signalCode: child.signalCode, processState: observed }),
      "zombie child would have been misclassified as timed out");
    await terminal;
    rmSync(marker, { force: true });
  }

  scheduled = null;
  const raced = [];
  const raceGuard = createChildProcessSettlement({
    schedule(callback) { scheduled = { callback }; return "race-timer"; },
    clearSchedule(timer) { cleared = timer; },
    onSettle: (...args) => raced.push(args),
  });
  raceGuard.onExit(1, null);
  assert(raceGuard.onClose(0, null) && cleared === "race-timer", "close did not cancel the pending exit fallback");
  scheduled.callback();
  assert(raced.length === 1 && raced[0][0] === 0 && raced[0][2] === "close", "late exit fallback settled a closed child twice");
  assert(!raceGuard.cancel(), "settled child guard accepted cancellation");
  let missingSettle;
  try { createChildProcessSettlement({}); } catch (error) { missingSettle = error; }
  assert(missingSettle?.message.includes("requires onSettle"), "child settlement accepted a missing callback");
  let invalidDelay;
  try { createChildProcessSettlement({ onSettle() {}, fallbackMs: -1 }); } catch (error) { invalidDelay = error; }
  assert(invalidDelay?.message.includes("between 0 and 10000"), "child settlement accepted an invalid fallback delay");
}

function testHardSpawnSyncTimeout() {
  const script = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  const started = performance.now();
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8", timeout: 100, killSignal: "SIGKILL", windowsHide: true,
  });
  const elapsed = performance.now() - started;
  assert(result.error?.code === "ETIMEDOUT" && result.signal === "SIGKILL",
    "hard synchronous timeout did not force the uncooperative child");
  assert(elapsed < 1500, `hard synchronous timeout remained blocked for ${elapsed} ms`);
}

function testSecurityAuditWarningRateLimit() {
  let now = 1000;
  const events = [];
  const reporter = createSecurityAuditFailureReporter({
    event(level, event, fields, message) { events.push({ level, event, fields, message }); },
  }, { now: () => now, intervalMs: 100 });
  assert(reporter.report("security.audit.persist.failed", { tool: "read_file" }, "failed"),
    "first security-audit warning was suppressed");
  assert(!reporter.report("security.audit.persist.failed", { tool: "git_status" }, "failed"),
    "duplicate security-audit warning was not suppressed");
  now += 100;
  assert(reporter.report("security.audit.persist.failed", { tool: "server_info" }, "failed"),
    "security-audit warning did not resume after its interval");
  assert(events.length === 2 && events[1].fields.suppressed === 1,
    "security-audit warning did not report its suppressed duplicate count");
}

function testExecutionGuardrails() {
  const guardrails = executionGuardrailsSnapshot();
  assert(guardrails.tool_calls.maximum_concurrent === 16
    && guardrails.tool_calls.ordinary_capacity === 14
    && guardrails.tool_calls.reserved_control_capacity === 2
    && guardrails.tool_calls.reserved_control_tools.join(",") === "diagnose_runtime,list_roots",
  "tool-call concurrency or bounded control-plane reservation drifted from the shared contract");
  assert(guardrails.process_sessions.maximum_concurrent === 8, "process-session limit is not reported from the shared contract");
  assert(guardrails.one_shot_processes.process_tree_termination === "sigterm-then-sigkill", "process cleanup contract is not observable");
  assert(guardrails.operating_system_enforcement.cpu_quota === "not-enforced"
    && guardrails.operating_system_enforcement.memory_quota === "not-enforced"
    && guardrails.operating_system_enforcement.network_isolation === "not-enforced",
  "portable guardrails misrepresented OS resource or network isolation as enforced");
}

function testErrors() {
  assert(boundedProcessErrorMessage(new Error("bad\u001b[31m\r\nvalue\u0000"))
      .split("").every((character) => !/[\u0000-\u001f\u007f-\u009f]/.test(character)),
    "bounded process error normalization retained terminal/control characters");
  assert(boundedProcessErrorMessage({ toString() { throw new Error("synthetic conversion failure"); } }, "safe fallback") === "safe fallback",
    "bounded process error normalization propagated a hostile toString failure");
  assert(boundedProcessErrorMessage(new Error("x".repeat(5000))).length === 4096,
    "bounded process error normalization exceeded its public message ceiling");
  assert(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })) === "not_found", "Node error code classification failed");
  assert(errorCode(new Error("something timed out")) === "execution_failed", "untyped messages must not be reclassified heuristically");
  const publicValue = publicError(new BridgeError("network_error", "network unavailable"));
  assert(publicValue.code === "network_error" && publicValue.retryable === true, "public error lost retryability");
  const hidden = publicError(new BridgeError("internal_error", "private", { expose: false, details: { secret: "must-not-leak" } }));
  assert(!hidden.details && hidden.message === "internal error", "non-exposed error leaked structured details");
  const rawUnknown = publicError(new Error("private path /Users/private-user and token secret"));
  assert(rawUnknown.message === "operation failed" && !rawUnknown.message.includes("private-user"), "unknown exception text was exposed remotely");
  const explicitlySafe = publicError(new Error("safe\nmessage"), { expose: true, safeMessage: "safe\nmessage" });
  assert(explicitlySafe.message === "safe message", "public error message retained unsafe controls");
  const cyclicDetails = {}; cyclicDetails.self = cyclicDetails;
  const cyclicPublic = publicError(new BridgeError("execution_failed", "bounded", { details: cyclicDetails }));
  assert(!cyclicPublic.details && cyclicPublic.message === "bounded", "cyclic public error details were not omitted");
  const hugePublic = publicError(new BridgeError("execution_failed", "bounded", { details: { data: "x".repeat(600 * 1024) } }));
  assert(!hugePublic.details, "oversized public error details were not omitted");
}

function testWorkspaceShellSelection() {
  const previous = process.env.MBM_EXEC_SHELL;
  process.env.MBM_EXEC_SHELL = "/tmp/untrusted-shell";
  try {
    const shell = workspaceShellCommand("echo ok");
    assert(shell.cmd !== "/tmp/untrusted-shell", "workspace shell trusted an environment-provided executable path");
  } finally {
    if (previous === undefined) delete process.env.MBM_EXEC_SHELL;
    else process.env.MBM_EXEC_SHELL = previous;
  }
}

function testBoundedOutput() {
  const output = new BoundedOutput(12, { headBytes: 5 });
  output.append("BEGIN-");
  output.append("middle-middle-");
  output.append("-END");
  const text = output.text();
  assert(text.startsWith("BEGIN"), "bounded output lost the beginning");
  assert(text.endsWith("le--END"), "bounded output lost the diagnostic tail");
  assert(text.includes("preserved beginning and end"), "bounded output omitted truncation semantics");
  assert(output.truncatedBytes > 0, "bounded output did not count omitted bytes");

  const unicode = new BoundedOutput(10, { headBytes: 5 });
  unicode.append("甲乙丙丁戊");
  const unicodeText = unicode.text();
  assert(!unicodeText.includes("�"), "bounded output split a UTF-8 code point at a head/tail boundary");
  assert(unicodeText.startsWith("甲") && unicodeText.endsWith("戊"), "bounded output lost valid UTF-8 boundary text");
  assert(unicode.truncatedBytes === 9, "bounded output did not count UTF-8 boundary bytes omitted from text");
}

async function expectReject(operation, code, message) {
  try { await operation(); } catch (error) {
    assert(error instanceof BridgeError, "tool executor leaked an untyped error");
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    assert(error.message.includes(message), `expected message containing ${message}`);
    return error;
  }
  throw new Error(`expected rejection ${code}`);
}
function expectBridgeError(operation, code) {
  try { operation(); } catch (error) { assert(error instanceof BridgeError && error.code === code, `expected BridgeError ${code}`); return; }
  throw new Error(`expected BridgeError ${code}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function testFileMutationCoordinator() {
  const coordinator = new FileMutationCoordinator();
  const root = join(tmpdir(), "mbm-file-mutation-coordinator");
  const firstPath = join(root, "first.txt");
  const secondPath = join(root, "second.txt");
  const thirdPath = join(root, "third.txt");
  for (const [paths, callback, label] of [
    [null, async () => {}, "non-array paths"],
    [[], async () => {}, "empty paths"],
    [[firstPath], null, "missing callback"],
    [["relative.txt"], async () => {}, "relative path"],
    [[""], async () => {}, "empty path"],
    [[`${firstPath}\0suffix`], async () => {}, "NUL path"],
  ]) {
    let invalidError;
    try { await coordinator.withPaths(paths, callback); } catch (error) { invalidError = error; }
    assert(invalidError instanceof TypeError, `file mutation coordinator accepted ${label}`);
  }
  const samePathOrder = [];
  const sameStarted = deferred();
  const sameRelease = deferred();
  let secondSameStarted = false;
  const firstSame = coordinator.withPaths([firstPath], async () => {
    samePathOrder.push("first:start");
    sameStarted.resolve();
    await sameRelease.promise;
    samePathOrder.push("first:end");
  });
  await sameStarted.promise;
  const secondSame = coordinator.withPaths([firstPath], async () => {
    secondSameStarted = true;
    samePathOrder.push("second:start");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert(!secondSameStarted, "same-path file mutations overlapped");
  sameRelease.resolve();
  await Promise.all([firstSame, secondSame]);
  assert(samePathOrder.join(",") === "first:start,first:end,second:start", "same-path file mutation order changed");

  const unrelatedStarted = deferred();
  const unrelatedRelease = deferred();
  const held = coordinator.withPaths([firstPath], async () => {
    unrelatedStarted.resolve();
    await unrelatedRelease.promise;
  });
  await unrelatedStarted.promise;
  let secondPathStarted = false;
  const unrelated = coordinator.withPaths([secondPath], async () => { secondPathStarted = true; });
  await unrelated;
  assert(secondPathStarted, "unrelated file mutation was serialized behind another path");
  unrelatedRelease.resolve();
  await held;

  const multiStarted = deferred();
  const multiRelease = deferred();
  const multi = coordinator.withPaths([firstPath, secondPath, firstPath], async () => {
    multiStarted.resolve();
    await multiRelease.promise;
  });
  await multiStarted.promise;
  let overlapStarted = false;
  const overlap = coordinator.withPaths([secondPath], async () => { overlapStarted = true; });
  let thirdStarted = false;
  await coordinator.withPaths([thirdPath], async () => { thirdStarted = true; });
  await Promise.resolve();
  assert(thirdStarted, "multi-path reservation blocked an unrelated path");
  assert(!overlapStarted, "multi-path reservation did not retain every conflicting path");
  multiRelease.resolve();
  await Promise.all([multi, overlap]);
  assert(overlapStarted, "overlapping mutation never resumed after multi-path release");

  let failed = false;
  try { await coordinator.withPaths([firstPath], async () => { throw new Error("expected mutation failure"); }); }
  catch (error) { failed = error?.message === "expected mutation failure"; }
  assert(failed, "mutation coordinator swallowed a callback failure");
  let afterFailure = false;
  await coordinator.withPaths([firstPath], async () => { afterFailure = true; });
  assert(afterFailure, "failed file mutation leaked its path reservation");
}

function testRuntimeInfoProjection() {
  const full = { name: "fixture", policy: { profile: "custom" }, tool_delivery: { daemon_advertised_tool_count: 7 }, runtime: {} };
  assert(projectRuntimeInfo(full, "full") === full, "full local server_info projection stopped preserving the canonical object");
  const summary = projectRuntimeInfo({
    name: "fixture",
    protocol_version: "test",
    workspace: ".",
    workspace_name: "workspace",
    policy: null,
    tool_delivery: null,
    runtime: {
      relay: {
        authenticated: true, ready: true, closed: false, transport: "https", network_route: "system-network-stack",
        reconnect_attempt: 2, outage_active: false, outage_count: 4, outage_duration_ms: 321,
        last_close_category: "relay_connect_timeout", last_close_code: 1006, last_transport_error_class: "network_error",
        https_fallback_active: true, websocket_ready: false, https_fallback_last_takeover_ms: 1350,
        https_fallback: { session_id: "must_not_escape_summary", outbound_queue: ["content"] },
        heartbeat: { application_inbound_silence_ms: 999 }, websocket_outage_duration_ms: 888,
      },
      processes: null,
      process_sessions: [],
      managed_jobs: { active: 2, retained: 3, maximum: 9, staged: 1, capacity: { retained_state: 9, retired_state: 6, retired_unreadable: 2 } },
    },
  }, "summary");
  assert(summary.detail === "summary" && summary.policy && Object.keys(summary.policy).length === 0
    && summary.tool_delivery.daemon_advertised_tool_count === 0
    && summary.runtime.lifecycle === null && summary.runtime.relay?.ready === true
    && summary.runtime.relay?.transport === "https" && summary.runtime.relay?.outage_count === 4
    && summary.runtime.relay?.https_fallback_active === true && summary.runtime.relay?.websocket_ready === false
    && summary.runtime.relay?.https_fallback_last_takeover_ms === 1350
    && !("https_fallback" in summary.runtime.relay) && !("heartbeat" in summary.runtime.relay)
    && !("websocket_outage_duration_ms" in summary.runtime.relay)
    && summary.runtime.processes.active_processes === 0 && summary.runtime.processes.draining_processes === 0
    && summary.runtime.process_sessions.active === 0 && !("staged" in summary.runtime.process_sessions)
    && summary.runtime.managed_jobs.active === 2 && summary.runtime.managed_jobs.staged === 1
    && summary.runtime.managed_jobs.capacity?.retained_state === 9
    && summary.runtime.managed_jobs.capacity?.retired_state === 6
    && summary.runtime.managed_jobs.capacity?.retired_unreadable === 2,
  "sparse local server_info projection lost bounded defaults or owner retained-state capacity diagnostics");
  const hiddenSummary = projectRuntimeInfo({
    runtime: { processes: { activity_hidden_by_authority: true }, process_sessions: { active: 1, retained: 1, maximum: 8 }, managed_jobs: { active: 0, retained: 0, maximum: 50 } },
  }, "summary");
  assert(hiddenSummary.runtime.processes.activity_hidden_by_authority === true
    && !("active_processes" in hiddenSummary.runtime.processes),
  "server_info summary converted hidden global process activity into false zero-valued evidence");
}

function deferred() {
  let resolvePromise = () => {};
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function testToolResultBoundary() {
  const source = { ok: true, nested: { value: 7 } };
  const normalized = normalizeToolResult(source);
  source.nested.value = 9;
  assert(normalized.value.nested.value === 7, "tool result boundary retained a mutable handler object");
  assert(normalized.bytes === Buffer.byteLength(JSON.stringify({ ok: true, nested: { value: 7 } })), "tool result boundary reported the wrong byte size");

  const cyclic = {};
  cyclic.self = cyclic;
  expectBridgeError(() => normalizeToolResult(cyclic), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: 1n }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: undefined }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value() {} }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: Symbol("x") }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: Number.NaN }), "internal_error");
  expectBridgeError(() => normalizeToolResult(undefined), "internal_error");
  let oversized;
  try { normalizeToolResult({ data: "x".repeat(MAX_TOOL_RESULT_BYTES) }); }
  catch (error) { oversized = error; }
  assert(oversized?.code === "limit_exceeded", "oversized tool result used the wrong error code");
  assert(oversized.details.maximum_bytes === MAX_TOOL_RESULT_BYTES, "oversized tool result omitted its safe limit metadata");
}


function testTrustedGitExecutable() {
  const root = mkdtempSync(join(tmpdir(), "mbm-trusted-git-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const home = join(root, "home");
  const trustedDir = join(root, "trusted-system");
  for (const directory of [workspace, stateRoot, runtimeDir, home, trustedDir]) mkdirSync(directory);
  const workspaceGit = join(workspace, "git");
  const homeGit = join(home, "git");
  const writableGit = join(trustedDir, "git-writable");
  const trustedGit = join(trustedDir, "git");
  for (const file of [workspaceGit, homeGit, writableGit, trustedGit]) writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(workspaceGit, 0o755);
  chmodSync(homeGit, 0o755);
  chmodSync(writableGit, 0o775);
  chmodSync(trustedGit, 0o755);
  try {
    const platform = process.platform === "win32" ? "win32" : "linux";
    const candidates = process.platform === "win32"
      ? ["git", workspaceGit, homeGit, trustedGit]
      : ["git", workspaceGit, homeGit, writableGit, trustedGit];
    const rejected = process.platform === "win32"
      ? [workspaceGit, homeGit]
      : [workspaceGit, homeGit, writableGit];
    const resolved = resolveTrustedGitExecutable({
      platform,
      workspace,
      stateRoot,
      runtimeDir,
      home,
      candidates,
    });
    assert(resolved === realpathSync(trustedGit), "trusted Git resolver accepted a relative, workspace, home, or group-writable executable");
    expectBridgeError(() => resolveTrustedGitExecutable({ platform, workspace, stateRoot, runtimeDir, home, candidates: rejected }), "unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
