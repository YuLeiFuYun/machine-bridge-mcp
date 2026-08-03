import { PendingCallRegistry } from "../src/worker/pending-calls.ts";
import { PendingAdmissionGate } from "../src/worker/pending-admission.ts";
import { DurableStreamCallCoordinator } from "../src/worker/durable-stream-calls.ts";
import { DaemonSocketRegistry } from "../src/worker/daemon-sockets.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "../src/worker/runtime-alarm.ts";
import {
  buildServerInfoResult, persistImmediateStreamOutcome, startEventDrivenStreamCall, streamTerminalMessage,
} from "../src/worker/mcp-stream-dispatch.ts";
import { McpResumptionStore } from "../src/worker/mcp-resumption.ts";
import { createMcpSessionId, validateMcpSessionId } from "../src/worker/mcp-session.ts";
import { acceptsEventStream, resumeJsonRpcResponse, streamJsonRpcResponse } from "../src/worker/mcp-stream.ts";
import {
  MCP_STREAM_PROXY_ID_HEADER, MCP_STREAM_PROXY_MODE_HEADER, MCP_STREAM_PROXY_RETRY_HEADER,
  handleMcpStreamSubscribeRequest, mcpStreamDescriptorResponse, mcpStreamProxyId, mcpStreamProxyMode,
  mcpStreamProxyRetryId, proxyMcpEventStream, sanitizeBridgeRequest,
} from "../src/worker/mcp-stream-proxy.ts";
import { McpStreamChannel } from "../src/worker/mcp-stream-channel.ts";
import { subscribeTerminalMessage } from "../src/worker/mcp-stream-subscription.ts";
import { modernJsonRpcResponseStream } from "../src/worker/mcp-modern-stream.ts";
import { prepareLegacyStreamedToolCall } from "../src/worker/mcp-legacy-stream-prepare.ts";
import { respondWithoutDurableObject } from "../src/worker/worker-static-routes.ts";
import { createThrottledEdgeLogger } from "../src/worker/worker-edge-log.ts";
import {
  admitGlobalStatefulRequest, admitStatefulRequest, durableObjectQuotaResponse, isDurableObjectQuotaError,
  outerWorkerErrorClass, statefulRateLimitKey, workerGatewayErrorResponse,
} from "../src/worker/worker-edge-guard.ts";
import { daemonToolTimeoutBudget, remoteForegroundDefaultSeconds, REMOTE_FOREGROUND_TIMEOUT_SECONDS } from "../src/worker/tool-timeout.ts";
import { workerToolRequestFingerprint } from "../src/worker/mcp-request-fingerprint.ts";
import { validateWorkerToolArguments, workspaceTools } from "../src/worker/tool-catalog.ts";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../src/worker/policy.ts";
import { daemonTerminalResultDecision, WorkerObservability } from "../src/worker/observability.ts";
import { workerBodyLimitBytes } from "../src/worker/worker-runtime-config.ts";
import { corsPreflight, searchParamsObject } from "../src/worker/http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  sessionInstructionText, textToolResult, validateProtocolVersionHeader,
} from "../src/worker/mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "../src/worker/websocket-protocol.ts";
const STREAM_TEST_ID = `stream_${"T".repeat(43)}`;
const STREAM_DISCONNECTED_ID = `stream_${"D".repeat(43)}`;
const STREAM_RESUMED_ID = `stream_${"R".repeat(43)}`;
const STREAM_COMPLETE_ID = `stream_${"C".repeat(43)}`;

import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
  isLiveDaemonAttachment,
  withDaemonLastSeenAt,
} from "../src/worker/daemon-liveness.ts";

class MemoryStorage {
  values = new Map();
  alarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = Number(value); }
  async deleteAlarm() { this.alarm = null; }
}

class TestWebSocketContext {
  constructor() { this.sockets = []; this.tags = new Map(); }
  acceptWebSocket(socket, tags = []) { this.sockets.push(socket); this.tags.set(socket, [...tags]); }
  getWebSockets(tag) {
    return this.sockets.filter((socket) => socket.readyState === 1 && (!tag || this.tags.get(socket)?.includes(tag)));
  }
}

class TestWebSocket {
  constructor() {
    this.readyState = 1;
    this.listeners = new Map();
    this.sent = [];
    this.attachment = null;
    this.accepted = false;
    this.closeCode = 0;
    this.closeReason = "";
  }
  accept() { this.accepted = true; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(value) { this.sent.push(String(value)); }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment === null ? null : structuredClone(this.attachment); }
}


await testMcpSessions();
await testRequestKeyReuse();
await testRegistrationFailures();
await testPendingControlCapacity();
await testTerminalPaths();
await testReconnectRebinding();
await testDetachedTimeoutPause();
await testEventBoundaryDeadlineSweep();
await testRuntimeAlarmCoordinator();
await testTimeoutCallbackFailure();
await testPendingAdmissionGate();
await testEventDrivenStreamDispatch();
await testLegacyStreamPreparationIdentity();
await testStreamDispatchFailureBoundaries();
await testDurableSettlementPersistenceFailure();
await testAbortSignalCleanup();
await testMcpStreamResponse();
await testMcpStreamChannel();
await testMcpStreamProxy();
await testModernDirectStreamCancellation();
testDaemonSocketIsolation();
testWorkerRuntimeConfig();
testRelayTimeoutContract();
testWorkerPolicyParity();
testWorkerErrors();
testWorkerObservability();
testPrototypeSafeFormFields();
testMcpJsonRpcProtocol();
testWebSocketProtocol();
testDaemonLiveness();
await testThrottledEdgeLogger();
await testWorkerStaticRoutes();
console.log("worker runtime infrastructure test ok");



async function testMcpSessions() {
  const identityKey = "identity-key-for-synthetic-worker-test";
  const tokenKey = "sha256:synthetic-token-key";
  const first = await createMcpSessionId(identityKey, tokenKey);
  const second = await createMcpSessionId(identityKey, tokenKey);
  assert(first !== second, "separate MCP initializations reused a session id");
  assert(await validateMcpSessionId(first, identityKey, tokenKey), "fresh MCP session id did not validate");
  assert(!(await validateMcpSessionId(first, identityKey, `${tokenKey}-other`)), "MCP session id was not bound to the OAuth token");
  assert(!(await validateMcpSessionId(tamperSessionId(first), identityKey, tokenKey)), "tampered MCP session id validated");
}

async function testRequestKeyReuse() {
  const socket = {};
  const registry = new PendingCallRegistry(2);
  const first = registry.register({
    id: "one", tool: "read_file", socket, clientRequestKey: "client:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(registry.hasRequestKey("client:1"), "request key was not indexed");
  assert(registry.snapshot().by_tool.read_file === 1, "pending snapshot omitted the active tool");
  assert(await registry.resolve("one", socket, { ok: 1 }), "pending result was not resolved");
  assert((await first).ok === 1, "pending result value was lost");
  assert(!registry.hasRequestKey("client:1"), "resolved request key leaked");

  const reused = registry.register({
    id: "two", tool: "read_file", socket, clientRequestKey: "client:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  await registry.resolve("two", socket, { ok: 2 });
  assert((await reused).ok === 2, "request id could not be reused immediately after completion");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "terminal resolution leaked pending indexes");
  assert(registry.snapshot().oldest_ms === 0 && Object.keys(registry.snapshot().by_tool).length === 0, "empty pending snapshot retained activity metadata");
}

async function testRegistrationFailures() {
  const socket = {};
  const conflictRegistry = new PendingCallRegistry(2);
  const original = conflictRegistry.register({
    id: "original", tool: "list_dir", socket, clientRequestKey: "session:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  expectRegistrationError(() => conflictRegistry.register({
    id: "duplicate", tool: "list_dir", socket, clientRequestKey: "session:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "conflict", false);
  await conflictRegistry.resolve("original", socket, { ok: true });
  await original;

  const limitRegistry = new PendingCallRegistry(1);
  const first = limitRegistry.register({
    id: "first", tool: "run_process", socket, clientRequestKey: "session:2", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  expectRegistrationError(() => limitRegistry.register({
    id: "overflow", tool: "read_file", socket, clientRequestKey: "session:3", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "limit_exceeded", true);
  await limitRegistry.resolve("first", socket, { ok: true });
  await first;
}

async function testPendingControlCapacity() {
  const socket = {};
  const registry = new PendingCallRegistry(4, {
    reservedCapacity: 1,
    reservedTools: ["diagnose_runtime", "list_roots"],
  });
  const pending = [];
  for (let index = 0; index < 3; index += 1) {
    pending.push(registry.register({
      id: `ordinary-${index}`, tool: "read_file", socket, timeoutMs: 10_000,
      onTimeout: () => new Error("timeout"),
    }));
  }
  expectRegistrationError(() => registry.register({
    id: "ordinary-overflow", tool: "git_status", socket, timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "limit_exceeded", true);
  const control = registry.register({
    id: "control", tool: "diagnose_runtime", socket, timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  const snapshot = registry.snapshot();
  assert(snapshot.active === 4 && snapshot.active_ordinary === 3 && snapshot.active_reserved === 1,
    "pending registry did not preserve its control-plane slot");
  assert(snapshot.ordinary_capacity === 3 && snapshot.reserved_capacity === 1,
    "pending registry exposed the wrong capacity contract");
  expectRegistrationError(() => registry.register({
    id: "total-overflow", tool: "list_roots", socket, timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "limit_exceeded", true);
  for (let index = 0; index < 3; index += 1) await registry.resolve(`ordinary-${index}`, socket, index);
  await registry.resolve("control", socket, true);
  await Promise.all([...pending, control]);
}

async function testTerminalPaths() {
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(4);
  const cancelled = registry.register({
    id: "cancel", tool: "list_dir", socket: socketA, clientRequestKey: "cancel-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(await registry.cancelRequest("cancel-key", () => new WorkerToolError("cancelled", "cancelled")), "cancel did not find request key");
  await expectReject(cancelled, "cancelled");
  assert(!registry.hasRequestKey("cancel-key"), "cancelled request key leaked");

  const disconnected = registry.register({
    id: "socket", tool: "list_dir", socket: socketA, clientRequestKey: "socket-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  const other = registry.register({
    id: "other", tool: "read_file", socket: socketB, clientRequestKey: "other-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(await registry.rejectSocket(socketA, () => new WorkerToolError("unavailable", "disconnected", true)) === 1, "socket cleanup rejected unrelated calls");
  await expectReject(disconnected, "disconnected");
  assert(registry.snapshot().active === 1 && registry.hasRequestKey("other-key"), "socket cleanup corrupted unrelated index");
  await registry.reject("other", new Error("done"), socketB);
  await expectReject(other, "done");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "rejection leaked pending indexes");
}

async function testReconnectRebinding() {
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(2);
  const resumed = registry.register({
    id: "reconnect", tool: "exec_command", socket: socketA, daemonInstanceId: "daemon_same_instance_1234",
    clientRequestKey: "reconnect-key", timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
  });
  assert(registry.detachSocket(socketA, 1000, () => new WorkerToolError("unavailable", "reconnect grace expired", true)) === 1, "disconnect did not detach the active call");
  assert(registry.snapshot().detached === 1, "detached call was not visible in the pending snapshot");
  assert(registry.rebindInstance("daemon_other_instance_1234", socketB).length === 0, "different daemon instance stole a detached call");
  const reboundIds = registry.rebindInstance("daemon_same_instance_1234", socketB);
  assert(reboundIds.length === 1 && reboundIds[0] === "reconnect", "same daemon instance did not reclaim its detached call precisely");
  assert(registry.snapshot().detached === 0, "rebound call remained marked detached");
  assert(await registry.resolve("reconnect", socketB, { resumed: true }), "rebound call rejected the replacement socket result");
  assert((await resumed).resumed === true, "rebound call lost its result");

  const expiring = registry.register({
    id: "expire", tool: "read_file", socket: socketA, daemonInstanceId: "daemon_expiring_instance_1",
    timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
  });
  registry.detachSocket(socketA, 1, () => new WorkerToolError("unavailable", "reconnect grace expired", true));
  await expectReject(expiring, "reconnect grace expired");
  assert(registry.snapshot().active === 0, "expired detached call leaked from the pending registry");
}

async function testDetachedTimeoutPause() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const scheduler = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const advance = (duration) => {
    now += duration;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.deadline <= now)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(1, { now: () => now, scheduler });
  const pending = registry.register({
    id: "paused-timeout", tool: "run_process", socket: socketA, daemonInstanceId: "daemon_pause_12345678",
    timeoutMs: 100, onTimeout: () => new Error("operation timeout"),
  });
  advance(40);
  assert(registry.detachSocket(socketA, 120, () => new Error("reconnect timeout")) === 1, "timeout-pause test did not detach its call");
  advance(100);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 1, "normal operation timeout continued running while detached");
  assert(registry.rebindInstance("daemon_pause_12345678", socketB).length === 1, "detached timeout test did not rebind");
  advance(59);
  assert(registry.snapshot().active === 1, "rebound operation timeout lost its remaining budget");
  advance(1);
  await expectReject(pending, "operation timeout");
  assert(registry.snapshot().active === 0, "expired rebound call leaked from the registry");

  const socketC = {};
  const handover = registry.register({
    id: "live-handover", tool: "exec_command", socket: socketA, daemonInstanceId: "daemon_handover_12345678",
    timeoutMs: 100, onTimeout: () => new Error("handover operation timeout"),
  });
  advance(40);
  assert(registry.rebindInstance("daemon_handover_12345678", socketC)[0] === "live-handover", "verified same-instance handover did not transfer an attached call");
  assert(!(await registry.resolve("live-handover", socketA, { stale: true })), "old daemon socket retained ownership after handover");
  advance(59);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 0, "live handover reset or detached the operation timeout");
  advance(1);
  await expectReject(handover, "handover operation timeout");
  assert(registry.snapshot().active === 0, "live handover timeout leaked from the registry");
}

async function testEventBoundaryDeadlineSweep() {
  let now = 0;
  let nextTimer = 1;
  const scheduler = { setTimeout() { return nextTimer++; }, clearTimeout() {} };
  const socket = {};
  const registry = new PendingCallRegistry(1, { now: () => now, scheduler });
  const timeout = registry.register({
    id: "sweep-timeout", tool: "exec_command", socket, daemonInstanceId: "daemon_sweep_12345678",
    clientRequestKey: "sweep:timeout", timeoutMs: 100,
    onTimeout: () => new WorkerToolError("timeout", "event-boundary operation timeout"),
  });
  assert(registry.nextDeadlineDelayMs() === 100, "pending registry did not expose the operation deadline for Durable Object alarm scheduling");
  now = 100;
  assert(await registry.expireDue() === 1, "event-boundary sweep did not expire an overdue attached call");
  await expectReject(timeout, "event-boundary operation timeout");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "event-boundary operation sweep leaked indexes");

  const reconnect = registry.register({
    id: "sweep-reconnect", tool: "exec_command", socket, daemonInstanceId: "daemon_sweep_12345678",
    clientRequestKey: "sweep:reconnect", timeoutMs: 500,
    onTimeout: () => new Error("operation timeout"),
  });
  assert(registry.detachSocket(socket, 120, () => new WorkerToolError("unavailable", "event-boundary reconnect timeout", true)) === 1, "event-boundary sweep setup did not detach the call");
  assert(registry.nextDeadlineDelayMs() === 120, "pending registry did not expose the reconnect deadline for Durable Object alarm scheduling");
  now = 220;
  assert(await registry.expireDue() === 1, "event-boundary sweep did not expire an overdue detached call");
  await expectReject(reconnect, "event-boundary reconnect timeout");
  assert(registry.snapshot().active === 0 && registry.snapshot().detached === 0, "event-boundary reconnect sweep leaked pending state");
  assert(!Number.isFinite(registry.nextDeadlineDelayMs()), "empty pending registry retained a deadline");
}

async function testRuntimeAlarmCoordinator() {
  const scheduled = [];
  let deleted = 0;
  let expired = 0;
  let scheduleErrors = 0;
  let pendingDelay = 75;
  const pending = {
    async expireDue() { expired += 1; return 0; },
    nextDeadlineDelayMs() { return pendingDelay; },
  };
  const daemonRegistry = {
    candidateSockets() { return []; },
    probingSockets() { return []; },
    readyRoleSockets() { return []; },
  };
  let currentAlarm = null;
  const mutations = [];
  const context = {
    storage: {
      async getAlarm() { return currentAlarm; },
      async setAlarm(value) { currentAlarm = Number(value); scheduled.push(currentAlarm); },
      async deleteAlarm() { currentAlarm = null; deleted += 1; },
    },
    pending,
    daemonRegistry,
    async invalidateDaemonSocket() { throw new Error("empty socket registry must not invalidate a daemon"); },
    onScheduleError() { scheduleErrors += 1; },
    onAlarmMutation(action) { mutations.push(action); },
  };

  await scheduleRuntimeAlarm(context, 1000);
  assert(scheduled.length === 1 && scheduled[0] === 1075, "runtime alarm did not schedule the earliest pending deadline");
  assert(deleted === 0 && expired === 0 && mutations.at(-1) === "set", "alarm scheduling unexpectedly mutated pending state");

  pendingDelay = 150;
  await scheduleRuntimeAlarm(context, 1000);
  assert(scheduled.length === 1 && mutations.at(-1) === "noop", "later heartbeat deadline rewrote an already safe earlier alarm");

  pendingDelay = 25;
  await scheduleRuntimeAlarm(context, 1000);
  assert(scheduled.length === 2 && scheduled.at(-1) === 1025, "earlier pending deadline did not advance the alarm");

  pendingDelay = Number.POSITIVE_INFINITY;
  await processRuntimeAlarm(context, 2000);
  assert(expired === 1, "runtime alarm did not sweep overdue pending calls before rescheduling");
  assert(deleted === 1 && mutations.at(-1) === "delete", "runtime alarm did not remove an alarm when no deadline remained");
  await scheduleRuntimeAlarm(context, 2100);
  assert(deleted === 1 && mutations.at(-1) === "noop", "empty alarm state performed a redundant delete write");

  pendingDelay = 10;
  const failingContext = {
    ...context,
    storage: {
      async getAlarm() { return null; },
      async setAlarm() { throw new Error("synthetic alarm storage failure"); },
      async deleteAlarm() {},
    },
  };
  await scheduleRuntimeAlarm(failingContext, 3000);
  assert(scheduleErrors === 1, "runtime alarm scheduling failure was not reported through the bounded callback");

  let durableExpired = 0;
  let durableDelay = 40;
  const durableCall = {
    call_id: `call_${"D".repeat(43)}`,
    connection_id: `connection_${"D".repeat(43)}`,
    daemon_instance_id: "daemon_alarm_call_123456",
    streamId: STREAM_TEST_ID,
    requestId: 73,
    tool: "exec_command",
    state: "attached",
    started_at: 3000,
    operation_deadline_at: 4040,
    remaining_timeout_ms: 1040,
  };
  const durableContext = {
    ...context,
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    durableCalls: {
      async nextDeadlineDelayMs() { return durableDelay; },
      async due(now) { return now >= 4040 ? [durableCall] : []; },
    },
    async expireDurableCall(call) {
      assert(call.call_id === durableCall.call_id, "runtime alarm expired the wrong durable call");
      durableExpired += 1;
      durableDelay = Number.POSITIVE_INFINITY;
    },
  };
  currentAlarm = null;
  await scheduleRuntimeAlarm(durableContext, 4000);
  assert(currentAlarm === 4040, "runtime alarm ignored the persisted stream-call deadline");
  await processRuntimeAlarm(durableContext, 4040);
  assert(durableExpired === 1, "runtime alarm did not terminalize the overdue persisted stream call");
  assert(currentAlarm === null, "runtime alarm retained a deadline after durable call cleanup");
}

async function testTimeoutCallbackFailure() {
  const registry = new PendingCallRegistry(1);
  const timedOut = registry.register({
    id: "timeout-callback", tool: "run_process", socket: {}, clientRequestKey: "timeout-key", timeoutMs: 1,
    onTimeout: () => { throw new Error("callback implementation failed"); },
  });
  await expectReject(timedOut, "pending daemon call timed out");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "throwing timeout callback leaked pending indexes");
}

async function testPendingAdmissionGate() {
  const gate = new PendingAdmissionGate();
  const order = [];
  let unblock = () => {};
  let markStarted = () => {};
  const blocker = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const first = gate.run(async () => {
    order.push("first-start");
    markStarted();
    await blocker;
    order.push("first-end");
  });
  await started;
  const second = gate.run(() => { order.push("second"); });
  await Promise.resolve();
  assert(!order.includes("second"), "pending admission allowed concurrent mixed-capacity decisions");
  unblock();
  await Promise.all([first, second]);
  assert(order.join(",") === "first-start,first-end,second", "pending admission did not preserve FIFO serialization");
  await expectRejectType(gate.run(() => { throw new RangeError("synthetic admission failure"); }), RangeError);
  let recovered = false;
  await gate.run(() => { recovered = true; });
  assert(recovered, "failed pending admission permanently blocked later calls");
}

async function testEventDrivenStreamDispatch() {
  const storage = new MemoryStorage();
  const completed = [];
  const resumption = new McpResumptionStore(storage, {}, (_streamId, message) => completed.push(message));
  const sent = [];
  const socket = { send(value) { sent.push(JSON.parse(value)); } };
  const observability = new WorkerObservability();
  await resumption.begin({ streamId: STREAM_TEST_ID, tokenKey: "token", sessionId: "session", requestId: 44 });
  await startEventDrivenStreamCall({
    resumption, observability, streamId: STREAM_TEST_ID, requestId: 44,
    clientRequestKey: "session:44", requestFingerprint: await workerToolRequestFingerprint("list_dir", { path: "." }),
    tool: "list_dir", arguments: { path: "." },
    socket, daemonInstanceId: "daemon_stream_event_1234", connectionId: `connection_${"A".repeat(43)}`,
    executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000, transientSnapshot: { active: 0, by_tool: {} }, maximumPendingCalls: 2,
    authorization: { account_id: "acct_test", account_version: 1, client_id: "client_test", family_id: "family_test", role: "owner" },
    onSendFailure() {},
  });
  const persistedRequest = await resumption.calls.getByRequestKey("session:44");
  assert(persistedRequest?.request_fingerprint === await workerToolRequestFingerprint("list_dir", { path: "." }),
    "stream initiation did not persist its request fingerprint");
  const snapshot = await resumption.calls.snapshot(2);
  assert(snapshot.active === 1 && snapshot.request_keys === 1, "stream initiation did not persist its pending call");
  assert(sent.length === 1 && sent[0].type === "tool_call" && sent[0].tool === "list_dir"
    && sent[0].timeout_ms === 8_000,
  "stream dispatch did not preserve a separate daemon execution deadline");
  assert(await resumption.calls.complete(sent[0].id, `connection_${"A".repeat(43)}`,
    streamTerminalMessage(44, { ok: true, value: { entries: ["ok"] } })), "persisted stream call did not complete");
  const ready = await resumption.pollMessage(STREAM_TEST_ID);
  assert(ready.kind === "message" && ready.message.result.structuredContent.entries[0] === "ok",
    "persisted stream dispatch lost the terminal result");

  const reconnectStorage = new MemoryStorage();
  const reconnectStore = new McpResumptionStore(reconnectStorage);
  const reconnectSocket = { send(value) { this.message = JSON.parse(value); } };
  const firstConnection = `connection_${"B".repeat(43)}`;
  const secondConnection = `connection_${"C".repeat(43)}`;
  await reconnectStore.begin({ streamId: STREAM_RESUMED_ID, tokenKey: "token", sessionId: "session", requestId: 45 });
  await startEventDrivenStreamCall({
    resumption: reconnectStore, observability, streamId: STREAM_RESUMED_ID, requestId: 45,
    clientRequestKey: "session:45", tool: "list_dir", arguments: { path: "." },
    socket: reconnectSocket, daemonInstanceId: "daemon_stream_reconnect_1234", connectionId: firstConnection,
    executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000, transientSnapshot: { active: 0, by_tool: {} }, maximumPendingCalls: 2,
    authorization: { account_id: "acct_test", account_version: 1, client_id: "client_test", family_id: "family_test", role: "owner" },
    onSendFailure() {},
  });
  assert(await reconnectStore.calls.detach(firstConnection, 10_000) === 1, "streamed call did not detach after daemon loss");
  assert((await reconnectStore.calls.rebind("daemon_stream_reconnect_1234", secondConnection))[0] === reconnectSocket.message.id,
    "same daemon instance did not reclaim the persisted stream call");
  assert(!(await reconnectStore.calls.complete(reconnectSocket.message.id, firstConnection,
    streamTerminalMessage(45, { ok: true, value: { stale: true } }))), "stale connection settled a rebound stream call");
  assert(await reconnectStore.calls.complete(reconnectSocket.message.id, secondConnection,
    streamTerminalMessage(45, { ok: true, value: { resumed: true } })), "rebound stream call did not complete");
}

async function testLegacyStreamPreparationIdentity() {
  const storage = new MemoryStorage();
  const resumption = new McpResumptionStore(storage);
  const observability = new WorkerObservability();
  const admission = new PendingAdmissionGate();
  const authorized = {
    tokenKey: "token-prepare-retry",
    accountId: "acct_prepare_retry",
    accountVersion: 1,
    clientId: "mcp_client_prepare_retry_1234567890123456789012345678901234567890123",
    familyId: "mcp_family_prepare_retry_1234567890123456789012345678901234567890123",
    dpopJkt: "synthetic",
    role: "owner",
  };
  const requestId = 404;
  const sessionId = "mcp_prepare_retry_session";
  const body = {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: { name: "list_files", arguments: { path: ".", max_files: 10 } },
  };
  let dispatches = 0;
  const dependencies = {
    advertisedTools: workspaceTools,
    resumption,
    observability,
    admission,
    async serverInfo() { return { name: "synthetic" }; },
    async dispatchWorkspaceCall(input) {
      dispatches += 1;
      await resumption.calls.activate({
        streamId: input.streamId,
        callId: `call_${"I".repeat(43)}`,
        daemonInstanceId: "daemon_prepare_retry_123456",
        connectionId: `connection_${"J".repeat(43)}`,
        clientRequestKey: input.requestKey,
        requestFingerprint: input.requestFingerprint,
        tool: input.name,
        timeoutMs: 10_000,
      });
    },
  };

  const initial = await prepareLegacyStreamedToolCall(
    { body, authorized, sessionId, proxyMode: "prepare" }, dependencies,
  );
  const initialDescriptor = await initial.json();
  assert(initialDescriptor.kind === "initial" && dispatches === 1,
    `initial legacy preparation did not dispatch exactly once: ${JSON.stringify({ status: initial.status, initialDescriptor, dispatches })}`);

  const repeated = await prepareLegacyStreamedToolCall(
    { body: structuredClone(body), authorized, sessionId, proxyMode: "prepare" }, dependencies,
  );
  const repeatedDescriptor = await repeated.json();
  assert(repeatedDescriptor.kind === "resume" && repeatedDescriptor.stream_id === initialDescriptor.stream_id
    && dispatches === 1, "identical legacy retry did not reattach without duplicate dispatch");

  const reordered = structuredClone(body);
  reordered.params.arguments = { max_files: 10, path: "." };
  const reorderedResponse = await prepareLegacyStreamedToolCall(
    { body: reordered, authorized, sessionId, proxyMode: "prepare" }, dependencies,
  );
  assert((await reorderedResponse.json()).kind === "resume" && dispatches === 1,
    "canonical argument ordering did not preserve legacy retry identity");

  const changed = structuredClone(body);
  changed.params.arguments.path = "..";
  const conflict = await prepareLegacyStreamedToolCall(
    { body: changed, authorized, sessionId, proxyMode: "prepare" }, dependencies,
  );
  const conflictBody = await conflict.json();
  assert(conflict.status === 409 && conflictBody.error?.data?.side_effects_started === true && dispatches === 1,
    "changed legacy retry arguments duplicated work or lost the conflict marker");

  await resumption.complete(initialDescriptor.stream_id, { jsonrpc: "2.0", id: requestId, result: { completed: true } });
  const acknowledged = await resumption.resume({
    lastEventId: `${initialDescriptor.stream_id}:1`,
    tokenKey: authorized.tokenKey,
    sessionId,
  });
  assert(acknowledged.kind === "complete", "terminal acknowledgement did not retire the idempotency stream");
  const reusedAfterAck = await prepareLegacyStreamedToolCall(
    { body: structuredClone(body), authorized, sessionId, proxyMode: "prepare" }, dependencies,
  );
  const reusedAfterAckDescriptor = await reusedAfterAck.json();
  assert(reusedAfterAckDescriptor.kind === "initial" && reusedAfterAckDescriptor.stream_id !== initialDescriptor.stream_id
    && dispatches === 2, "acknowledged request id could not start intentional new work");

  const sessionlessBody = structuredClone(body);
  sessionlessBody.id = 4041;
  const sessionlessFirst = await prepareLegacyStreamedToolCall(
    { body: sessionlessBody, authorized, sessionId: "", proxyMode: "prepare" }, dependencies,
  );
  const sessionlessFirstDescriptor = await sessionlessFirst.json();
  const sessionlessSecond = await prepareLegacyStreamedToolCall(
    { body: structuredClone(sessionlessBody), authorized, sessionId: "", proxyMode: "prepare" }, dependencies,
  );
  const sessionlessSecondDescriptor = await sessionlessSecond.json();
  assert(sessionlessFirstDescriptor.kind === "initial" && sessionlessSecondDescriptor.kind === "initial"
    && sessionlessFirstDescriptor.stream_id !== sessionlessSecondDescriptor.stream_id
    && dispatches === 4,
  "sessionless legacy streams were rejected or incorrectly given signed-session idempotency");

  const failedBody = structuredClone(body);
  failedBody.id = 405;
  let failedDispatches = 0;
  const failingDependencies = {
    ...dependencies,
    async dispatchWorkspaceCall() {
      failedDispatches += 1;
      throw new WorkerToolError("unavailable", "synthetic pre-dispatch failure", true);
    },
  };
  const failedInitial = await prepareLegacyStreamedToolCall(
    { body: failedBody, authorized, sessionId, proxyMode: "prepare" }, failingDependencies,
  );
  const failedDescriptor = await failedInitial.json();
  const failedTerminal = await resumption.pollMessage(failedDescriptor.stream_id);
  assert(failedDescriptor.kind === "initial" && failedDispatches === 1
    && failedTerminal.kind === "message" && failedTerminal.message.result?.isError === true,
  "pre-activation failure was not persisted as a resumable terminal result");
  const failedRetry = await prepareLegacyStreamedToolCall(
    { body: structuredClone(failedBody), authorized, sessionId, proxyMode: "prepare" }, failingDependencies,
  );
  const failedRetryDescriptor = await failedRetry.json();
  assert(failedRetryDescriptor.kind === "resume" && failedRetryDescriptor.stream_id === failedDescriptor.stream_id
    && failedDispatches === 1, "terminal pre-activation failure was duplicated instead of reattached");
}

async function testStreamDispatchFailureBoundaries() {
  const completed = [];
  const events = [];
  const observability = new WorkerObservability();
  const immediateResumption = {
    async complete(streamId, message) { completed.push({ streamId, message }); },
  };
  await persistImmediateStreamOutcome({
    resumption: immediateResumption, observability, streamId: STREAM_COMPLETE_ID, requestId: 51,
    outcome: { ok: false, error: new WorkerToolError("authorization_denied", "denied") },
  });
  assert(completed.at(-1).message.result.isError === true
    && completed.at(-1).message.result.structuredContent.error.code === "authorization_denied", "immediate stream error lost its stable code");

  const failingResumption = { async complete() { throw new Error("synthetic persistence failure"); } };
  const originalError = console.error;
  console.error = (line) => { events.push(String(line)); };
  try {
    await persistImmediateStreamOutcome({
      resumption: failingResumption, observability, streamId: STREAM_COMPLETE_ID, requestId: 52,
      outcome: { ok: true, value: { ok: true } }, transformResult() { throw "non-error transform failure"; },
    });
  } finally {
    console.error = originalError;
  }
  assert(events.some((line) => line.includes("mcp.stream.persist.failed")), "immediate persistence failure was not observable");

  let sendFailureHandled = false;
  const sendStorage = new MemoryStorage();
  const sendStore = new McpResumptionStore(sendStorage);
  await sendStore.begin({ streamId: STREAM_TEST_ID, tokenKey: "token", sessionId: "session", requestId: 55 });
  await startEventDrivenStreamCall({
    resumption: sendStore, observability, streamId: STREAM_TEST_ID, requestId: 55,
    tool: "list_dir", arguments: {}, socket: { send() { throw new Error("closed"); } },
    daemonInstanceId: "daemon_send_fail_123456", connectionId: `connection_${"D".repeat(43)}`,
    executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000, transientSnapshot: { active: 0, by_tool: {} }, maximumPendingCalls: 1,
    authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onSendFailure() { sendFailureHandled = true; },
  });
  const failed = await sendStore.pollMessage(STREAM_TEST_ID);
  assert(sendFailureHandled && failed.kind === "message" && failed.message.result.isError === true,
    "send failure did not settle and clean the persisted stream call");

  const limitStorage = new MemoryStorage();
  const limitStore = new McpResumptionStore(limitStorage);
  await limitStore.begin({ streamId: STREAM_TEST_ID, tokenKey: "token", sessionId: "session", requestId: 56 });
  await limitStore.calls.activate({
    streamId: STREAM_TEST_ID, callId: `call_${"L".repeat(43)}`, daemonInstanceId: "daemon_limit_call_123456",
    connectionId: `connection_${"E".repeat(43)}`, tool: "list_dir", timeoutMs: 10_000, maximumPendingCalls: 1,
  });
  await limitStore.begin({ streamId: STREAM_RESUMED_ID, tokenKey: "token", sessionId: "session", requestId: 57 });
  await expectRejectType(startEventDrivenStreamCall({
    resumption: limitStore, observability, streamId: STREAM_RESUMED_ID, requestId: 57,
    tool: "list_dir", arguments: {}, socket: { send() {} }, daemonInstanceId: "daemon_full_123456789",
    connectionId: `connection_${"F".repeat(43)}`, executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000, transientSnapshot: { active: 0, by_tool: {} }, maximumPendingCalls: 1,
    authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onSendFailure() {},
  }), WorkerToolError);

  const reservedStorage = new MemoryStorage();
  const reservedStore = new McpResumptionStore(reservedStorage);
  await reservedStore.begin({ streamId: STREAM_TEST_ID, tokenKey: "token", sessionId: "session", requestId: 59 });
  await expectRejectType(startEventDrivenStreamCall({
    resumption: reservedStore, observability, streamId: STREAM_TEST_ID, requestId: 59,
    tool: "read_file", arguments: {}, socket: { send() {} }, daemonInstanceId: "daemon_reserved_ordinary",
    connectionId: `connection_${"H".repeat(43)}`, executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000,
    transientSnapshot: { active: 2, by_tool: { exec_command: 1, read_file: 1 } },
    maximumPendingCalls: 3, reservedPendingCalls: 1,
    authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onSendFailure() {},
  }), WorkerToolError);
  const reservedSocket = { send(value) { this.message = JSON.parse(value); } };
  await startEventDrivenStreamCall({
    resumption: reservedStore, observability, streamId: STREAM_TEST_ID, requestId: 59,
    tool: "diagnose_runtime", arguments: {}, socket: reservedSocket, daemonInstanceId: "daemon_reserved_control",
    connectionId: `connection_${"I".repeat(43)}`, executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000,
    transientSnapshot: { active: 2, by_tool: { exec_command: 1, read_file: 1 } },
    maximumPendingCalls: 3, reservedPendingCalls: 1,
    authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onSendFailure() {},
  });
  assert(reservedSocket.message?.tool === "diagnose_runtime",
    "mixed transient/durable admission did not preserve the control-plane slot");
  await reservedStore.calls.complete(reservedSocket.message.id, `connection_${"I".repeat(43)}`,
    streamTerminalMessage(59, { ok: true, value: { ready: true } }));

  const plainRegistrationFailure = { calls: { async activate() { throw new RangeError("synthetic registration failure"); } } };
  await expectRejectType(startEventDrivenStreamCall({
    resumption: plainRegistrationFailure, observability, streamId: STREAM_DISCONNECTED_ID, requestId: 58,
    tool: "list_dir", arguments: {}, socket: { send() {} }, daemonInstanceId: "daemon_plain_fail_1234",
    connectionId: `connection_${"G".repeat(43)}`, executionTimeoutMs: 8_000, settlementTimeoutMs: 10_000, transientSnapshot: { active: 0, by_tool: {} }, maximumPendingCalls: 1,
    authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onSendFailure() {},
  }), RangeError);

  const daemonRegistry = {
    probingSockets: () => [{}, {}], readySockets: () => [{}], candidateSockets: () => [{}], readyRoleSockets: () => [{}, {}],
  };
  const info = buildServerInfoResult({
    serverName: "machine-bridge-mcp", serverVersion: "test", base: "https://example.test", oauth: { issuer: "https://example.test" },
    authorization: { account: { role: "owner" }, summary: "summary" }, daemon: { tool_count: 2 },
    effectiveTools: ["server_info", "list_dir"], advertisedTools: ["server_info", "list_dir", "read_file"],
    pendingSnapshot: { active: 31, detached: 0, request_keys: 0, maximum: 32, ordinary_capacity: 30, reserved_capacity: 2, active_ordinary: 30, active_reserved: 1, oldest_ms: 0, by_tool: { read_file: 30, diagnose_runtime: 1 } },
    daemonRegistry, observability: new WorkerObservability(),
  });
  assert(info.worker.sockets_live.authenticated === 4 && info.worker.daemon_candidates === 1
    && info.tool_delivery.effective_account_tool_count === 2 && info.tool_delivery.relay_advertised_tool_count === 3
    && info.worker.pending_calls.ordinary_capacity === 30
    && info.worker.pending_calls.active_reserved === 1
    && info.tool_delivery.remote_foreground_execution_max_ms === 60_000
    && info.tool_delivery.worker_settlement_overhead_ms === 5_000
    && info.tool_delivery.daemon_execution_and_worker_settlement_deadlines_separate === true
    && info.tool_delivery.host_terminal_receipt_observable === false,
  "server_info builder lost socket, catalog, timeout, or delivery-scope diagnostics");
}


async function testDurableSettlementPersistenceFailure() {
  const events = [];
  const finished = [];
  const call = {
    call_id: `call_${"P".repeat(43)}`,
    connection_id: `connection_${"P".repeat(43)}`,
    daemon_instance_id: "daemon_persist_failure_1234",
    streamId: STREAM_TEST_ID,
    requestId: 91,
    tool: "exec_command",
    state: "attached",
    started_at: 1,
    operation_deadline_at: 10_000,
    remaining_timeout_ms: 9_999,
  };
  const coordinator = new DurableStreamCallCoordinator(
    {
      async get() { return call; },
      async complete() { throw new Error("synthetic terminal persistence failure"); },
    },
    {},
    {
      event(level, name, fields) { events.push({ level, name, fields }); },
      callFinished(tool, code) { finished.push({ tool, code }); },
    },
    32,
  );
  await expectRejectType(
    coordinator.settle(call.call_id, call.connection_id, { ok: true, value: { complete: true } }),
    Error,
  );
  assert(events.some((event) => event.name === "mcp.stream.persist.failed"),
    "terminal persistence failure was not observable");
  assert(finished.length === 0, "unpersisted terminal result was reported as completed");
}

async function testMcpStreamResponse() {
  assert(acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "application/json, text/event-stream" } })), "event-stream content negotiation was not detected");
  assert(!acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "application/json" } })), "JSON-only client was incorrectly upgraded to SSE");
  assert(!acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "text/event-stream; q=0, application/json" } })), "explicitly unacceptable event stream was selected");

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let intervalCallback = null;
  let intervalCleared = false;
  let keptAlive = null;
  const response = streamJsonRpcResponse(result, {
    streamId: STREAM_TEST_ID,
    heartbeatMs: 1,
    scheduler: {
      setInterval(callback) { intervalCallback = callback; return 1; },
      clearInterval(handle) { if (handle === 1) intervalCleared = true; },
    },
    keepAlive(promise) { keptAlive = promise; },
  });
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"), "stream response did not advertise SSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert(initial === `id: ${STREAM_TEST_ID}:0\ndata:\n\n`, "stream response did not prime the client with a resumable empty event");
  intervalCallback();
  const heartbeat = decoder.decode((await reader.read()).value);
  assert(heartbeat === ": keepalive\n\n", "stream response heartbeat was malformed");
  resolveResult({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  const terminal = decoder.decode((await reader.read()).value);
  assert(terminal.includes(`id: ${STREAM_TEST_ID}:1`) && terminal.includes("event: message") && terminal.includes('"id":7') && terminal.includes('"ok":true'), "stream response lost the terminal JSON-RPC result");
  assert((await reader.read()).done, "stream response did not close after the terminal result");
  await keptAlive;
  assert(intervalCleared, "stream response heartbeat timer was not cleared");

  let resolveDisconnected;
  const disconnectedResult = new Promise((resolve) => { resolveDisconnected = resolve; });
  let disconnectedCompletion = null;
  let deliveryCancelled = false;
  const disconnected = streamJsonRpcResponse(disconnectedResult, {
    streamId: STREAM_DISCONNECTED_ID,
    scheduler: { setInterval() { return 2; }, clearInterval() {} },
    keepAlive(promise) { disconnectedCompletion = promise; },
    onCancel() { deliveryCancelled = true; },
  });
  const disconnectedReader = disconnected.body.getReader();
  await disconnectedReader.read();
  await disconnectedReader.cancel();
  assert(deliveryCancelled, "public stream cancellation did not release its delivery subscription");
  resolveDisconnected({ jsonrpc: "2.0", id: 8, result: { ok: true } });
  await disconnectedCompletion;

  const resumed = resumeJsonRpcResponse(Promise.resolve({ jsonrpc: "2.0", id: 9, result: { ok: true } }), {
    streamId: STREAM_RESUMED_ID,
    scheduler: { setInterval() { return 3; }, clearInterval() {} },
  });
  const resumedText = await resumed.text();
  assert(resumedText.startsWith(": resumed\n\n"), "resumed stream emitted another sequence-zero event");
  assert(resumedText.includes(`id: ${STREAM_RESUMED_ID}:1`), "resumed stream omitted the terminal event id");

  const completed = resumeJsonRpcResponse(null, { streamId: STREAM_COMPLETE_ID });
  assert(await completed.text() === "", "completed stream replayed an already acknowledged terminal event");
}

async function testMcpStreamChannel() {
  const context = new TestWebSocketContext();
  const metrics = {
    opened: 0, coexisting: 0, rejected: 0, publications: 0, liveDeliveries: 0,
    storageResponses: 0, storageRaceDeliveries: 0, storageRaceFailures: 0, protocolErrors: 0,
    streamSubscriberOpened(existing) { this.opened += 1; this.coexisting += existing; },
    streamSubscriberRejected() { this.rejected += 1; },
    streamTerminalPublished(recipients) { this.publications += 1; this.liveDeliveries += recipients; },
    streamTerminalStorageResponse() { this.storageResponses += 1; },
    streamTerminalStorageRaceDelivery(delivered) {
      if (delivered) this.storageRaceDeliveries += 1;
      else this.storageRaceFailures += 1;
    },
    streamSubscriberProtocolError() { this.protocolErrors += 1; },
  };
  const pairs = [];
  const channel = new McpStreamChannel(
    context,
    metrics,
    () => {
      const pair = [new TestWebSocket(), new TestWebSocket()];
      pairs.push(pair);
      return pair;
    },
    (client) => ({ status: 101, webSocket: client }),
  );
  const upgrade = { headers: new Headers({ Upgrade: "websocket" }) };

  const readyMessage = { jsonrpc: "2.0", id: 20, result: { ready: true } };
  const ready = await channel.subscribe(upgrade, STREAM_TEST_ID, {
    async pollMessage() { return { kind: "message", message: readyMessage }; },
  });
  assert(ready.status === 200 && (await ready.json()).result.ready === true, "ready stream unnecessarily opened a subscriber");
  assert(context.sockets.length === 0 && metrics.storageResponses === 1,
    "ready stream leaked a subscriber socket or was misclassified as a live publication");

  const missing = await channel.subscribe(upgrade, STREAM_COMPLETE_ID, {
    async pollMessage() { return { kind: "not_found" }; },
  });
  assert(missing.status === 404, "missing stream opened a subscriber");

  const pendingStore = sequencePollStore([{ kind: "pending" }, { kind: "pending" }]);
  const pending = await channel.subscribe(upgrade, STREAM_TEST_ID, pendingStore);
  assert(pending.status === 101 && pending.webSocket === pairs[0][0], "pending stream did not upgrade to a subscriber");
  assert(channel.isSubscriber(pairs[0][1]), "subscriber attachment was not recoverable after hibernation");
  channel.publish(STREAM_TEST_ID, { jsonrpc: "2.0", id: 21, result: { pushed: true } });
  assert(JSON.parse(pairs[0][1].sent[0]).result.pushed === true, "terminal push was not delivered to the subscriber");
  assert(pairs[0][1].closeCode === 1000, "terminal subscriber did not close cleanly");
  assert(metrics.publications === 1 && metrics.liveDeliveries === 1, "terminal publication metrics were incorrect");

  const concurrentServers = [];
  for (let index = 0; index < 4; index += 1) {
    const subscribed = await channel.subscribe(
      upgrade,
      STREAM_RESUMED_ID,
      sequencePollStore([{ kind: "pending" }, { kind: "pending" }]),
    );
    concurrentServers.push(pairs.at(-1)[1]);
    assert(subscribed.status === 101, "concurrent resumable subscriber did not upgrade");
  }
  assert(concurrentServers.every((socket) => socket.readyState === 1), "resume subscribers replaced each other");
  const limited = await channel.subscribe(
    upgrade,
    STREAM_RESUMED_ID,
    sequencePollStore([{ kind: "pending" }, { kind: "pending" }]),
  );
  assert(limited.status === 429 && metrics.rejected === 1, "subscriber limit was not enforced or observable");
  channel.publish(STREAM_RESUMED_ID, { jsonrpc: "2.0", id: 22, result: { multicast: true } });
  assert(concurrentServers.every((socket) => JSON.parse(socket.sent[0]).result.multicast === true && socket.closeCode === 1000),
    "terminal result was not multicast to every concurrent resume subscriber");
  assert(metrics.coexisting === 6, "coexisting subscriber metric did not capture bounded fan-out");

  const raceMessage = { jsonrpc: "2.0", id: 23, result: { raced: true } };
  const raced = await channel.subscribe(
    upgrade,
    STREAM_DISCONNECTED_ID,
    sequencePollStore([{ kind: "pending" }, { kind: "message", message: raceMessage }]),
  );
  const raceServer = pairs.at(-1)[1];
  assert(raced.status === 101 && JSON.parse(raceServer.sent[0]).result.raced === true
    && metrics.storageRaceDeliveries === 1 && metrics.storageRaceFailures === 0,
  "completion between lookup and upgrade was lost or misclassified");

  const protocolSocket = new TestWebSocket();
  protocolSocket.serializeAttachment({ role: "mcp_stream_subscriber", streamId: STREAM_TEST_ID });
  channel.rejectSubscriberMessage(protocolSocket);
  assert(protocolSocket.closeCode === 1008 && metrics.protocolErrors === 1, "receive-only subscriber accepted client data");

  const noUpgrade = await channel.subscribe(
    { headers: new Headers() },
    STREAM_TEST_ID,
    sequencePollStore([{ kind: "pending" }]),
  );
  assert(noUpgrade.status === 426, "subscriber route accepted a non-WebSocket request");
}

async function testMcpStreamProxy() {
  const calls = [];
  const subscriptionSocket = new TestWebSocket();
  const bridge = {
    async fetch(request) {
      calls.push(request);
      const mode = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER);
      if (mode === "prepare") return mcpStreamDescriptorResponse("initial", STREAM_TEST_ID);
      if (mode === "subscribe") return { status: 101, webSocket: subscriptionSocket };
      throw new Error(`unexpected proxy mode: ${mode}`);
    },
  };
  const keptAlive = [];
  const request = new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "Mcp-Session-Id": "signed-session-fixture",
      origin: "https://chatgpt.com",
      [MCP_STREAM_PROXY_MODE_HEADER]: "subscribe",
      [MCP_STREAM_PROXY_ID_HEADER]: STREAM_COMPLETE_ID,
      [MCP_STREAM_PROXY_RETRY_HEADER]: `retry_${"f".repeat(43)}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_dir", arguments: {} } }),
  });
  const response = await proxyMcpEventStream({
    request, bridge, extraOrigins: "", ctx: { waitUntil(promise) { keptAlive.push(promise); } },
  });
  assert(response?.headers.get("content-type")?.startsWith("text/event-stream"), "outer Worker did not create the public SSE response");
  assert(response.headers.get("access-control-allow-origin") === "https://chatgpt.com", "outer Worker SSE response lost CORS");
  assert(calls[0].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "prepare", "public proxy mode header was not replaced");
  assert(calls[0].headers.get(MCP_STREAM_PROXY_ID_HEADER) === null, "public internal stream id reached BridgeRoom");
  const internalRetryId = calls[0].headers.get(MCP_STREAM_PROXY_RETRY_HEADER);
  assert(/^retry_[A-Za-z0-9_-]{43}$/.test(internalRetryId ?? "")
    && internalRetryId !== `retry_${"f".repeat(43)}`,
  "public internal retry id was not replaced by a fresh outer-Worker value");
  assert(calls.length === 2, "stream startup exceeded its fixed two-request Durable Object budget");
  assert(calls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "subscribe", "outer Worker did not open the internal terminal subscription");
  assert(calls[1].headers.get(MCP_STREAM_PROXY_ID_HEADER) === STREAM_TEST_ID, "internal subscription lost the stream id");
  assert(calls[1].headers.get(MCP_STREAM_PROXY_RETRY_HEADER) === null,
    "prepare-only DPoP retry identity leaked into terminal subscription");
  assert(calls[1].headers.get("Upgrade")?.toLowerCase() === "websocket", "internal subscription was not a WebSocket upgrade");
  await waitUntil(() => subscriptionSocket.accepted);
  assert(subscriptionSocket.accepted, "outer Worker did not accept the subscription WebSocket");
  assert(keptAlive.length === 1, "one terminal operation was registered with waitUntil more than once");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert(initial === `id: ${STREAM_TEST_ID}:0\ndata:\n\n`, "outer Worker proxy did not emit sequence zero");
  subscriptionSocket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 10, result: { proxied: true } }) });
  const terminalText = decoder.decode((await reader.read()).value);
  assert(terminalText.includes(`${STREAM_TEST_ID}:1`) && terminalText.includes('"proxied":true'), "outer Worker proxy lost the terminal result");
  assert((await reader.read()).done, "outer Worker proxy did not close after terminal delivery");
  await Promise.all(keptAlive);
  assert(calls.length === 2, "terminal wait regressed into repeated Durable Object requests");

  const spoofed = new Request("https://example.test/healthz", { headers: {
    [MCP_STREAM_PROXY_MODE_HEADER]: "subscribe", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID,
    [MCP_STREAM_PROXY_RETRY_HEADER]: `retry_${"g".repeat(43)}`,
  } });
  const sanitized = sanitizeBridgeRequest(spoofed);
  assert(!sanitized.headers.has(MCP_STREAM_PROXY_MODE_HEADER)
    && !sanitized.headers.has(MCP_STREAM_PROXY_ID_HEADER)
    && !sanitized.headers.has(MCP_STREAM_PROXY_RETRY_HEADER),
  "public internal stream headers were not stripped");

  const completeBridge = { async fetch() { return mcpStreamDescriptorResponse("complete", STREAM_COMPLETE_ID); } };
  const completed = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } }),
    bridge: completeBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert(await completed.text() === "", "outer Worker proxy replayed an acknowledged terminal event");
  const ordinary = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "POST", headers: { accept: "application/json" }, body: "{}" }),
    bridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert(ordinary === null, "JSON-only MCP request was incorrectly proxied as SSE");
  const nonMcp = await proxyMcpEventStream({
    request: new Request("https://example.test/healthz", { method: "GET" }),
    bridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert(nonMcp === null, "non-MCP GET was intercepted by the stream proxy");

  const plainBridge = { async fetch() {
    return new Response("plain", { status: 418, headers: { "x-machine-bridge-mcp-stream-descriptor": "spoof" } });
  } };
  const plain = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: plainBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert(plain.status === 418 && await plain.text() === "plain"
    && !plain.headers.has("x-machine-bridge-mcp-stream-descriptor"), "ordinary BridgeRoom response leaked its internal descriptor header");

  const immediateMessage = { jsonrpc: "2.0", id: 11, result: { resumed: true } };
  const resumeBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify(immediateMessage), { headers: { "content-type": "application/json" } });
    },
  };
  const resumedProxy = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } }),
    bridge: resumeBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  const resumedProxyText = await resumedProxy.text();
  assert(resumedProxyText.startsWith(": resumed\n\n") && resumedProxyText.includes(`${STREAM_RESUMED_ID}:1`), "resume descriptor did not create an outer resumed stream");
  assert(resumeBridge.calls === 2, "immediate resumed result exceeded its fixed request budget");

  const delayedDirectBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 111, result: { delayed_direct: true } }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const delayedDirect = await subscribeTerminalMessage(
    delayedDirectBridge,
    () => new Request("https://example.test/mcp"),
    [0, 1],
  );
  assert(delayedDirect.result?.delayed_direct === true && delayedDirectBridge.calls === 2,
    "signal-free subscription backoff did not retry a transient response and return terminal JSON-RPC");

  const delayedAbortController = new AbortController();
  const delayedAbort = subscribeTerminalMessage(
    { async fetch() { return new Response("busy", { status: 503 }); } },
    (signal) => new Request("https://example.test/mcp", { signal }),
    [0, 50],
    delayedAbortController.signal,
  );
  setTimeout(() => delayedAbortController.abort(), 5);
  await expectReject(delayedAbort, "subscription cancelled");

  const delayedSignalController = new AbortController();
  const delayedSignalBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 112, result: { delayed_signal: true } }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const delayedSignal = await subscribeTerminalMessage(
    delayedSignalBridge,
    (signal) => new Request("https://example.test/mcp", { signal }),
    [0, 5],
    delayedSignalController.signal,
  );
  assert(delayedSignal.result?.delayed_signal === true && delayedSignalBridge.calls === 2,
    "signal-bound subscription backoff did not resolve its timer and return terminal JSON-RPC");

  const channelStub = {
    calls: 0,
    async subscribe(_request, streamId, resumption) {
      this.calls += 1;
      assert(streamId === STREAM_TEST_ID && resumption.marker === true, "internal subscription lost its dependencies");
      return new Response(null, { status: 204 });
    },
  };
  const resumptionStub = { marker: true };
  const noSubscribe = await handleMcpStreamSubscribeRequest(new Request("https://example.test/mcp"), channelStub, resumptionStub);
  assert(noSubscribe === null, "ordinary request entered the internal stream subscription path");
  const postSubscribe = await handleMcpStreamSubscribeRequest(new Request("https://example.test/mcp", {
    method: "POST", headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "subscribe" }, body: "{}",
  }), channelStub, resumptionStub);
  assert(postSubscribe.status === 405 && postSubscribe.headers.get("allow") === "GET", "internal stream subscription accepted POST");
  const invalidSubscribe = await handleMcpStreamSubscribeRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "subscribe", [MCP_STREAM_PROXY_ID_HEADER]: "bad" },
  }), channelStub, resumptionStub);
  assert(invalidSubscribe.status === 400, "internal stream subscription accepted an invalid stream id");
  const validSubscribe = await handleMcpStreamSubscribeRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " Subscribe ", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID },
  }), channelStub, resumptionStub);
  assert(validSubscribe.status === 204 && channelStub.calls === 1, "valid internal subscription was not delegated");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " PREPARE " } })) === "prepare", "internal prepare mode was not normalized");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " SUBSCRIBE " } })) === "subscribe", "internal subscribe mode was not normalized");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "poll" } })) === "", "obsolete internal poll mode was accepted");
  assert(mcpStreamProxyId(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID } })) === STREAM_TEST_ID, "valid internal stream id was rejected");
  assert(mcpStreamProxyId(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_ID_HEADER]: "bad" } })) === "", "invalid internal stream id was accepted");
  assert(mcpStreamProxyRetryId(new Request("https://example.test", {
    headers: { [MCP_STREAM_PROXY_RETRY_HEADER]: `retry_${"h".repeat(43)}` },
  })) === `retry_${"h".repeat(43)}`, "valid internal retry id was rejected");
  assert(mcpStreamProxyRetryId(new Request("https://example.test", {
    headers: { [MCP_STREAM_PROXY_RETRY_HEADER]: "bad" },
  })) === "", "invalid internal retry id was accepted");
  expectThrow(() => mcpStreamDescriptorResponse("initial", "stream_short"), "invalid MCP stream descriptor id");

  await expectReject(proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: { async fetch() { return new Response(JSON.stringify({ kind: "invalid", stream_id: STREAM_TEST_ID }), { headers: { "x-machine-bridge-mcp-stream-descriptor": "1" } }); } },
    extraOrigins: "", ctx: { waitUntil() {} },
  }), "descriptor is invalid");

  const retryPrepareSocket = new TestWebSocket();
  const retryPrepareBridge = {
    calls: 0,
    bodies: [],
    retryIds: [],
    async fetch(request) {
      this.calls += 1;
      const mode = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER);
      if (mode === "prepare") {
        this.bodies.push(await request.clone().text());
        this.retryIds.push(request.headers.get(MCP_STREAM_PROXY_RETRY_HEADER));
        if (this.calls === 1) throw new Error("synthetic lost prepare response");
        return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      }
      if (mode === "subscribe") return { status: 101, webSocket: retryPrepareSocket };
      throw new Error(`unexpected retry prepare mode: ${mode}`);
    },
  };
  const retriedPrepare = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "Mcp-Session-Id": "signed-session-fixture" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "list_dir", arguments: {} } }),
    }),
    bridge: retryPrepareBridge,
    extraOrigins: "",
    ctx: { waitUntil() {} },
    prepareRetryDelaysMs: [0, 0],
  });
  await waitUntil(() => retryPrepareSocket.accepted);
  retryPrepareSocket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 101, result: { reattached: true } }) });
  assert((await retriedPrepare.text()).includes('"reattached":true') && retryPrepareBridge.calls === 3,
    "lost prepare response did not retry and reattach through the existing stream");
  assert(retryPrepareBridge.bodies.length === 2 && retryPrepareBridge.bodies[0] === retryPrepareBridge.bodies[1],
    "prepare retry did not preserve the exact JSON-RPC request body");
  assert(retryPrepareBridge.retryIds?.length === 2
    && retryPrepareBridge.retryIds[0] === retryPrepareBridge.retryIds[1]
    && /^retry_[A-Za-z0-9_-]{43}$/.test(retryPrepareBridge.retryIds[0]),
  "prepare retries did not share one opaque internal DPoP retry identity");

  const sessionlessPrepareBridge = {
    calls: 0,
    retryId: "unset",
    async fetch(request) {
      this.calls += 1;
      this.retryId = request.headers.get(MCP_STREAM_PROXY_RETRY_HEADER);
      throw new Error("synthetic ambiguous sessionless prepare failure");
    },
  };
  await expectReject(proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1011, method: "tools/call", params: { name: "list_dir", arguments: {} } }),
    }),
    bridge: sessionlessPrepareBridge,
    extraOrigins: "",
    ctx: { waitUntil() {} },
    prepareRetryDelaysMs: [0, 0, 0],
  }), "synthetic ambiguous sessionless prepare failure");
  assert(sessionlessPrepareBridge.calls === 1 && sessionlessPrepareBridge.retryId === null,
    "sessionless legacy POST retried or received an internal replay allowance");

  const timedPrepareSocket = new TestWebSocket();
  const timedPrepareBridge = {
    calls: 0,
    async fetch(request) {
      this.calls += 1;
      const mode = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER);
      if (mode === "prepare" && this.calls === 1) {
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      if (mode === "prepare") return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      if (mode === "subscribe") return { status: 101, webSocket: timedPrepareSocket };
      throw new Error(`unexpected timed prepare mode: ${mode}`);
    },
  };
  const timedPrepare = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "Mcp-Session-Id": "signed-session-fixture" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "list_dir", arguments: {} } }),
    }),
    bridge: timedPrepareBridge,
    extraOrigins: "",
    ctx: { waitUntil() {} },
    prepareRetryDelaysMs: [0, 0],
    prepareAttemptTimeoutMs: 5,
  });
  await waitUntil(() => timedPrepareSocket.accepted);
  timedPrepareSocket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 102, result: { timed_retry: true } }) });
  assert((await timedPrepare.text()).includes('"timed_retry":true') && timedPrepareBridge.calls === 3,
    "timed-out prepare attempt did not retry through the resumable identity");

  const timedSubscribeSocket = new TestWebSocket();
  const timedSubscribeBridge = {
    calls: 0,
    async fetch(request) {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      if (this.calls === 2) {
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      return { status: 101, webSocket: timedSubscribeSocket };
    },
  };
  const timedSubscribe = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } }),
    bridge: timedSubscribeBridge,
    extraOrigins: "",
    ctx: { waitUntil() {} },
    subscribeRetryDelaysMs: [0, 0],
    subscribeAttemptTimeoutMs: 5,
  });
  await waitUntil(() => timedSubscribeSocket.accepted);
  timedSubscribeSocket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 103, result: { subscribed_after_timeout: true } }) });
  assert((await timedSubscribe.text()).includes('"subscribed_after_timeout":true') && timedSubscribeBridge.calls === 3,
    "timed-out subscription upgrade did not retry before terminal delivery");

  const invalidImmediateBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify({ not_jsonrpc: true }), { headers: { "content-type": "application/json" } });
    },
  };
  const invalidImmediate = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } }),
    bridge: invalidImmediateBridge,
    extraOrigins: "",
    ctx: { waitUntil() {} },
    subscribeRetryDelaysMs: [0, 0, 0],
  });
  assert((await invalidImmediate.text()).startsWith(": resumed\n\n") && invalidImmediateBridge.calls === 2,
    "invalid immediate terminal JSON was retried instead of failing closed once");

  const failedBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify({ error: "missing" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  };
  const failedWait = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: failedBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert((await failedWait.text()).startsWith(": resumed\n\n"), "failed internal subscription did not close the outer stream safely");

  const invalidSocket = new TestWebSocket();
  const invalidBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return { status: 101, webSocket: invalidSocket };
    },
  };
  const invalidMessage = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: invalidBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  await waitUntil(() => invalidSocket.accepted);
  invalidSocket.emit("message", { data: JSON.stringify({ not_jsonrpc: true }) });
  assert((await invalidMessage.text()).startsWith(": resumed\n\n"), "invalid internal terminal message did not close the outer stream safely");

  const firstRetrySocket = new TestWebSocket();
  const secondRetrySocket = new TestWebSocket();
  const retryBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return { status: 101, webSocket: this.calls === 2 ? firstRetrySocket : secondRetrySocket };
    },
  };
  const retriedStream = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: retryBridge, extraOrigins: "", ctx: { waitUntil() {} }, subscribeRetryDelaysMs: [0, 0],
  });
  await waitUntil(() => firstRetrySocket.accepted);
  firstRetrySocket.emit("close", {});
  await waitUntil(() => secondRetrySocket.accepted);
  secondRetrySocket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 12, result: { recovered: true } }) });
  const retriedText = await retriedStream.text();
  assert(retryBridge.calls === 3 && retriedText.includes('"recovered":true'), "bounded subscription retry did not recover a transient close");

  const modernCalls = [];
  const modernKeptAlive = [];
  let upstreamController;
  const modernBridge = {
    async fetch(request) {
      modernCalls.push(request);
      const mode = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER);
      if (mode === "modern-cancel") return new Response(null, { status: 202 });
      assert(mode === "modern-direct", "modern proxy used a legacy descriptor mode");
      const body = new ReadableStream({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  };
  const modernProxy = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_dir",
        authorization: "DPoP test-access-token",
        dpop: "test-proof",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/call", params: {} }),
    }),
    bridge: modernBridge,
    extraOrigins: "",
    ctx: { waitUntil(promise) { modernKeptAlive.push(promise); } },
  });
  const modernReader = modernProxy.body.getReader();
  assert(new TextDecoder().decode((await modernReader.read()).value) === ": connected\n\n",
    "modern proxy omitted its direct initial frame");
  await modernReader.cancel("test closed stream");
  await Promise.allSettled(modernKeptAlive);
  assert(modernCalls.length === 2
    && modernCalls[0].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-direct"
    && modernCalls[0].headers.get("authorization") === "DPoP test-access-token"
    && modernCalls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel"
    && !modernCalls[1].headers.has("authorization")
    && !modernCalls[1].headers.has("dpop"),
  "modern proxy did not isolate its credential-free cancellation control");
  const directId = modernCalls[0].headers.get(MCP_STREAM_PROXY_ID_HEADER);
  assert(directId && modernCalls[1].headers.get(MCP_STREAM_PROXY_ID_HEADER) === directId,
    "modern proxy cancellation did not preserve its stream-scoped identity");
  assert(modernCalls.every((request) => !request.headers.has("Last-Event-ID")),
    "modern proxy leaked legacy resumption headers");
  try { upstreamController.close(); } catch { /* Cancellation already closed the mock stream. */ }

  let jsonWaitUntilCalls = 0;
  const jsonProxy = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} }),
    }),
    bridge: { async fetch() {
      return new Response('{"jsonrpc":"2.0","id":91,"result":{}}', {
        headers: { "content-type": "application/json" },
      });
    } },
    extraOrigins: "",
    ctx: { waitUntil() { jsonWaitUntilCalls += 1; } },
  });
  assert(await jsonProxy.text() === '{"jsonrpc":"2.0","id":91,"result":{}}' && jsonWaitUntilCalls === 0,
    "modern proxy corrupted or treated an application/json response as SSE");

  const errorCalls = [];
  const errorKeptAlive = [];
  let errorController;
  const errorProxy = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_dir",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 92, method: "tools/call", params: {} }),
    }),
    bridge: { async fetch(request) {
      errorCalls.push(request);
      if (request.headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel") return new Response(null, { status: 202 });
      return new Response(new ReadableStream({
        start(controller) {
          errorController = controller;
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    } },
    extraOrigins: "",
    ctx: { waitUntil(promise) { errorKeptAlive.push(promise); } },
  });
  const errorReader = errorProxy.body.getReader();
  assert(new TextDecoder().decode((await errorReader.read()).value) === ": connected\n\n",
    "modern error fixture omitted its initial frame");
  errorController.error(new Error("upstream failed"));
  await errorReader.read().catch(() => {});
  await Promise.allSettled(errorKeptAlive);
  assert(errorCalls.length === 2
    && errorCalls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel",
  "modern upstream stream failure did not cancel its pending call");

  const earlyAbortController = new AbortController();
  const earlyAbortCalls = [];
  const earlyAbortKeptAlive = [];
  let resolveEarlyDirect;
  let earlyInnerCancelled = 0;
  const earlyDirect = new Promise((resolve) => { resolveEarlyDirect = resolve; });
  const earlyProxyPromise = proxyMcpEventStream({
    request: new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_dir",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 93, method: "tools/call", params: {} }),
      signal: earlyAbortController.signal,
    }),
    bridge: { async fetch(request) {
      earlyAbortCalls.push(request);
      if (request.headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel") return new Response(null, { status: 202 });
      return await earlyDirect;
    } },
    extraOrigins: "",
    ctx: { waitUntil(promise) { earlyAbortKeptAlive.push(promise); } },
  });
  await waitUntil(() => earlyAbortCalls.length === 1);
  earlyAbortController.abort("closed before internal response");
  resolveEarlyDirect(new Response(new ReadableStream({
    start() {},
    cancel() { earlyInnerCancelled += 1; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const earlyProxy = await earlyProxyPromise;
  await Promise.allSettled(earlyAbortKeptAlive);
  assert(earlyAbortCalls.length === 2
    && earlyAbortCalls[0].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-direct"
    && earlyAbortCalls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel"
    && earlyAbortCalls[0].headers.get(MCP_STREAM_PROXY_ID_HEADER) === earlyAbortCalls[1].headers.get(MCP_STREAM_PROXY_ID_HEADER)
    && earlyInnerCancelled === 1,
  "modern proxy lost an abort or retained the internal response body before public SSE startup");
  await earlyProxy.body?.cancel().catch(() => {});

  const completedCalls = [];
  const completedProxy = await proxyMcpEventStream({
    request: modernProxyRequest(94),
    bridge: { async fetch(request) {
      completedCalls.push(request);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: complete\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    } },
    extraOrigins: "", ctx: { waitUntil() {} },
  });
  assert(await completedProxy.text() === "data: complete\n\n" && completedCalls.length === 1,
    "modern proxy did not complete a healthy upstream SSE without cancellation");

  const requestAbortController = new AbortController();
  const requestAbortCalls = [];
  const requestAbortKeptAlive = [];
  let abortInnerCancelled = 0;
  const requestAbortProxy = await proxyMcpEventStream({
    request: modernProxyRequest(95, requestAbortController.signal),
    bridge: { async fetch(request) {
      requestAbortCalls.push(request);
      if (request.headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel") {
        throw new Error("simulated cancellation control outage");
      }
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")); },
        cancel() { abortInnerCancelled += 1; },
      }), { headers: { "content-type": "text/event-stream" } });
    } },
    extraOrigins: "", ctx: { waitUntil(promise) { requestAbortKeptAlive.push(promise); } },
  });
  const requestAbortReader = requestAbortProxy.body.getReader();
  await requestAbortReader.read();
  requestAbortController.abort("network closed");
  await Promise.allSettled(requestAbortKeptAlive);
  assert(requestAbortCalls.length === 2 && abortInnerCancelled === 1,
    "modern proxy request abort did not cancel the inner reader and attempt private cancellation exactly once");
  await requestAbortReader.cancel().catch(() => {});

  const rejectedAbortController = new AbortController();
  const rejectedAbortCalls = [];
  let rejectDirect;
  const rejectedProxyPromise = proxyMcpEventStream({
    request: modernProxyRequest(96, rejectedAbortController.signal),
    bridge: { async fetch(request) {
      rejectedAbortCalls.push(request);
      if (request.headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel") return new Response(null, { status: 202 });
      return await new Promise((_resolve, reject) => { rejectDirect = reject; });
    } },
    extraOrigins: "", ctx: { waitUntil(promise) { requestAbortKeptAlive.push(promise); } },
  });
  await waitUntil(() => rejectedAbortCalls.length === 1);
  rejectedAbortController.abort("closed during direct fetch");
  rejectDirect(new Error("direct request aborted"));
  await expectReject(rejectedProxyPromise, "direct request aborted");
  await Promise.allSettled(requestAbortKeptAlive);
  assert(rejectedAbortCalls.length === 2
    && rejectedAbortCalls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "modern-cancel",
  "modern proxy fetch rejection after public abort omitted private cancellation");

}

function modernProxyRequest(id, signal) {
  return new Request("https://example.test/mcp", {
    method: "POST", signal,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "list_dir",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {} }),
  });
}

async function testModernDirectStreamCancellation() {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let cancellations = 0;
  const response = modernJsonRpcResponseStream(result, {
    onCancel() { cancellations += 1; },
    onError() { return { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } }; },
  });
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert(new TextDecoder().decode(initial.value) === ": connected\n\n",
    "modern direct stream omitted its initial non-resumable frame");
  await reader.cancel("client closed response");
  await reader.cancel("duplicate close");
  assert(cancellations === 1, "modern direct stream did not cancel exactly once");
  resolveResult({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } });
  await Promise.resolve();

  const failed = modernJsonRpcResponseStream(Promise.reject(new Error("private failure details")), {
    onCancel() {},
    onError() { return { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal error" } }; },
  });
  const failureText = await failed.text();
  assert(failureText.includes('"code":-32603') && failureText.includes('"message":"Internal error"')
    && !failureText.includes("private failure details"),
  "modern response stream did not surface a privacy-safe terminal internal error");
}

function testDaemonSocketIsolation() {
  const candidate = new TestWebSocket();
  candidate.serializeAttachment({ role: "candidate", connectedAt: new Date().toISOString() });
  const subscriber = new TestWebSocket();
  subscriber.serializeAttachment({ role: "mcp_stream_subscriber", streamId: STREAM_TEST_ID });
  const registry = new DaemonSocketRegistry({ getWebSockets: () => [candidate, subscriber] });
  const sockets = registry.nonReadySockets();
  assert(sockets.length === 1 && sockets[0] === candidate, "daemon candidate cleanup captured a non-daemon stream subscriber");
}

async function testAbortSignalCleanup() {
  const registry = new PendingCallRegistry(1);
  const controller = new AbortController();
  let cancelledId = "";
  const cancelled = registry.register({
    id: "request-abort", tool: "list_dir", socket: {}, clientRequestKey: "abort-key", timeoutMs: 10_000,
    signal: controller.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: (record) => {
      cancelledId = record.id;
      return new WorkerToolError("cancelled", "client stopped waiting");
    },
  });
  assert(registry.snapshot().active === 1 && registry.hasRequestKey("abort-key"), "abortable call was not registered");
  controller.abort();
  await expectReject(cancelled, "client stopped waiting");
  assert(cancelledId === "request-abort", "abort callback received the wrong pending call");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "request abort leaked pending indexes");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const rejectedImmediately = registry.register({
    id: "already-aborted", tool: "list_dir", socket: {}, timeoutMs: 10_000,
    signal: alreadyAborted.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: () => new WorkerToolError("cancelled", "already cancelled"),
  });
  await expectReject(rejectedImmediately, "already cancelled");
  assert(registry.snapshot().active === 0, "already-aborted request entered the pending registry");
}

function testWorkerRuntimeConfig() {
  assert(workerBodyLimitBytes(undefined) === 8 * 1024 * 1024, "missing Worker body limit did not use the safe default");
  assert(workerBodyLimitBytes("0") === 8 * 1024 * 1024, "zero Worker body limit bypassed the safe default");
  assert(workerBodyLimitBytes("1048576") === 1024 * 1024, "valid Worker body limit was not preserved");
  assert(workerBodyLimitBytes(String(32 * 1024 * 1024)) === 16 * 1024 * 1024, "Worker body limit exceeded the hard maximum");
}

function testRelayTimeoutContract() {
  assert(relayContract.reconnectGraceMs === 120_000, "relay reconnect grace drifted from the incident-tested budget");
  assert(relayContract.streamHeartbeatMs === 10_000, "SSE heartbeat interval drifted from the idle-connection contract");
  assert(relayContract.streamResumeRetentionMs === 120_000, "resumable result retention drifted from the bounded recovery window");
  assert(relayContract.maximumResumableStreams === 64, "resumable stream capacity drifted from the bounded Worker contract");
  assert(relayContract.maximumResumableMessageBytes === 1_500_000, "resumable message storage exceeded the Durable Object row budget");
  assert(relayContract.workerSettlementOverheadMs === 5_000
    && !("toolCallOverheadMs" in relayContract),
  "Worker settlement overhead retained its ambiguous execution-budget name");
  const bootstrapBudget = daemonToolTimeoutBudget("session_bootstrap", {});
  assert(bootstrapBudget.executionTimeoutMs === 10_000 && bootstrapBudget.settlementTimeoutMs === 15_000,
    "bootstrap execution and settlement deadlines were not separated");
  const ordinaryBudget = daemonToolTimeoutBudget("read_file", {});
  assert(ordinaryBudget.executionTimeoutMs === 60_000 && ordinaryBudget.settlementTimeoutMs === 65_000,
    "ordinary tool execution consumed its Worker settlement margin");
  assert(relayContract.maximumInteractiveExecutionTimeoutMs === 60_000, "interactive relay deadline lost its host-delivery margin");
  assert(REMOTE_FOREGROUND_TIMEOUT_SECONDS === 60, "remote foreground schema limit drifted from the relay execution budget");
  const defaultExecBudget = daemonToolTimeoutBudget("exec_command", {});
  assert(defaultExecBudget.executionTimeoutMs === 60_000 && defaultExecBudget.settlementTimeoutMs === 65_000,
    "remote configurable tool default lost its delivery margin");
  const maximumExecBudget = daemonToolTimeoutBudget("exec_command", { timeout_seconds: 60 });
  assert(maximumExecBudget.executionTimeoutMs === 60_000 && maximumExecBudget.settlementTimeoutMs === 65_000,
    "maximum accepted foreground timeout did not reserve settlement time");
  for (const requested of [61, 85, 120, 600]) {
    let rejected;
    try { daemonToolTimeoutBudget("exec_command", { timeout_seconds: requested }); }
    catch (error) { rejected = error; }
    assert(rejected instanceof WorkerToolError && rejected.code === "invalid_request" && rejected.retryable === false,
      `remote foreground timeout ${requested} was not rejected before dispatch`);
    assert(rejected.details?.side_effects_started === false && rejected.details?.maximum_foreground_timeout_seconds === 60,
      `remote foreground timeout ${requested} omitted the no-side-effect contract`);
  }
  for (const requested of [0, -1, 1.5, "60", null, {}, Number.NaN]) {
    let rejected;
    try { daemonToolTimeoutBudget("exec_command", { timeout_seconds: requested }); }
    catch (error) { rejected = error; }
    assert(rejected instanceof WorkerToolError && rejected.code === "invalid_request" && rejected.retryable === false,
      `malformed remote foreground timeout ${String(requested)} was not rejected before dispatch`);
    assert(rejected.details?.side_effects_started === false
      && rejected.details?.minimum_foreground_timeout_seconds === 1
      && rejected.details?.maximum_foreground_timeout_seconds === 60,
    `malformed remote foreground timeout ${String(requested)} omitted its strict pre-dispatch bounds`);
  }
  const validArguments = validateWorkerToolArguments("read_file", { path: "fixture.txt" });
  assert(validArguments.known && validArguments.valid, "Worker tool argument validator rejected a valid catalog call");
  const invalidArguments = validateWorkerToolArguments("read_file", { path: "fixture.txt", unexpected: true });
  assert(invalidArguments.known && !invalidArguments.valid
    && invalidArguments.issues.some((issue) => issue.keyword === "additionalProperties"),
  "Worker tool argument validator accepted an unknown field or lost its stable issue keyword");
  assert(validateWorkerToolArguments("missing_tool", {}).known === false,
    "Worker tool argument validator treated an unknown tool as a known schema");
  const configurableRemoteTools = workspaceTools.filter((tool) => tool.inputSchema?.properties?.timeout_seconds);
  for (const tool of configurableRemoteTools) {
    const timeout = tool.inputSchema.properties.timeout_seconds;
    const expectedDefault = remoteForegroundDefaultSeconds(tool.name);
    assert(timeout.maximum === 60 && timeout.default === expectedDefault,
      `remote ${tool.name} schema drifted from its hosted timeout contract`);
    const budget = daemonToolTimeoutBudget(tool.name, {});
    assert(budget.executionTimeoutMs === expectedDefault * 1000
      && budget.settlementTimeoutMs === expectedDefault * 1000 + relayContract.workerSettlementOverheadMs,
    `remote ${tool.name} runtime default did not preserve a distinct settlement margin`);
  }
  const remoteExec = workspaceTools.find((tool) => tool.name === "exec_command");
  assert(String(remoteExec?.description || "").includes("managed jobs"),
    "remote exec_command description omitted the durable execution path");
  assert(relayContract.maximumRelayToolTimeoutMs === 610_000, "local relay envelope ceiling drifted from the Worker contract");
}

function testWorkerPolicyParity() {
  const review = sanitizeDaemonPolicy({ profile: "review", origin: "explicit", revision: 4, allowWrite: false, execMode: "off" });
  const agent = sanitizeDaemonPolicy({ profile: "agent", origin: "explicit", revision: 4, allowWrite: true, execMode: "direct" });
  const noWriteDirect = sanitizeDaemonPolicy({ profile: "custom", origin: "custom", revision: 4, allowWrite: false, execMode: "direct" });
  assert(policyAllowsAvailability(review, "always"), "Worker review lost always tools");
  assert(!policyAllowsAvailability(review, "write"), "Worker review gained writes");
  assert(policyAllowsAvailability(agent, "write+direct-exec"), "Worker agent lost compound capability");
  assert(!policyAllowsAvailability(noWriteDirect, "write+direct-exec"), "Worker custom no-write policy can start jobs");
  const reviewTools = new Set(sanitizeDaemonTools(["read_file", "write_file", "list_jobs", "start_job"], review));
  assert(reviewTools.has("read_file") && reviewTools.has("list_jobs"), "Worker removed read-only tools from review");
  assert(!reviewTools.has("write_file") && !reviewTools.has("start_job"), "Worker accepted denied tools from daemon hello");
}

function testPrototypeSafeFormFields() {
  const value = searchParamsObject(new URLSearchParams("constructor=first&constructor=second&__proto__=plain"));
  assert(Object.getPrototypeOf(value) === null, "form field aggregation retained Object.prototype");
  assert(Array.isArray(value.constructor) && value.constructor.join(",") === "first,second", "constructor form field was not treated as ordinary data");
  assert(value.__proto__ === "plain", "__proto__ form field was not treated as ordinary data");
}

function testMcpJsonRpcProtocol() {
  const request = { jsonrpc: "2.0", id: "request-1", method: "tools/list", params: {} };
  assert(isJsonRpcRequest(request), "valid JSON-RPC request was rejected");
  assert(!isJsonRpcRequest({ ...request, method: "" }), "empty JSON-RPC method was accepted");
  assert(!isJsonRpcRequest({ ...request, id: Number.POSITIVE_INFINITY }), "non-finite JSON-RPC id was accepted");
  assert(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} }), "valid JSON-RPC response was rejected");
  assert(!isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {}, error: {} }), "ambiguous JSON-RPC response was accepted");
  assert(rpcResult(undefined, {}) === null, "JSON-RPC notification unexpectedly produced a response");
  assert(rpcResult(null, { ok: true })?.id === null, "JSON-RPC null id was not preserved");
  assert(rpcError(undefined, -32600, "invalid").id === null, "JSON-RPC error omitted the null fallback id");
  const structured = textToolResult({ $mcp: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } });
  assert(structured.structuredContent?.ok === true, "special MCP tool result lost structured content");
  const ordinary = textToolResult({ ok: true });
  assert(ordinary.structuredContent?.ok === true && ordinary.content[0].type === "text", "ordinary tool result lost text or structured content");
  for (const value of [[1], "text", 0, false, null]) {
    const projected = textToolResult(value);
    assert(Object.hasOwn(projected, "structuredContent") && JSON.stringify(projected.structuredContent) === JSON.stringify(value),
      `ordinary structuredContent lost JSON value ${JSON.stringify(value)}`);
    const rich = textToolResult({ $mcp: { content: [{ type: "text", text: "ok" }], structuredContent: value } });
    assert(Object.hasOwn(rich, "structuredContent") && JSON.stringify(rich.structuredContent) === JSON.stringify(value),
      `rich structuredContent lost JSON value ${JSON.stringify(value)}`);
  }
  assert(Object.keys(asObject(null)).length === 0, "non-object params were not normalized");
  assert(requiredString({ name: " read_file " }, "name") === "read_file", "required string was not normalized");
  expectThrow(() => requiredString({}, "name"), "non-empty string");
  assert(sessionInstructionText({ instructions: "local guidance" }) === "local guidance", "session instructions were not extracted");
  assert(sessionInstructionText({ instructions: "x".repeat(3 * 1024 * 1024 + 1) }) === "", "oversized session instructions were accepted");
  const supported = ["2025-11-25"];
  const initialize = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": "unsupported" } });
  assert(validateProtocolVersionHeader(initialize, { ...request, method: "initialize" }, supported) === null, "initialize was rejected before protocol negotiation");
  const accepted = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": supported[0] } });
  assert(validateProtocolVersionHeader(accepted, request, supported) === null, "supported MCP protocol header was rejected");
  const rejected = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": "unsupported" } });
  assert(validateProtocolVersionHeader(rejected, request, supported)?.error?.code === -32602, "unsupported MCP protocol header did not return the expected error");
}

function testWebSocketProtocol() {
  const trySent = [];
  assert(trySendWebSocket({ send(value) { trySent.push(value); } }, { type: "pong" }) === true, "successful WebSocket send was reported as failed");
  assert(JSON.parse(trySent[0]).type === "pong", "WebSocket send helper serialized the wrong payload");
  assert(trySendWebSocket({ send() { throw new Error("closed"); } }, { type: "pong" }) === false, "failed WebSocket send was reported as successful");
  const sent = [];
  const closed = [];
  const socket = {
    send(value) { sent.push(value); },
    close(code, reason) { closed.push({ code, reason }); },
  };
  assert(isObjectRecord({ type: "hello" }) && !isObjectRecord([]) && !isObjectRecord(null), "daemon record guard accepted an invalid shape");
  assert(daemonErrorCloseCode("daemon_transport_error") === 1012
    && daemonErrorCloseCode("daemon_liveness_timeout") === 1012,
  "retryable daemon invalidation did not use a reconnect-oriented close code");
  assert(daemonErrorCloseCode("daemon_ready_timeout") === 1008
    && daemonErrorCloseCode("daemon_authentication_failed") === 1008,
  "policy or readiness errors lost their policy-oriented close code");
  sendWebSocketQuietly(socket, { type: "pong" });
  rejectDaemonMessage(socket, "invalid_message", 1002, "invalid daemon message");
  closeWebSocketQuietly(socket, 1000, "done");
  assert(JSON.parse(sent[0]).type === "pong" && JSON.parse(sent[1]).error === "invalid_message", "WebSocket protocol helper lost payloads");
  assert(closed[0].code === 1002 && closed[1].code === 1000, "WebSocket close helper lost close metadata");
  const throwing = { send() { throw new Error("closed"); }, close() { throw new Error("closed"); } };
  sendWebSocketQuietly(throwing, "ignored");
  closeWebSocketQuietly(throwing);
}

function testWorkerErrors() {
  const structured = daemonToolError({
    code: "limit_exceeded", message: "busy", retryable: true,
    details: { process: { output_session_id: "proc_worker_detail_123456789012" } },
  });
  assert(structured.code === "limit_exceeded" && structured.retryable, "daemon structured error was not preserved");
  const publicValue = publicWorkerToolError(structured);
  assert(publicValue.code === "limit_exceeded" && publicValue.message === "busy", "Worker public error lost stable fields");
  assert(publicValue.details?.process?.output_session_id === "proc_worker_detail_123456789012", "Worker error adapter lost safe process continuation details");
  const fileConflict = publicWorkerToolError(daemonToolError({
    code: "conflict", message: "file exists and create_only=true", retryable: false,
    details: { reason: "already_exists" },
  }));
  assert(fileConflict.code === "conflict"
    && fileConflict.retryable === false
    && fileConflict.details?.reason === "already_exists",
  "Worker error adapter lost the typed file-conflict contract");
  const unknown = daemonToolError({ code: "caller_defined_code", message: "unsupported" });
  assert(unknown.code === "execution_failed", "Worker accepted an unregistered daemon error code");
  const directUnknown = new WorkerToolError("future_custom_code", "unsupported");
  assert(directUnknown.code === "execution_failed", "WorkerToolError accepted an unregistered direct code");
  const hidden = publicWorkerToolError(new Error("private internal details"));
  assert(hidden.message === "tool execution failed" && !hidden.message.includes("private"), "Worker exposed raw internal exception text");
}

function testWorkerObservability() {
  const assertDecision = (actual, expected, message) => assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)}`,
  );
  assertDecision(daemonTerminalResultDecision(true), {
    matched: true, acknowledge: true, disposition: "transient_committed",
  }, "transient result decision changed");
  assertDecision(daemonTerminalResultDecision(false, "committed"), {
    matched: true, acknowledge: true, disposition: "durable_committed",
  }, "durable result decision changed");
  assertDecision(daemonTerminalResultDecision(false, "missing"), {
    matched: false, acknowledge: true, disposition: "owner_missing_acknowledged",
  }, "owner-missing result decision changed");
  assertDecision(daemonTerminalResultDecision(false, "stale"), {
    matched: false, acknowledge: false, disposition: "stale_connection_rejected",
  }, "stale result decision changed");
  assertDecision(daemonTerminalResultDecision(false), {
    matched: false, acknowledge: false, disposition: "stale_connection_rejected",
  }, "result without a verified connection was not rejected");
  const metrics = new WorkerObservability();
  metrics.requestFinished(200);
  metrics.requestFinished(403);
  metrics.requestFinished(503);
  metrics.callStarted("read_file");
  metrics.callFinished("read_file");
  metrics.callStarted("write_file");
  metrics.callFinished("write_file", "policy_denied");
  metrics.daemonTerminalResult("transient_committed");
  metrics.daemonTerminalResult("durable_committed");
  metrics.daemonTerminalResult("owner_missing_acknowledged");
  metrics.daemonTerminalResult("stale_connection_rejected");
  metrics.recordError("session_bootstrap_failed");
  metrics.socketCandidate();
  metrics.socketAuthenticated();
  metrics.socketDisconnected();
  metrics.socketProtocolError("protocol_error");
  metrics.oauthRefreshEvent("rotated");
  metrics.oauthRefreshEvent("retry_issued");
  metrics.streamTerminalPublished(0);
  metrics.streamTerminalPublished(2);
  metrics.streamTerminalStorageResponse();
  metrics.streamTerminalStorageRaceDelivery(true);
  metrics.streamTerminalStorageRaceDelivery(false);
  metrics.streamStorageRowsWritten(4);
  metrics.runtimeAlarmMutation("set");
  metrics.runtimeAlarmMutation("noop");
  const snapshot = metrics.snapshot();
  assert(snapshot.metric_scope.lifecycle === "current_worker_isolate"
    && snapshot.metric_scope.durable_calls_may_cross_isolates === true
    && snapshot.metric_scope.counters_may_not_balance === true
    && snapshot.metric_scope.unmatched_results_is_legacy_aggregate === true,
  "Worker metrics do not disclose their isolate-local time domain or compatibility aggregate");
  assert(snapshot.requests.total === 3 && snapshot.requests.client_error === 1 && snapshot.requests.server_error === 1, "Worker request metrics are incomplete");
  assert(snapshot.calls.started === 2 && snapshot.calls.completed === 1 && snapshot.calls.failed === 1, "Worker call metrics are incomplete");
  assert(snapshot.calls.unmatched_results === 2, "Worker unmatched-result compatibility aggregate was not retained");
  assert(snapshot.terminal_results.transient_committed === 1
    && snapshot.terminal_results.durable_committed === 1
    && snapshot.terminal_results.owner_missing_acknowledged === 1
    && snapshot.terminal_results.stale_connection_rejected === 1,
  "Worker terminal-result dispositions were not retained independently");
  assert(snapshot.errors.policy_denied === 1 && snapshot.errors.protocol_error === 1
    && snapshot.errors.session_bootstrap_failed === 1, "Worker error-code metrics are incomplete");
  assert(snapshot.tools.read_file.completed === 1 && snapshot.tools.write_file.failed === 1, "Worker per-tool metrics are incomplete");
  assert(snapshot.sockets.candidates === 1 && snapshot.sockets.authenticated === 1 && snapshot.sockets.disconnected === 1, "Worker socket metrics are incomplete");
  assert(snapshot.oauth_refresh.rotated === 1 && snapshot.oauth_refresh.retry_issued === 1, "OAuth refresh metrics are incomplete");
  assert(snapshot.stream_transport.legacy_internal_terminal_publications === 2
    && snapshot.stream_transport.legacy_internal_live_subscriber_sends === 2
    && snapshot.stream_transport.legacy_internal_publications_without_live_subscriber === 1
    && snapshot.stream_transport.legacy_internal_storage_responses === 1
    && snapshot.stream_transport.legacy_internal_storage_race_sends === 1
    && snapshot.stream_transport.legacy_internal_storage_race_send_failures === 1,
  "Worker stream metrics conflate publication, storage response, or internal delivery races");
  assert(snapshot.durable_budget.stream_rows_written_estimate === 4 && snapshot.durable_budget.alarm_sets === 1
    && snapshot.durable_budget.alarm_noops === 1, "Durable Object budget metrics are incomplete");

  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    metrics.event("warn", "security.test", {
      access_token: "must-not-leak",
      path: "/mcp",
      detail: "Bearer abcdefghijklmnopqrstuvwxyz for operator@example.com under /Users/example/private",
      level: "info",
      component: "caller",
      event: "caller.override",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
  } finally {
    console.warn = originalWarn;
  }
  const event = JSON.parse(lines[0]);
  assert(event.access_token === "<redacted>" && !lines[0].includes("must-not-leak"), "Worker structured event leaked a sensitive field");
  assert(event.path === "/mcp", "Worker structured event removed a safe route field");
  assert(!lines[0].includes("abcdefghijklmnopqrstuvwxyz") && !lines[0].includes("operator@example.com") && !lines[0].includes("/Users/example"), "Worker structured event leaked a sensitive value embedded in a non-sensitive field");
  assert(event.detail.includes("Bearer <redacted>") && event.detail.includes("<redacted-email>") && event.detail.includes("<home>"), "Worker structured event did not retain redaction markers");
  assert(event.level === "warn" && event.component === "worker" && event.event === "security.test" && event.timestamp !== "1970-01-01T00:00:00.000Z", "Worker event fields overrode authoritative log metadata");
}

function tamperSessionId(value) {
  const signatureStart = value.lastIndexOf("_") + 1;
  const replacement = value[signatureStart] === "A" ? "B" : "A";
  return `${value.slice(0, signatureStart)}${replacement}${value.slice(signatureStart + 1)}`;
}

function expectRegistrationError(operation, code, retryable) {
  try { operation(); } catch (error) {
    assert(error?.code === code && error?.retryable === retryable, `expected pending registration error ${code}`);
    return;
  }
  throw new Error(`expected pending registration error ${code}`);
}

async function expectReject(promise, expected) {
  try { await promise; } catch (error) { assert(String(error?.message || error).includes(expected), `expected ${expected}`); return; }
  throw new Error(`expected rejection containing ${expected}`);
}
async function expectRejectType(promise, constructor) {
  try { await promise; } catch (error) { assert(error instanceof constructor, `expected ${constructor.name}`); return; }
  throw new Error(`expected rejection of type ${constructor.name}`);
}
async function waitUntil(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error("condition did not become true");
}

function sequencePollStore(outcomes) {
  let index = 0;
  return {
    async pollMessage() {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome;
    },
  };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function expectThrow(operation, expected) { try { operation(); } catch (error) { assert(String(error?.message || error).includes(expected), `expected ${expected}`); return; } throw new Error(`expected throw containing ${expected}`); }

function testDaemonLiveness() {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  assert(isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 1_000).toISOString(),
    lastSeenAt: new Date(now - 1_000).toISOString(),
  }, now), "fresh heartbeat should keep daemon live");
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 120_000).toISOString(),
    lastSeenAt: new Date(now - 120_000).toISOString(),
  }, now), "silent authenticated socket must not stay live");
  assert(!isLiveDaemonAttachment({
    role: "candidate",
    connectedAt: new Date(now).toISOString(),
  }, now), "candidates are not live daemons");
  assert(isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 30_000).toISOString(),
  }, now), "legacy attachments without lastSeenAt fall back to connectedAt");
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 120_000).toISOString(),
  }, now), "legacy silent attachments without lastSeenAt must not stay live");
  assert(daemonLivenessDeadlineMs({
    role: "daemon",
    connectedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  }) === now + DAEMON_LIVENESS_TIMEOUT_MS, "liveness deadline must be lastSeen + timeout");
  assert(isFreshDaemonCandidate(new Date(now - 1_000).toISOString(), now), "fresh candidate should be accepted");
  assert(!isFreshDaemonCandidate(new Date(now - 20_000).toISOString(), now), "stale candidate should be rejected");
  const touched = withDaemonLastSeenAt({
    role: "daemon",
    connectedAt: "2026-07-17T11:00:00.000Z",
  }, "2026-07-17T12:00:00.000Z");
  assert(touched.lastSeenAt === "2026-07-17T12:00:00.000Z", "lastSeenAt helper did not preserve timestamp");
}

function testThrottledEdgeLogger() {
  let now = 1_000;
  const lines = [];
  const log = createThrottledEdgeLogger({
    intervalMs: 100,
    now: () => now,
    write: (level, text) => lines.push({ level, value: JSON.parse(text) }),
  });
  assert(log("warn", "rate.failure", { detail: "first\nline", access_token: "must-not-leak" }) === true, "first edge degradation log was suppressed");
  assert(log("warn", "rate.failure", { detail: "second" }) === false, "duplicate edge degradation log was not suppressed");
  assert(log("warn", "rate.failure", { detail: "third" }) === false, "repeated edge degradation log was not suppressed");
  now += 100;
  assert(log("warn", "rate.failure", { detail: "reopened" }) === true, "edge degradation log did not reopen after its interval");
  assert(lines.length === 2 && lines[1].value.suppressed === 2, "edge log did not report its suppressed duplicate count");
  assert(lines[0].value.detail === "first_line" && lines[0].value.component === "worker-edge"
    && lines[0].value.access_token === "<redacted>" && !JSON.stringify(lines[0]).includes("must-not-leak"),
  "edge log did not bound controls, redact sensitive fields, or preserve authoritative metadata");
}

async function testWorkerStaticRoutes() {
  const identity = { server: "machine-bridge-mcp", version: "3.0.0-beta.18" };
  const health = respondWithoutDurableObject(new Request("https://example.test/healthz"), identity);
  assert(health?.status === 200, "healthz must be served without Durable Object state");
  assert((await health.json()).version === identity.version, "healthz version must match package identity");

  const root = respondWithoutDurableObject(new Request("https://example.test/"), identity);
  assert(root?.status === 200, "root must be served without Durable Object state");
  assert((await root.json()).mcp === "https://example.test/mcp", "root must advertise the MCP path");

  const preflight = respondWithoutDurableObject(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, dpop, last-event-id",
    },
  }), identity);
  assert(preflight?.status === 204, "CORS preflight must not depend on Durable Object state");
  assert(preflight.headers.get("access-control-allow-origin") === "https://chatgpt.com", "CORS preflight lost origin allowlist");

  const undeclaredParameterHeader = respondWithoutDurableObject(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, mcp-param-secret",
    },
  }), identity);
  assert(undeclaredParameterHeader?.status === 403, "CORS reflected an undeclared MCP parameter header");

  const declaredParameterHeader = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, Mcp-Param-Region",
    },
  }), "https://example.test", "", new Set(["mcp-param-region"]));
  assert(declaredParameterHeader.status === 204
    && declaredParameterHeader.headers.get("access-control-allow-headers")?.includes("mcp-param-region"),
  "CORS rejected a schema-declared MCP parameter header");

  const malformedParameterHeader = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, invalid header",
    },
  }), "https://example.test", "");
  assert(malformedParameterHeader.status === 400, "CORS accepted a malformed requested header name");

  const excessiveNames = Array.from({ length: 65 }, (_, index) => `mcp-param-${index}`);
  const excessiveParameterHeaders = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": excessiveNames.join(","),
    },
  }), "https://example.test", "", new Set(excessiveNames));
  assert(excessiveParameterHeaders.status === 400, "CORS accepted an excessive requested-header set");

  for (const path of ["/.well-known/mcp.json", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    const metadata = respondWithoutDurableObject(new Request(`https://example.test${path}`), identity);
    assert(metadata?.status === 200, `${path} unexpectedly consumed Durable Object state`);
  }
  const missing = respondWithoutDurableObject(new Request("https://example.test/random-scan-path"), identity);
  assert(missing?.status === 404, "unknown public route reached the Durable Object");

  for (const [path, method] of [
    ["/mcp", "POST"], ["/mcp", "GET"], ["/daemon/ws", "GET"], ["/oauth/token", "POST"],
    ["/oauth/authorize", "GET"], ["/oauth/authorize", "POST"], ["/oauth/register", "POST"],
    ["/admin/accounts", "GET"], ["/admin/accounts", "PATCH"], ["/admin/clients", "DELETE"],
  ]) {
    const passthrough = respondWithoutDurableObject(new Request(`https://example.test${path}`, { method }), identity);
    assert(passthrough === null, `${method} ${path} no longer reaches stateful routing`);
  }
  for (const [path, method, allow] of [
    ["/mcp", "HEAD", "GET, POST"], ["/daemon/ws", "POST", "GET"], ["/oauth/token", "DELETE", "POST"],
    ["/admin/clients", "PATCH", "GET, DELETE"],
  ]) {
    const rejected = respondWithoutDurableObject(new Request(`https://example.test${path}`, { method }), identity);
    assert(rejected?.status === 405 && rejected.headers.get("allow") === allow,
      `${method} ${path} consumed rate-limit or Durable Object capacity before method rejection`);
  }

  let observedGlobalKey = "";
  const globallyAllowed = await admitGlobalStatefulRequest(new Request("https://example.test/mcp"), {
    async limit({ key }) { observedGlobalKey = key; return { success: true }; },
  });
  assert(globallyAllowed === null && observedGlobalKey === "stateful:global:mcp:example.test",
    "global stateful rate limiter lost its route and Worker scope");
  const firstAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }));
  const repeatedAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }));
  const secondAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-two" },
  }));
  assert(firstAuthenticatedKey === repeatedAuthenticatedKey && firstAuthenticatedKey !== secondAuthenticatedKey,
    "stateful rate-limit identity was not stable and isolated per credential");
  assert(!firstAuthenticatedKey.includes("synthetic-secret"), "stateful rate-limit key exposed credential material");
  const oauthNetworkKey = await statefulRateLimitKey(new Request("https://example.test/oauth/token", {
    headers: { "cf-connecting-ip": "192.0.2.10" },
  }));
  assert(oauthNetworkKey.startsWith("stateful:oauth:network:") && !oauthNetworkKey.includes("192.0.2.10"),
    "anonymous stateful rate-limit key exposed or mis-scoped the network identity");
  let observedRateLimitKey = "";
  const allowed = await admitStatefulRequest(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }), { async limit({ key }) { observedRateLimitKey = key; return { success: true }; } });
  assert(allowed === null && observedRateLimitKey === firstAuthenticatedKey,
    "stateful rate limiter rejected an admitted request or used the wrong subject bucket");
  const limited = await admitStatefulRequest(new Request("https://example.test/mcp"), { async limit() { return { success: false }; } });
  assert(limited?.status === 429 && limited.headers.get("retry-after") === "60", "stateful rate limiter lost its retry contract");
  const limiterFailure = await admitStatefulRequest(new Request("https://example.test/mcp"), { async limit() { throw new Error("synthetic limiter outage"); } });
  assert(limiterFailure === null, "rate-limiter outage disconnected authenticated traffic instead of failing open");

  assert(isDurableObjectQuotaError(new Error("Exceeded allowed volume of requests in Durable Objects free tier.")), "quota error detector missed free-tier exhaustion");
  assert(isDurableObjectQuotaError(new Error("outer", { cause: Object.assign(new Error("quota"), { code: "ERR_DURABLE_OBJECT_QUOTA_EXCEEDED" }) })), "quota detector missed a structured nested error");
  assert(!isDurableObjectQuotaError(new Error("socket closed")), "quota error detector over-matched");
  const cyclic = new Error("cyclic");
  cyclic.cause = cyclic;
  assert(!isDurableObjectQuotaError(cyclic), "quota detector did not bound a cyclic cause chain");
  assert(outerWorkerErrorClass(cyclic) === "error", "outer error classification did not bound a cyclic cause chain");
  let deep = Object.assign(new Error("deep"), { code: "DEEPEST" });
  for (let index = 0; index < 12; index += 1) deep = new Error(`level-${index}`, { cause: deep });
  assert(!outerWorkerErrorClass(deep).includes("deepest"), "outer error classification exceeded its cause-depth bound");
  const quota = durableObjectQuotaResponse(new Request("https://example.test/mcp", { headers: { Origin: "https://chatgpt.com" } }));
  assert(quota.status === 503, "quota response must be retryable service unavailable");
  assert((await quota.json()).error === "durable_object_quota_exceeded", "quota response body is wrong");
  const gateway = workerGatewayErrorResponse(new Request("https://example.test/mcp"));
  assert(gateway.status === 502 && (await gateway.json()).error === "worker_gateway_error", "outer Worker did not normalize unexpected failures");
  assert(outerWorkerErrorClass(Object.assign(new Error("secret-value-must-not-appear"), { code: "ECONNRESET" })) === "error:econnreset", "outer error class included sensitive exception text");
}
