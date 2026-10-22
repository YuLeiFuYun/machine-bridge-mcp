import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BridgeError } from "../../../src/local/errors.mjs";
import { ProcessTracker } from "../../../src/local/process-tracker.mjs";
import { childExitedBeforeTimeout, createChildProcessSettlement } from "../../../src/local/child-process-settlement.mjs";
import { processState } from "../../../src/local/process-identity.mjs";
import { captureProcessTreeOwnership, processTreeOwnershipStillCurrent, refreshProcessTreeOwnership, terminateProcessTree, terminateProcessTreeAndWait, terminateProcessTreeWithEscalation } from "../../../src/local/process-tree.mjs";
import { executionGuardrailsSnapshot } from "../../../src/local/execution-limits.mjs";
import { BoundedOutput } from "../../../src/local/bounded-output.mjs";
import { ProcessExecutionService } from "../../../src/local/process-execution.mjs";
import { runExecutable, workspaceShellCommand } from "../../../src/local/shell.mjs";
import { resolveTrustedGitExecutable } from "../../../src/local/trusted-git-executable.mjs";
import { assert, expectBridgeError, expectReject, PROCESS_FIXTURE_TIMEOUT_MS } from "./common.mjs";

export async function runProcessInfrastructureTests() {
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
  testWorkspaceShellSelection();
  testBoundedOutput();
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
  const drainEscalations = [];
  const drainSettlements = [];
  const drainTracker = new ProcessTracker({
    terminate(child, signal) { drainTerminations.push({ child, signal }); return true; },
    terminateWithEscalation(child, options) {
      drainEscalations.push({ child, graceMs: options.graceMs });
      drainSettlements.push(options.onTerminationSettled);
      return `drain-timer-${drainEscalations.length}`;
    },
  });
  const drainingChild = { pid: 301 };
  drainTracker.track(drainingChild, "drain");
  const drained = drainTracker.drain("SIGKILL", 100);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  assert(drainTerminations.length === 0 && drainEscalations.length === 1 && drainEscalations[0].graceMs === 0,
    "process tracker drain bypassed ownership-checked forced escalation");
  drainTracker.untrack(drainingChild);
  let drainSettled = false;
  void drained.then(() => { drainSettled = true; });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  assert(drainSettled === false, "process tracker drain returned while descendant escalation ownership was still pending");
  drainSettlements[0]();
  await drained;
  const lateChild = { pid: 302 };
  drainTracker.track(lateChild, "late-during-drain");
  assert(drainEscalations.length === 2 && drainEscalations[1].child === lateChild && drainEscalations[1].graceMs === 0,
    "process tracker allowed a new child to escape after runtime drain began");
  drainTracker.untrack(lateChild);
  drainSettlements[1]();

  let stalledDrainRequests = 0;
  const stalledDrainSettlements = [];
  const stalledDrainTracker = new ProcessTracker({
    terminateWithEscalation(_child, options) {
      stalledDrainRequests += 1;
      stalledDrainSettlements.push(options.onTerminationSettled);
      return `stalled-timer-${stalledDrainRequests}`;
    },
  });
  const stalledDrainChild = { pid: 303 };
  stalledDrainTracker.track(stalledDrainChild, "stalled-drain");
  await expectReject(() => stalledDrainTracker.drain("SIGKILL", 20), "unavailable", "process shutdown did not settle");
  assert(stalledDrainTracker.snapshot().active_processes === 1,
    "failed process drain discarded the only retained ownership handle");
  assert(stalledDrainTracker.snapshot().termination_escalations_pending === 1,
    "failed process drain discarded its pending ownership-checked escalation");
  stalledDrainSettlements[0]();
  const retriedDrain = stalledDrainTracker.drain("SIGKILL", 100);
  assert(stalledDrainRequests === 2, "failed process drain permanently suppressed a later termination retry");
  stalledDrainTracker.untrack(stalledDrainChild);
  stalledDrainSettlements[1]();
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

  const defaultScheduled = [];
  const defaultScheduleGuard = createChildProcessSettlement({
    fallbackMs: 0,
    readExitState() { throw new Error("synthetic exit-state read failure"); },
    onSettle: (...args) => defaultScheduled.push(args),
  });
  assert(defaultScheduleGuard.onExit(9, "SIGKILL"), "default child fallback was not scheduled");
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  assert(defaultScheduled.length === 1 && defaultScheduled[0][0] === 9 && defaultScheduled[0][1] === "SIGKILL",
    "throwing exit-state reader did not retain the observed exit event");

  scheduled = null;
  cleared = null;
  const cancelledGuard = createChildProcessSettlement({
    schedule(callback) { scheduled = { callback }; return "cancel-timer"; },
    clearSchedule(timer) { cleared = timer; },
    onSettle() { throw new Error("cancelled child settlement unexpectedly settled"); },
  });
  assert(cancelledGuard.onExit(null, null) && cancelledGuard.cancel() && cleared === "cancel-timer",
    "child settlement cancellation did not clear a pending fallback timer");
  assert(!cancelledGuard.onClose(0, null) && !cancelledGuard.cancel(),
    "cancelled child settlement accepted a later terminal event");

  scheduled = null;
  const invalidRefresh = [];
  const invalidRefreshGuard = createChildProcessSettlement({
    schedule(callback) { scheduled = { callback }; return "invalid-refresh"; },
    readExitState: () => ({ code: 1.5, signal: 7 }),
    onSettle: (...args) => invalidRefresh.push(args),
  });
  invalidRefreshGuard.onExit(3, "SIGTERM");
  scheduled.callback();
  assert(invalidRefresh[0]?.[0] === 3 && invalidRefresh[0]?.[1] === "SIGTERM",
    "invalid refreshed terminal identity overrode the original exit event");

  assert(childExitedBeforeTimeout({ processState: "zombie" }), "zombie child was not recognized as already exited");
  assert(childExitedBeforeTimeout({ exitCode: 0 }), "known child exit code was not recognized before timeout");
  assert(childExitedBeforeTimeout({ signalCode: "SIGTERM" }), "known child signal was not recognized before timeout");
  assert(!childExitedBeforeTimeout({ processState: "running" }), "running child bypassed timeout termination");

  const processStateObservable = process.platform !== "win32" && processState(process.pid) === "running";
  if (processStateObservable) {
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
