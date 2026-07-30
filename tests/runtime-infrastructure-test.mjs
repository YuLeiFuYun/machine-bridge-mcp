import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BridgeError, errorCode, publicError, remoteBridgeError } from "../src/local/errors.mjs";
import { CallRegistry } from "../src/local/call-registry.mjs";
import { RuntimeObservability } from "../src/local/observability.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { childExitedBeforeTimeout, createChildProcessSettlement } from "../src/local/child-process-settlement.mjs";
import { processState } from "../src/local/process-identity.mjs";
import { captureProcessTreeOwnership, processTreeOwnershipStillCurrent, refreshProcessTreeOwnership, terminateProcessTree, terminateProcessTreeWithEscalation } from "../src/local/process-tree.mjs";
import { executionGuardrailsSnapshot } from "../src/local/execution-limits.mjs";
import { ToolExecutor, composeMiddleware } from "../src/local/tool-executor.mjs";
import { MAX_TOOL_RESULT_BYTES, normalizeToolResult } from "../src/local/tool-result-boundary.mjs";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import { workspaceShellCommand } from "../src/local/shell.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { LocalRuntime } from "../src/local/runtime.mjs";
import { normalizeRelayResumeCalls, normalizeRelayToolCall } from "../src/local/runtime-relay.mjs";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { RelayCallRecovery } from "../src/local/relay-call-recovery.mjs";
import { startAutostartLogMaintenance } from "../src/local/autostart-log-maintenance.mjs";

const PROCESS_FIXTURE_TIMEOUT_MS = 30_000;

await testCallRegistry();
await testToolExecutor();
await testToolExecutorConcurrency();
testToolResultBoundary();
await testDuplicateRelayCallId();
testRelayReadinessProbe();
await testRelayReadinessStateGuards();
testRelayCancellationSuppression();
testRelayResumeReconciliation();
testRelayToolTimeoutNormalization();
testRuntimeConvenienceMethods();
testRelayReconnectDelivery();
testAutostartLogMaintenance();
await testProcessExecutionNoShell();
await testFixedInternalProcessBoundary();
testTrustedGitExecutable();
await testProcessCancellationSettlesBeforeClose();
testProcessTracker();
testProcessTreeSupervisor();
await testChildProcessSettlement();
testHardSpawnSyncTimeout();
testExecutionGuardrails();
testErrors();
testWorkspaceShellSelection();
testBoundedOutput();
console.log("runtime infrastructure test ok");

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
  registry.finish("one");
  assert(registry.cancelOrigin("relay", "relay disconnected") === 1, "relay origin cancellation did not find its call");
  assert(cancelled.at(-1)?.reason === "relay disconnected", "relay origin cancellation lost its reason");
  registry.finish("two");
  assert(registry.snapshot().active === 0, "finished calls leaked from registry");
  registry.open({ callId: "stop-one", tool: "read_file" });
  registry.open({ callId: "stop-two", tool: "git_status" });
  registry.cancelAll("runtime stopped");
  assert(registry.snapshot().active === 0, "cancelAll left stopped calls registered");
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
}

async function testDuplicateRelayCallId() {
  let violation = "";
  const runtime = {
    activeRelayCalls: new Set(["duplicate-call"]),
    handleRelayProtocolViolation(reason) { violation = reason; },
  };
  await LocalRuntime.prototype.handleRelayToolCall.call(runtime, {
    type: "tool_call",
    id: "duplicate-call",
    tool: "read_file",
    arguments: { path: "README.md" },
    authorization: { account_id: "acct_testowner_12345678901234567890", account_version: 1, client_id: `mcp_client_${"c".repeat(43)}`, family_id: `mcp_family_${"c".repeat(43)}`, role: "owner" },
  }, { sessionId: 1 });
  assert(violation === "duplicate_tool_call_id", "duplicate relay call ID was not rejected as a protocol error");
  assert(runtime.activeRelayCalls.has("duplicate-call"), "duplicate relay call removed the original call lifecycle");
}

function testRelayCancellationSuppression() {
  const runtime = {
    activeRelayCalls: new Set(["result-window"]),
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

function testRelayResumeReconciliation() {
  assert(normalizeRelayResumeCalls({ ids: ["call_valid_12345678"] }).ok, "valid resumed-call set was rejected");
  assert(!normalizeRelayResumeCalls({ ids: ["call_duplicate_12345678", "call_duplicate_12345678"] }).ok, "duplicate resumed-call ids were accepted");
  assert(!normalizeRelayResumeCalls({ ids: ["invalid"] }).ok, "malformed resumed-call id was accepted");

  const cancelled = [];
  const events = [];
  const runtime = {
    activeRelayCalls: new Set(["call_keep_12345678", "call_cancel_12345678"]),
    suppressedRelayResults: new Map(),
    callRegistry: { cancel(id) { cancelled.push(id); return true; } },
    cancelCall: LocalRuntime.prototype.cancelCall,
    cancelRelayCall: LocalRuntime.prototype.cancelRelayCall,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
  };
  runtime.relayCallRecovery = new RelayCallRecovery({
    logger: runtime.logger, activeCallIds: () => runtime.activeRelayCalls,
  });
  runtime.relayCallRecovery.pendingResults.set("call_keep_12345678", { id: "call_keep_12345678" });
  runtime.relayCallRecovery.pendingResults.set("call_discard_12345678", { id: "call_discard_12345678" });
  LocalRuntime.prototype.reconcileRelayCalls.call(runtime, ["call_keep_12345678"]);
  assert(cancelled.join(",") === "call_cancel_12345678", "reconnect reconciliation cancelled the wrong active call");
  assert(runtime.suppressedRelayResults.get("call_cancel_12345678") === "caller_no_longer_waiting", "orphaned active call result was not suppressed");
  assert(runtime.relayCallRecovery.pendingResults.has("call_keep_12345678")
    && !runtime.relayCallRecovery.pendingResults.has("call_discard_12345678"), "reconnect reconciliation retained an orphaned queued result");
  assert(events.some((event) => event.name === "relay.calls.reconciled"), "reconnect reconciliation was not observable");

  let violation = "";
  let confirmed = 0;
  let acknowledged = "";
  const controlRuntime = {
    relayResumeSessionId: 0,
    reconcileRelayCalls(ids) { this.resumed = ids; },
    handleRelayProtocolViolation(reason) { violation = reason; },
    relayCallRecovery: {
      pulse() {},
      acknowledge(id) { acknowledged = id; return true; },
    },
    relay: {
      acknowledge() {},
      confirmReady() { confirmed += 1; return true; },
    },
  };
  LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "resume_calls", ids: ["call_valid_12345678"] },
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(controlRuntime.relayResumeSessionId === 17 && controlRuntime.resumed[0] === "call_valid_12345678", "valid resume_calls did not establish the reconnect contract");
  LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "ready_ack" },
    { sessionId: 17, authenticated: true, ready: false },
  );
  assert(confirmed === 1 && controlRuntime.relayResumeSessionId === 0, "ready_ack was not gated by resume reconciliation");
  LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "tool_result_ack", id: "call_valid_12345678" },
    { sessionId: 17, authenticated: true, ready: true },
  );
  assert(acknowledged === "call_valid_12345678", "valid Worker result acknowledgement was not applied");
  LocalRuntime.prototype.handleRelayControlMessage.call(
    controlRuntime,
    { type: "ready_ack" },
    { sessionId: 18, authenticated: true, ready: false },
  );
  assert(violation === "resume_calls_required", "ready_ack without resume_calls was accepted");
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
    timeout_ms: relayContract.maximumRelayToolTimeoutMs,
  });
  assert(accepted.ok && accepted.timeoutMs === relayContract.maximumRelayToolTimeoutMs, "local relay rejected the shared maximum call deadline");
  const clamped = normalizeRelayToolCall({
    id: "call_timeout_clamped_12345678",
    tool: "exec_command",
    arguments: { command: "true" },
    authorization,
    timeout_ms: relayContract.maximumRelayToolTimeoutMs + 60_000,
  });
  assert(clamped.ok && clamped.timeoutMs === relayContract.maximumRelayToolTimeoutMs, "local relay accepted a deadline above the shared contract");
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
  assert(recovery.pendingResults.has("call_ack"), "connected result was discarded before Worker acknowledgement");
  assert(recovery.acknowledge("call_ack") && !recovery.pendingResults.has("call_ack"),
    "Worker acknowledgement did not clear a connected result");
  activeCalls.delete("call_ack");
  sendSucceeds = false;

  assert(recovery.deliver({ id: "call_reconnect", ok: true }) === false, "result queued during an outage was reported as delivered");
  assert(recovery.pendingResults.has("call_reconnect"), "completed result was not retained for reconnect delivery");
  assert(scheduled === 1 && typeof scheduledCallback === "function", "queued result did not arm reconnect expiry");
  recovery.disconnected();
  assert(scheduled === 1, "disconnect armed a duplicate reconnect-expiry timer");
  assert(activeCalls.has("call_reconnect"), "brief disconnect cancelled an in-flight call immediately");

  sendSucceeds = true;
  recovery.ready();
  assert(recovery.pendingResults.has("call_reconnect") && scheduledCallback === null,
    "replayed result was discarded before Worker acknowledgement");
  assert(events.some((event) => event.name === "relay.tool_results.replayed" && event.fields.delivered_results === 1), "replayed result was not observable");
  recovery.pulse();
  assert(recovery.pendingResults.has("call_reconnect"), "heartbeat replay discarded an unacknowledged result");
  assert(recovery.acknowledge("call_reconnect") && recovery.pendingResults.size === 0,
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
  assert(recovery.pendingResults.size === 0, "reconnect expiry retained queued results");
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
    );
    assert(result.code === 0, "fixed internal process did not complete");
    assert(spawnInvocation?.cmd === "git" && spawnInvocation?.args?.[0] === "status", "fixed internal process was wrapped as delegated arbitrary execution");
    assert(spawnInvocation?.options?.shell === false, "fixed internal process enabled shell interpretation");
    assert(spawnInvocation?.options?.env?.HOME === join(temp, "home"), "fixed internal process did not use an isolated minimal environment");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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
  await expectReject(() => Promise.race([running, new Promise((_, reject) => { setTimeout(() => reject(new Error("cancellation did not settle")), 100); })]), "cancelled", "relay disconnected");
  assert(terminated === 1, "cancelled process was not terminated");
  assert(tracker.snapshot().active_processes === 1, "process tracker released a child before close");
  child.emit("close", null);
  assert(tracker.snapshot().active_processes === 0, "process tracker retained child after close");
}

function testProcessTracker() {
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
  assert(tracker.snapshot().active_processes === 3 && tracker.snapshot().calls_with_processes === 0, "call completion terminated or leaked call ownership");
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
  terminationSettled();
  timerTracker.track(timedChild, "timed-again");
  timerTracker.terminateCall("timed-again");
  assert(scheduledCount === 2, "settled process escalation was not released from the tracker");
  timerTracker.terminateCall("timed-again", { force: true });
  assert(clearedTimers.join(",") === "timer-2", "forced process termination did not clear the pending escalation timer");
}


function testProcessTreeSupervisor() {
  const signals = [];
  let scheduled = null;
  let escalated = false;
  const child = { pid: 4242, kill(signal) { signals.push(["child", signal]); return true; } };
  const timer = terminateProcessTreeWithEscalation(child, {
    graceMs: 25,
    captureOwnership: () => ({ synthetic: true }),
    isTerminationTargetOwned: () => true,
    terminate(_child, signal) { signals.push(["tree", signal]); },
    setTimeout(callback, delay) { scheduled = { callback, delay }; return "termination-timer"; },
    onEscalated() { escalated = true; },
  });
  assert(timer === "termination-timer", "process-tree escalation did not return the scheduler handle");
  assert(signals.length === 1 && signals[0][1] === "SIGTERM", "process-tree escalation did not begin gracefully");
  assert(scheduled?.delay === 25, "process-tree escalation lost the configured grace period");
  scheduled.callback();
  assert(signals.length === 2 && signals[1][1] === "SIGKILL" && escalated, "process-tree escalation did not force termination after the grace period");

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
  exitedCallback();
  assert(exitedSignals === 0, "process-tree escalation signalled a child after it had exited");

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
  const darwinOwnership = captureProcessTreeOwnership(child, {
    platform: "darwin",
    spawnSyncProcess(_command, args) {
      darwinQueries.push(args);
      return { status: 0, stdout: " 4242  4242 Tue Jul 22 00:00:00 2026\n 4243  4242 Tue Jul 22 00:00:01 2026\n" };
    },
  });
  assert(darwinOwnership.members.length === 2
    && darwinQueries[0]?.[0] === "-g" && darwinQueries[0]?.[1] === "4242"
    && !darwinQueries[0]?.includes("-axo"),
  "macOS process ownership capture scanned the full process table instead of the target process group");

  const ownership = captureProcessTreeOwnership(child, { platform: "linux", listProcessGroups: () => snapshotRows });
  assert(ownership.members.length === 2, "process group snapshot omitted a descendant");
  assert(processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, { listProcessGroups: () => [snapshotRows[1]] }), "surviving original descendant did not preserve process-group ownership");
  assert(!processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, { listProcessGroups: () => [{ pid: 4243, pgid: 4242, startedAt: Date.parse("2026-07-22T00:01:00Z") }] }), "PID-reused process group was accepted for escalation");
  assert(!processTreeOwnershipStillCurrent({ platform: "linux", pid: 4242, members: [] }, { ...child, exitCode: 0 }, { listProcessGroups: () => [] }), "empty ownership snapshot ignored parent exit");
  assert(!processTreeOwnershipStillCurrent({ platform: "linux", pid: 4242, members: [] }, child, { listProcessGroups: () => snapshotRows }), "empty ownership snapshot authorized forced termination without process identity");
  assert(!processTreeOwnershipStillCurrent(ownership, { ...child, exitCode: 0 }, {
    listProcessGroups: () => [{ ...snapshotRows[0], startedAt: snapshotRows[0].startedAt + 1000 }],
  }), "adjacent-second PID reuse was accepted as the captured process identity");
  const refreshed = refreshProcessTreeOwnership(
    { platform: "linux", pid: 4242, members: [snapshotRows[0]] },
    { listProcessGroups: () => snapshotRows },
  );
  assert(refreshed.members.length === 2, "post-SIGTERM ownership refresh did not capture a surviving descendant");
  let ownershipQueries = 0;
  assert(processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    listProcessGroups(_options, pid) {
      ownershipQueries += 1;
      return pid === 4243 ? [snapshotRows[1]] : [];
    },
  }), "targeted ownership fallback lost a captured descendant when the full process table was unavailable");
  assert(ownershipQueries > 1, "targeted ownership fallback was not exercised");

  const boundedTimeouts = [];
  const boundedKillSignals = [];
  assert(!processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    ownershipCheckBudgetMs: 90,
    monotonicNow: () => 0,
    spawnSyncProcess(_command, _args, processOptions) {
      boundedTimeouts.push(processOptions.timeout);
      boundedKillSignals.push(processOptions.killSignal);
      return { status: 1, stdout: "" };
    },
  }), "failed process snapshots were treated as current ownership");
  assert(boundedTimeouts.length === 3 && boundedTimeouts.every((value) => value > 0)
    && boundedTimeouts.reduce((sum, value) => sum + value, 0) <= 90,
  `targeted ownership fallback exceeded its global budget: ${boundedTimeouts.join(",")}`);
  assert(boundedKillSignals.every((value) => value === "SIGKILL"),
    "bounded process snapshots used a soft timeout signal that can leave spawnSync blocked");

  let expiredSnapshotCalls = 0;
  let clockSample = 0;
  assert(!processTreeOwnershipStillCurrent(refreshed, { ...child, exitCode: 0 }, {
    ownershipCheckBudgetMs: 1,
    monotonicNow: () => clockSample++ === 0 ? 0 : 2,
    spawnSyncProcess() { expiredSnapshotCalls += 1; return { status: 0, stdout: "" }; },
  }), "expired process ownership budget was treated as current ownership");
  assert(expiredSnapshotCalls === 0, "expired process ownership budget invoked an unbounded timeout-zero process snapshot");

  const groupSignals = [];
  assert(terminateProcessTree(child, "SIGTERM", {
    platform: "linux",
    killProcess(pid, signal) { groupSignals.push({ pid, signal }); },
  }), "POSIX process-group termination was not requested");
  assert(groupSignals[0].pid === -child.pid && groupSignals[0].signal === "SIGTERM", "POSIX termination did not target the child process group");
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

function testExecutionGuardrails() {
  const guardrails = executionGuardrailsSnapshot();
  assert(guardrails.tool_calls.maximum_concurrent === 16, "tool-call concurrency limit is not reported from the shared contract");
  assert(guardrails.process_sessions.maximum_concurrent === 8, "process-session limit is not reported from the shared contract");
  assert(guardrails.one_shot_processes.process_tree_termination === "sigterm-then-sigkill", "process cleanup contract is not observable");
  assert(guardrails.operating_system_enforcement.cpu_quota === "not-enforced"
    && guardrails.operating_system_enforcement.memory_quota === "not-enforced"
    && guardrails.operating_system_enforcement.network_isolation === "not-enforced",
  "portable guardrails misrepresented OS resource or network isolation as enforced");
}

function testErrors() {
  assert(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })) === "not_found", "Node error code classification failed");
  assert(errorCode(new Error("something timed out")) === "execution_failed", "untyped messages must not be reclassified heuristically");
  const publicValue = publicError(new BridgeError("network_error", "network unavailable"));
  assert(publicValue.code === "network_error" && publicValue.retryable === true, "public error lost retryability");
  const remote = remoteBridgeError({ code: "limit_exceeded", message: "busy", retryable: true, details: { retained: true } });
  assert(remote.code === "limit_exceeded" && remote.retryable === true && remote.details?.retained === true, "remote structured error was not preserved");
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
