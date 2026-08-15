import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { BridgeError, publicError } from "../src/local/errors.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import { ProcessOutputStream } from "../src/local/process-output-stream.mjs";
import { ProcessSessionManager } from "../src/local/process-sessions.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
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
      lastActivity: Date.now(),
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
