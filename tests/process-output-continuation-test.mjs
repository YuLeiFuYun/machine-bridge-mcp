import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { BridgeError, publicError } from "../src/local/errors.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import { ProcessOutputStream } from "../src/local/process-output-stream.mjs";
import { completeProcessSessionRead } from "../src/local/process-session-read.mjs";
import { ProcessSessionManager } from "../src/local/process-sessions.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { PROCESS_SESSION_RETENTION_MS } from "../src/local/execution-limits.mjs";
import { ResourceAdmissionError } from "../src/local/resource-admission.mjs";
import { EXECUTION_SURFACE } from "../src/local/execution-surface.mjs";
import { toolResult } from "../src/local/tools.mjs";
import { textToolResult } from "../src/worker/mcp-jsonrpc.ts";

const root = await mkdtemp(join(tmpdir(), "mbm-process-output-test-"));
const tracker = new ProcessTracker();
const policy = {
  profile: "full",
  origin: "explicit",
  revision: 5,
  allowWrite: true,
  allowExec: true,
  execMode: "shell",
  unrestrictedPaths: true,
  minimalEnv: false,
  exposeAbsolutePaths: true,
};
const sessions = new ProcessSessionManager({
  workspace: root,
  policy,
  authorizeTool() {},
  runtimeDir: root,
  processTracker: tracker,
  resolveCwd: async () => root,
  displayPath: (value) => value,
  throwIfCancelled() {},
});
const service = new ProcessExecutionService({
  workspace: root,
  policy,
  policyGate: { assert() {} },
  runtimeDir: root,
  processTracker: tracker,
  resolveExistingPath: async () => root,
  resolveLocalCommand: async () => ({}),
  displayPath: (value) => value,
  throwIfCancelled() {},
  retainCompletedOutput: (value) => sessions.retainCompletedOutput(value),
});

try {
  testOutputStreamOffsets();
  testCompactProjection();
  testProcessSessionRetentionUsesMonotonicTime();
  testRemoteReadCompletionUsesFinalSessionState();
  await testExecutionSurfaceMarkers();
  await testRemoteSessionAdmissionIsFailFast();
  await testRemoteSessionActivityLifetime();
  await testRemoteBlockingPollCooldown();
  await testRemoteReadCancellationAfterHelperResolution();
  await testSuccessfulContinuation();
  await testFailureContinuation();
  await testSessionReleaseAfterBinding();
  await testSessionExitFallbackSettlement();
  await testSessionCancellationAfterSpawn();
  await testFailedSessionOwnershipRetention("bind");
  await testFailedSessionOwnershipRetention("cancel");
  await testSessionClearTerminatesLiveChild();
  await testSessionAuthorityRevocation();
  assert.equal(tracker.snapshot().active_processes, 0, "process tracking leaked after continuation/session lifecycle tests");
  console.log("process output continuation test ok");
} finally {
  await sessions.clearAndWait();
  await rm(root, { recursive: true, force: true });
}

function testProcessSessionRetentionUsesMonotonicTime() {
  let monotonicNow = 1000;
  let wallNow = Date.UTC(2026, 7, 18, 4, 0, 0);
  const manager = new ProcessSessionManager({
    workspace: root, policy, authorizeTool() {}, runtimeDir: root, processTracker: tracker,
    resolveCwd: async () => root, displayPath: (value) => value, throwIfCancelled() {},
    now: () => monotonicNow, wallNow: () => wallNow,
  });
  const retained = manager.retainCompletedOutput({
    command: "fixture", cwd: root,
    stdout: new ProcessOutputStream(1024), stderr: new ProcessOutputStream(1024), exitCode: 0,
    startedAt: wallNow - 1000, closedAt: wallNow,
  });
  assert(retained?.session_id, "monotonic retention fixture was not retained");
  wallNow += 30 * 24 * 60 * 60_000;
  assert(manager.get(retained.session_id), "forward wall-clock jump expired a daemon-lifetime process session");
  wallNow -= 60 * 24 * 60 * 60_000;
  monotonicNow += PROCESS_SESSION_RETENTION_MS - 1;
  assert(manager.get(retained.session_id), "backward wall-clock jump altered process-session retention age");
  monotonicNow += 2;
  assert.throws(() => manager.get(retained.session_id), /expired/,
    "process session did not expire after its monotonic retention interval elapsed");
}

async function testExecutionSurfaceMarkers() {
  const foreground = await service.runDirect({
    argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_EXECUTION_SURFACE || '')"],
    timeout_seconds: 10,
  });
  assert.equal(foreground.stdout, EXECUTION_SURFACE.foregroundProcess,
    "foreground process execution omitted its execution-surface marker");

  const started = await sessions.start({
    argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_EXECUTION_SURFACE || '')"],
  });
  const page = await sessions.read({
    session_id: started.session_id,
    stdout_offset: 0,
    stderr_offset: 0,
    max_bytes: 1024,
    wait_ms: 10_000,
    wait_for_exit: true,
  });
  assert.equal(page.running, false, "execution-surface session fixture did not exit");
  assert.equal(page.stdout.data, EXECUTION_SURFACE.processSession,
    "process session omitted its execution-surface marker");
}

async function testRemoteSessionAdmissionIsFailFast() {
  const waits = [];
  let spawnCount = 0;
  let activityStarts = 0;
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator: {
      async acquire(_request, options) {
        waits.push(options.waitMs);
        throw new ResourceAdmissionError({ state: "red", reason: "host_pressure_red" });
      },
    },
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {},
    remoteActivityGuard: { beginActivity() { activityStarts += 1; }, endActivity() {} },
    spawnProcess() {
      spawnCount += 1;
      throw new Error("resource-denied session must not spawn");
    },
  });
  await assert.rejects(
    () => manager.start({ argv: [process.execPath, "-e", "process.exit(0)"] }, { origin: "relay", authority: { origin: "relay" } }),
    (error) => {
      assert(error instanceof BridgeError, "remote resource pressure did not cross the process boundary as a BridgeError");
      assert.equal(error.code, "unavailable", "remote resource pressure lost its retryable unavailable classification");
      assert.equal(error.retryable, true, "remote resource pressure became non-retryable");
      assert.deepEqual(publicError(error).details, {
        reason: "resource_admission",
        pressure_state: "red",
        admission_reason: "host_pressure_red",
      }, "remote resource pressure lost its bounded admission diagnosis");
      return true;
    },
  );
  await assert.rejects(
    () => manager.start({ argv: [process.execPath, "-e", "process.exit(0)"] }, { origin: "local", authority: { origin: "local" } }),
    (error) => error instanceof BridgeError && error.code === "unavailable",
  );
  assert.deepEqual(waits, [0, 10_000],
    "process-session resource admission did not separate remote reply safety from local operator patience");
  assert.equal(spawnCount, 0, "resource-admission failure reached child-process spawn");
  assert.equal(activityStarts, 0, "remote process-session activity started before resource admission succeeded");
  manager.resourceCoordinator.acquire = async () => {
    throw new ResourceAdmissionError({ state: "green", reason: "cpu_request_exceeds_launch_window" });
  };
  await assert.rejects(
    () => manager.start({ argv: [process.execPath, "-e", "process.exit(0)"] }, { origin: "relay", authority: { origin: "relay" } }),
    (error) => error instanceof BridgeError
      && error.code === "unavailable"
      && error.retryable === false
      && error.message.includes("reduce explicit parallelism")
      && publicError(error).details?.admission_reason === "cpu_request_exceeds_launch_window",
    "structurally impossible resource demand remained a retryable temporary-pressure error",
  );
  assert.equal(activityStarts, 0, "structurally impossible remote session demand retained idle-sleep activity");
}

async function testRemoteBlockingPollCooldown() {
  const manager = new ProcessSessionManager({
    workspace: root, policy, authorizeTool() {}, runtimeDir: root, processTracker: tracker,
    resolveCwd: async () => root, displayPath: (value) => value, throwIfCancelled() {},
  });
  const remoteContext = { origin: "relay", authority: { origin: "relay" } };
  try {
    const started = await manager.start({ argv: [process.execPath, "-e", "setTimeout(() => {}, 2500)"] }, remoteContext);
    const immediate = await manager.read({ session_id: started.session_id, wait_ms: 0 }, remoteContext);
    assert.equal(immediate.running, true, "remote polling fixture exited before the immediate checkpoint");
    assert.equal(immediate.status_polling_mode, "paced_followup", "remote process read omitted paced follow-up semantics");
    assert.equal(immediate.tool_schema_generation, 3, "remote process read omitted current tool schema generation");
    assert.equal(immediate.host_turn_deadline_observable, false, "remote process read claimed visibility into an external host turn deadline");
    assert.equal(immediate.blocking_poll_throttled, false, "non-blocking status checkpoint was marked as throttled");
    assert.equal(immediate.next_blocking_poll_after_ms, 0,
      "non-blocking status checkpoint incorrectly armed the blocking-poll cooldown");

    const firstStartedAt = Date.now();
    const first = await manager.read({ session_id: started.session_id }, remoteContext);
    const firstElapsed = Date.now() - firstStartedAt;
    assert.equal(first.running, true, "remote polling fixture exited before the first blocking read");
    assert(firstElapsed >= 700 && firstElapsed < 2_000,
      "relay-origin read_process without wait_ms did not default to the one-second server-paced wait");
    assert.equal(first.blocking_poll_throttled, false, "first remote blocking read was throttled unexpectedly");
    assert.equal(first.status_polling_mode, "paced_followup", "first remote blocking read lost paced follow-up semantics");
    assert.equal(first.host_turn_handoff_recommended, false,
      "running remote process still forced hosted-turn handoff");
    assert(first.next_blocking_poll_after_ms > 0, "running remote process omitted the next blocking-poll cooldown hint");

    const secondStartedAt = Date.now();
    const second = await manager.read({ session_id: started.session_id, wait_ms: 5_000 }, remoteContext);
    const secondElapsed = Date.now() - secondStartedAt;
    assert.equal(second.running, false, "cooldown-paced remote read returned a rapid running checkpoint instead of waiting for process exit");
    assert.equal(second.status_polling_mode, "terminal", "cooldown-paced remote read lost terminal state reached during server-side pacing");
    assert.equal(second.blocking_poll_throttled, true, "repeated remote blocking read did not disclose that its cooldown paced the call");
    assert(secondElapsed >= 900 && secondElapsed < 3_000,
      "repeated remote blocking read did not remain inside one MCP call until output/exit or cooldown progress");
    assert.equal(second.next_blocking_poll_after_ms, 0, "terminal cooldown-paced read retained a future blocking-poll delay");

    const outputPaced = await manager.start({
      argv: [process.execPath, "-e", "setTimeout(() => process.stdout.write('first\\n'), 100); setTimeout(() => process.stdout.write('second\\n'), 450); setTimeout(() => {}, 2500)"],
    }, remoteContext);
    const outputArm = await manager.read({ session_id: outputPaced.session_id, wait_ms: 5_000 }, remoteContext);
    assert(outputArm.running && outputArm.stdout.data.includes("first") && outputArm.next_blocking_poll_after_ms > 0,
      "output-paced fixture did not arm the initial blocking cooldown");
    const originalOutputCooldown = outputArm.next_blocking_poll_after_ms;
    const outputPacedStartedAt = Date.now();
    const outputDuringCooldown = await manager.read({
      session_id: outputPaced.session_id, wait_ms: 5_000,
      stdout_offset: outputArm.stdout.next_offset, stderr_offset: outputArm.stderr.next_offset,
    }, remoteContext);
    const outputPacedElapsed = Date.now() - outputPacedStartedAt;
    assert(outputDuringCooldown.running && outputDuringCooldown.stdout.data.includes("second"),
      "cooldown-paced read failed to return newly available output");
    assert.equal(outputDuringCooldown.blocking_poll_throttled, true,
      "output wakeup inside the cooldown lost its paced-read diagnostic");
    assert(outputPacedElapsed >= 150 && outputPacedElapsed < 1_500,
      "cooldown-paced output read did not return promptly when new output arrived");
    assert(outputDuringCooldown.next_blocking_poll_after_ms > 0
      && outputDuringCooldown.next_blocking_poll_after_ms < originalOutputCooldown,
    "output wakeup incorrectly re-armed the full blocking cooldown");

    const noisyExit = await manager.start({
      argv: [process.execPath, "-e", [
        "setTimeout(() => { const timer = setInterval(() => process.stdout.write('tick\\n'), 75);",
        "setTimeout(() => { clearInterval(timer); process.exit(0); }, 2200); }, 1100);",
      ].join(" ")],
    }, remoteContext);
    const noisyFirst = await manager.read({ session_id: noisyExit.session_id, wait_ms: 5_000 }, remoteContext);
    assert.equal(noisyFirst.running, true, "noisy wait_for_exit fixture exited before arming its cooldown");
    const noisyStartedAt = Date.now();
    const noisySettled = await manager.read({
      session_id: noisyExit.session_id, wait_ms: 5_000, wait_for_exit: true,
    }, remoteContext);
    const noisyElapsed = Date.now() - noisyStartedAt;
    assert.equal(noisySettled.running, false,
      "wait_for_exit cooldown was released by ordinary output before the process exited");
    assert(noisyElapsed >= 1800 && noisyElapsed < 4000,
      "wait_for_exit cooldown did not remain server-paced across ordinary output changes");
    assert(noisySettled.stdout.data.includes("tick"),
      "wait_for_exit cooldown lost output produced while the same MCP call remained open");
    assert.equal(noisySettled.blocking_poll_throttled, true,
      "wait_for_exit cooldown did not disclose server-side cooldown pacing");

    const exiting = await manager.start({ argv: [process.execPath, "-e", "setTimeout(() => {}, 150)"] }, remoteContext);
    const settled = await manager.read({ session_id: exiting.session_id, wait_ms: 5_000 }, remoteContext);
    assert.equal(settled.running, false, "remote process that exited during the checkpoint was still reported running");
    assert.equal(settled.status_polling_mode, "terminal", "settled remote process retained live follow-up semantics");
    assert.equal(settled.host_turn_handoff_recommended, false,
      "settled remote process incorrectly recommended handing the hosted turn back for more polling");
    assert.equal(settled.blocking_poll_throttled, false, "settled first blocking checkpoint was marked as throttled");
    assert.equal(settled.next_blocking_poll_after_ms, 0,
      "settled remote process retained a blocking-poll cooldown after exit");

    const outputFirst = await manager.start({
      argv: [process.execPath, "-e", "process.stdout.write('ready\\n'); setTimeout(() => {}, 2500)"],
    }, remoteContext);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 100); });
    const exitWaitStartedAt = Date.now();
    const exitWait = await manager.read({ session_id: outputFirst.session_id, wait_ms: 5_000, wait_for_exit: true }, remoteContext);
    const exitWaitElapsed = Date.now() - exitWaitStartedAt;
    assert.equal(exitWait.running, true, "wait_for_exit fixture exited before the hosted clamp was exercised");
    assert(exitWaitElapsed >= 700 && exitWaitElapsed < 2_000,
      "wait_for_exit bypassed the one-second hosted clamp when output was already available");
    assert(exitWait.stdout.data.includes("ready"), "wait_for_exit checkpoint lost output that was available before the wait");
    assert.equal(exitWait.blocking_poll_throttled, false, "first wait_for_exit checkpoint was throttled unexpectedly");
    assert(exitWait.next_blocking_poll_after_ms > 0,
      "wait_for_exit checkpoint did not arm the blocking cooldown for a still-running session");
  } finally {
    await manager.clearAndWait();
  }
}

async function testRemoteReadCancellationAfterHelperResolution() {
  let readChecks = 0;
  let cancelled = false;
  const manager = new ProcessSessionManager({
    workspace: root, policy, authorizeTool() {}, runtimeDir: root, processTracker: tracker,
    resolveCwd: async () => root, displayPath: (value) => value,
    throwIfCancelled(context) {
      if (context?.phase !== "read-cancellation-race") return;
      readChecks += 1;
      if (readChecks === 2) queueMicrotask(() => { cancelled = true; });
      if (cancelled) throw new BridgeError("cancelled", "cancelled after read helper resolution", { retryable: false });
    },
  });
  try {
    const started = await manager.start({ argv: [process.execPath, "-e", "setTimeout(() => {}, 2500)"] });
    let cancellationError = null;
    try {
      await manager.read({ session_id: started.session_id, wait_ms: 0 }, { phase: "read-cancellation-race" });
    } catch (error) { cancellationError = error; }
    assert(cancellationError instanceof BridgeError && cancellationError.code === "cancelled",
      "process read missed cancellation scheduled between helper resolution and manager continuation");
    assert(readChecks >= 3, "process read did not re-check cancellation after awaiting the read helper");
  } finally {
    await manager.clearAndWait();
  }
}

async function testRemoteSessionActivityLifetime() {
  let starts = 0;
  let ends = 0;
  const guard = { beginActivity() { starts += 1; }, endActivity() { ends += 1; } };
  const manager = new ProcessSessionManager({
    workspace: root, policy, authorizeTool() {}, runtimeDir: root, processTracker: tracker,
    resolveCwd: async () => root, displayPath: (value) => value, throwIfCancelled() {}, remoteActivityGuard: guard,
  });
  const remoteContext = { origin: "relay", authority: { origin: "relay" } };
  try {
    const started = await manager.start({ argv: [process.execPath, "-e", "setTimeout(() => {}, 150)"] }, remoteContext);
    assert.deepEqual({ starts, ends }, { starts: 1, ends: 0 },
      "remote process session did not retain activity after its start handler settled");
    const exited = await manager.read({ session_id: started.session_id, wait_ms: 2_000, wait_for_exit: true }, remoteContext);
    assert.equal(exited.running, false, "remote process-session activity fixture did not settle");
    assert.deepEqual({ starts, ends }, { starts: 1, ends: 1 },
      "remote process session did not release activity when its child settled");
    const local = await manager.start({ argv: [process.execPath, "-e", "process.exit(0)"] });
    await manager.read({ session_id: local.session_id, wait_ms: 2_000, wait_for_exit: true });
    assert.deepEqual({ starts, ends }, { starts: 1, ends: 1 }, "local process session changed remote idle-sleep activity state");
  } finally {
    await manager.clearAndWait();
  }

  const failing = new ProcessSessionManager({
    workspace: root, policy, authorizeTool() {}, runtimeDir: root, processTracker: tracker,
    resourceCoordinator: { acquire: async () => ({ async bindProcess() {}, async release() {} }) },
    resolveCwd: async () => root, displayPath: (value) => value, throwIfCancelled() {}, remoteActivityGuard: guard,
    spawnProcess() { throw new Error("synthetic spawn failure"); },
  });
  await assert.rejects(() => failing.start({ argv: [process.execPath, "-e", "process.exit(0)"] }, remoteContext), /synthetic spawn failure/);
  assert.deepEqual({ starts, ends }, { starts: 2, ends: 2 }, "remote process-session spawn failure leaked its activity hold");
}

function testRemoteReadCompletionUsesFinalSessionState() {
  const session = { closedAt: 100, lastRemoteBlockingReadAt: null };
  const completed = completeProcessSessionRead({
    remoteRead: { remote: true, blocking: true, pollThrottled: false },
    stdout: { data: "" }, stderr: { data: "" },
  }, session, 200);
  assert.equal(completed.status_polling_mode, "terminal", "completed remote read retained live follow-up metadata");
  assert.equal(completed.host_turn_handoff_recommended, false,
    "remote read completion used a stale pre-exit running state for hosted-turn handoff");
  assert.equal(completed.next_blocking_poll_after_ms, 0,
    "remote read completion retained a blocking cooldown after the session had exited");
  assert.equal(session.lastRemoteBlockingReadAt, null,
    "remote read completion armed a blocking cooldown after the session had exited");
}

function testOutputStreamOffsets() {
  const stream = new ProcessOutputStream(8);
  stream.append("012345");
  stream.append("6789");
  const first = stream.read(0, 4);
  assert.equal(first.start_offset, 2, "aged-out stream did not clamp to the retained start");
  assert.equal(first.data, "2345", "retained stream returned the wrong first page");
  assert.equal(first.truncated_before, true, "aged-out bytes were not disclosed");
  const second = stream.read(first.next_offset, 8);
  assert.equal(second.data, "6789", "retained stream continuation returned the wrong tail");
  assert.equal(second.truncated_after, false, "complete stream tail was reported as truncated");
}

function testCompactProjection() {
  const payload = { marker: "kept", ["line\nbreak".repeat(100)]: true, content: "x".repeat(64 * 1024) };
  for (const result of [toolResult(payload), textToolResult(payload)]) {
    assert.equal(result.structuredContent?.marker, "kept", "large structured content was not preserved");
    assert.match(result.content?.[0]?.text || "", /available in structuredContent/, "large result duplicated full JSON into MCP text content");
    assert(Buffer.byteLength(result.content[0].text) < 1024, "large result summary remained too large");
    assert(!result.content[0].text.includes("\n"), "large result summary preserved control characters from object keys");
  }
}

async function testSuccessfulContinuation() {
  const bodyBytes = 100_000;
  const raw = await service.runDirect({
    argv: [process.execPath, "-e", `process.stdout.write("A".repeat(${bodyBytes}) + "END-SUCCESS")`],
    timeout_seconds: 10,
  });
  const result = toolResult(raw);
  const structured = result.structuredContent;
  assert.equal(result.isError, false, "successful process result was marked as an error");
  assert.match(result.content[0].text, /Continue with read_process session/, "truncated process result omitted continuation guidance");
  assert(Buffer.byteLength(result.content[0].text) < 512, "process result text mirror remained verbose");
  assert(structured.stdout_truncated_bytes > 0, "large process output was not bounded inline");
  assert.equal(typeof structured.output_session_id, "string", "large process output did not create a continuation session");

  const page = await sessions.read({
    session_id: structured.output_session_id,
    stdout_offset: 0,
    stderr_offset: 0,
    max_bytes: 256 * 1024,
  });
  assert.equal(page.stdout.data.length, bodyBytes + "END-SUCCESS".length, "continuation did not retain the complete bounded output");
  assert(page.stdout.data.endsWith("END-SUCCESS"), "continuation lost the output tail");
  assert.equal(page.stdout.truncated_before, false, "sub-megabyte output incorrectly reported aged-out bytes");
}

async function testFailureContinuation() {
  const bodyBytes = 100_000;
  let failure;
  try {
    await service.runDirect({
      argv: [process.execPath, "-e", `process.stderr.write("E".repeat(${bodyBytes}) + "END-FAILURE"); process.exitCode = 7`],
      timeout_seconds: 10,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof BridgeError && failure.code === "execution_failed", "nonzero process did not return a typed execution failure");
  assert(Buffer.byteLength(failure.message) <= 2300, "nonzero process expanded its stderr into an unbounded error message");
  const publicFailure = publicError(failure);
  const processDetails = publicFailure.details?.process;
  assert.equal(typeof processDetails?.output_session_id, "string", "failure details omitted the continuation session");
  assert(processDetails.stderr_truncated_bytes > 0, "failure details did not disclose inline truncation");

  const page = await sessions.read({
    session_id: processDetails.output_session_id,
    stdout_offset: 0,
    stderr_offset: 0,
    max_bytes: 256 * 1024,
  });
  assert(page.stderr.data.endsWith("END-FAILURE"), "failure continuation lost the stderr tail");
  assert.equal(page.exit_code, 7, "failure continuation lost the process exit code");
}

async function testSessionReleaseAfterBinding() {
  let bindingFinished = false;
  let releasedBeforeBinding = false;
  let releaseCount = 0;
  const lease = {
    async bindProcess() {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 75); });
      bindingFinished = true;
      return this;
    },
    async release() {
      releaseCount += 1;
      if (!bindingFinished) releasedBeforeBinding = true;
      return true;
    },
  };
  const resourceCoordinator = { acquire: async () => lease };
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator,
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {},
  });
  try {
    const started = await manager.start({ argv: [process.execPath, "-e", ""] });
    const closed = await manager.read({
      session_id: started.session_id,
      wait_ms: 5_000,
      wait_for_exit: true,
    });
    assert.equal(closed.running, false, "short-lived process session did not exit within the bounded observation window");
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    assert.equal(releasedBeforeBinding, false, "short-lived process session released its provisional resource lease before binding settled");
    assert.equal(releaseCount, 1, "short-lived process session did not release its resource lease exactly once");
  } finally {
    await manager.clearAndWait();
  }
}

async function testSessionExitFallbackSettlement() {
  class ExitOnlyChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4345;
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
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {},
    childSettlementOptions: { fallbackMs: 0 },
    spawnProcess: () => {
      queueMicrotask(() => {
        child.emit("spawn");
        queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); });
      });
      return child;
    },
  });
  try {
    const started = await manager.start({ argv: [process.execPath, "-e", ""] });
    const closed = await manager.read({ session_id: started.session_id, wait_ms: 100, wait_for_exit: true });
    assert.equal(closed.running, false, "process-session exit fallback remained active without a close event");
    assert.equal(closed.exit_code, 0, "process-session exit fallback lost the observed exit code");
    assert.equal(tracker.snapshot().active_processes, 0, "process-session exit fallback retained tracker ownership without close");
    assert(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed && child.unrefCount === 1,
      "process-session exit fallback did not close residual stdio handles before settlement");
  } finally {
    await manager.clearAndWait();
  }
}

async function testSessionCancellationAfterSpawn() {
  let boundPid = null;
  let releaseCount = 0;
  let releaseFinished;
  const released = new Promise((resolvePromise) => { releaseFinished = resolvePromise; });
  let cancellationChecks = 0;
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator: {
      acquire: async () => ({
        async bindProcess(child) { boundPid = child.pid; return this; },
        async release() {
          releaseCount += 1;
          releaseFinished();
          return true;
        },
      }),
    },
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {
      cancellationChecks += 1;
      if (cancellationChecks >= 2) throw new BridgeError("cancelled", "cancelled after process spawn", { retryable: false });
    },
  });
  try {
    let cancellationError = null;
    try { await manager.start({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }); }
    catch (error) { cancellationError = error; }
    assert(cancellationError instanceof BridgeError && cancellationError.code === "cancelled"
      && cancellationError.retryable === false && cancellationError.details?.side_effects_started === true
      && cancellationError.details?.termination_requested === true && cancellationError.details?.effect_settlement === "pending",
    "post-spawn cancellation lost its ambiguous-side-effect settlement contract");
    assert(Number.isInteger(boundPid) && boundPid > 0, "post-spawn cancellation fixture never reached resource binding");
    assert.equal(manager.status().retained, 1, "cancelled process session dropped ownership before process close");
    await withTimeout(released, 5_000, "cancelled process session did not release its resource lease");
    assert.equal(releaseCount, 1, "cancelled process session released its resource lease more than once");
    await waitFor(() => !pidAlive(boundPid), 5_000, "cancelled process session left an unaddressable OS process running");
    await waitFor(() => manager.status().retained === 0, 5_000, "cancelled startup session remained retained after real close");
  } finally {
    await manager.clearAndWait();
  }
}

async function testFailedSessionOwnershipRetention(phase) {
  let childPid = null;
  let releaseCount = 0;
  let releaseFinished;
  const released = new Promise((resolvePromise) => { releaseFinished = resolvePromise; });
  let cancellationChecks = 0;
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator: {
      acquire: async () => ({
        async bindProcess(child) {
          childPid = child.pid;
          if (phase === "bind") throw new Error("synthetic bind failure");
          return this;
        },
        async release() { releaseCount += 1; releaseFinished(); return true; },
      }),
    },
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {
      cancellationChecks += 1;
      if (phase === "cancel" && cancellationChecks >= 2) {
        throw new BridgeError("cancelled", "synthetic post-spawn cancellation", { retryable: false });
      }
    },
    terminateTree: () => false,
  });
  try {
    let startError = null;
    try { await manager.start({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }); }
    catch (error) { startError = error; }
    assert(startError instanceof BridgeError && startError.retryable === false
      && startError.details?.side_effects_started === true && startError.details?.termination_requested === false
      && startError.details?.effect_settlement === "unknown" && startError.details?.ownership_retained_until_close === true,
    `${phase} failure with undeliverable termination lost the retained-ownership settlement contract`);
    assert(Number.isInteger(childPid) && childPid > 0, `${phase} failure fixture did not spawn a child`);
    assert.equal(manager.status().active, 1, `${phase} failure dropped the live child from session ownership`);
    assert.equal(releaseCount, 0, `${phase} failure released its resource lease while the child was still live`);
    process.kill(childPid, "SIGKILL");
    await withTimeout(released, 5_000, `${phase} failure did not release resources after real process close`);
    await waitFor(() => manager.status().retained === 0, 5_000, `${phase} failure retained the hidden startup session after close`);
    assert.equal(releaseCount, 1, `${phase} failure released its resource lease more than once`);
  } finally {
    await manager.clearAndWait();
    if (Number.isInteger(childPid) && pidAlive(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  }
}

async function testSessionClearTerminatesLiveChild() {
  let releaseCount = 0;
  let releaseFinished;
  const released = new Promise((resolvePromise) => { releaseFinished = resolvePromise; });
  const lease = {
    async bindProcess() { return this; },
    async release() {
      releaseCount += 1;
      releaseFinished();
      return true;
    },
  };
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator: { acquire: async () => lease },
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {},
  });
  try {
    const started = await manager.start({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    assert.equal(started.running, true, "live-session cleanup fixture exited before clear()");
    const childPid = manager.get(started.session_id).child?.pid;
    assert(Number.isInteger(childPid) && childPid > 0, "live-session cleanup fixture omitted its OS process identity");
    await manager.clearAndWait();
    await withTimeout(released, 5_000, "cleared live process session did not terminate and release its resource lease");
    assert.equal(releaseCount, 1, "cleared live process session released its resource lease more than once");
    await waitFor(() => !pidAlive(childPid), 5_000,
      "cleared live process session released internal state while its OS process remained alive");
  } finally {
    await manager.clearAndWait();
  }
}

async function testSessionAuthorityRevocation() {
  let releaseCount = 0;
  let firstRelease;
  const firstReleased = new Promise((resolvePromise) => { firstRelease = resolvePromise; });
  const manager = new ProcessSessionManager({
    workspace: root,
    policy,
    authorizeTool() {},
    runtimeDir: root,
    processTracker: tracker,
    resourceCoordinator: {
      acquire: async () => ({
        async bindProcess() { return this; },
        async release() {
          releaseCount += 1;
          if (releaseCount === 1) firstRelease();
          return true;
        },
      }),
    },
    resolveCwd: async () => root,
    displayPath: (value) => value,
    throwIfCancelled() {},
  });
  const accountId = `acct_${"p".repeat(32)}`;
  const clientId = `mcp_client_${"p".repeat(43)}`;
  const familyId = `mcp_family_${"p".repeat(43)}`;
  const context = (accountVersion) => ({ authority: { principal: {
    kind: "account", accountId, accountVersion, clientId, familyId, role: "owner",
  } } });
  try {
    const oldVersion = await manager.start({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }, context(4));
    const currentVersion = await manager.start({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }, context(5));
    assert.equal(await manager.revokeAuthority({ accountId, accountVersion: 4, clientId, familyId }), 1,
      "process-session authority revocation did not target exactly one old-version session");
    await withTimeout(firstReleased, 5_000, "revoked process session did not terminate and release its lease");
    const current = await manager.read({ session_id: currentVersion.session_id }, context(5));
    assert.equal(current.running, true, "authority revocation terminated a newer account-version process session");
    assert.equal(releaseCount, 1, "authority revocation released unrelated process-session resources");
    await assert.rejects(() => manager.read({ session_id: oldVersion.session_id }, context(4)), /process session not found/,
      "revoked process session remained addressable");

    const originalTerminateTree = manager.terminateTree;
    // Delivery-failure fixtures must not depend on the host process-tree implementation. On Windows,
    // successfully spawning taskkill means the request was accepted even when a synthetic PID is invalid.
    const failedTerminationId = `proc_${"z".repeat(24)}`;
    manager.sessions.set(failedTerminationId, {
      id: failedTerminationId,
      child: { pid: 99_999_999 },
      closedAt: null,
      waiters: new Set(),
      owner_kind: "account", owner_account_id: accountId, owner_account_version: 4,
      owner_client_id: clientId, owner_family_id: familyId, owner_role: "owner",
    });
    try {
      manager.terminateTree = () => false;
      await assert.rejects(() => manager.revokeAuthority({ accountId, accountVersion: 4, clientId, familyId }),
        (error) => error?.code === "unavailable" && error?.retryable === true,
        "process-session authority revocation acknowledged a failed termination request");
      assert(manager.sessions.has(failedTerminationId), "failed process-session revocation discarded the only retained termination handle");
    } finally {
      manager.terminateTree = originalTerminateTree;
      manager.sessions.delete(failedTerminationId);
    }

    const unsettledTerminationId = `proc_${"x".repeat(24)}`;
    const unsettledSession = {
      id: unsettledTerminationId,
      child: { pid: 99_999_997 },
      closedAt: null,
      waiters: new Set(),
      owner_kind: "account", owner_account_id: accountId, owner_account_version: 4,
      owner_client_id: clientId, owner_family_id: familyId, owner_role: "owner",
    };
    manager.sessions.set(unsettledTerminationId, unsettledSession);
    const originalSettlementWaitMs = manager.terminationSettlementWaitMs;
    try {
      manager.terminateTree = () => true;
      manager.terminationSettlementWaitMs = 100;
      await assert.rejects(() => manager.revokeAuthority({ accountId, accountVersion: 4, clientId, familyId }),
        (error) => error?.code === "unavailable" && error?.retryable === true,
        "process-session authority revocation acknowledged a delivered-but-unsettled termination request");
      assert(manager.sessions.has(unsettledTerminationId), "unsettled process-session revocation discarded the retained termination handle");
    } finally {
      manager.terminateTree = originalTerminateTree;
      manager.terminationSettlementWaitMs = originalSettlementWaitMs;
      manager.sessions.delete(unsettledTerminationId);
    }

    const failedKillId = `proc_${"y".repeat(24)}`;
    manager.sessions.set(failedKillId, {
      id: failedKillId,
      child: { pid: 99_999_998 },
      closedAt: null,
      lastActivityMonotonic: performance.now(),
      waiters: new Set(),
      owner_kind: "local",
    });
    try {
      manager.terminateTree = () => false;
      await assert.rejects(() => manager.kill({ session_id: failedKillId, force: true }),
        (error) => error?.code === "unavailable" && error?.retryable === true,
        "forced process-session termination falsely reported a delivered request");
      assert(manager.sessions.has(failedKillId), "failed forced termination discarded the live process-session handle");
    } finally {
      manager.terminateTree = originalTerminateTree;
      manager.sessions.delete(failedKillId);
    }
  } finally {
    await manager.clearAndWait();
    await waitFor(() => tracker.snapshot().active_processes === 0, 5_000,
      "cleared process sessions did not reach OS close/untrack before the lifecycle test completed");
  }
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  if (!predicate()) throw new Error(message);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
