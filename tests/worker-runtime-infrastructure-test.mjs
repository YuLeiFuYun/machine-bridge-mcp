import { PendingCallRegistry } from "../src/worker/pending-calls.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "../src/worker/runtime-alarm.ts";
import { buildServerInfoResult, persistImmediateStreamOutcome, startEventDrivenStreamCall } from "../src/worker/mcp-stream-dispatch.ts";
import { createMcpSessionId, validateMcpSessionId } from "../src/worker/mcp-session.ts";
import { acceptsEventStream, resumeJsonRpcResponse, streamJsonRpcResponse } from "../src/worker/mcp-stream.ts";
import {
  MCP_STREAM_PROXY_ID_HEADER, MCP_STREAM_PROXY_MODE_HEADER,
  handleMcpStreamPollRequest, mcpStreamDescriptorResponse, mcpStreamProxyId, mcpStreamProxyMode,
  proxyMcpEventStream, sanitizeBridgeRequest,
} from "../src/worker/mcp-stream-proxy.ts";
import { daemonToolTimeoutMs } from "../src/worker/tool-timeout.ts";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../src/worker/policy.ts";
import { WorkerObservability } from "../src/worker/observability.ts";
import { searchParamsObject } from "../src/worker/http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  sessionInstructionText, textToolResult, validateProtocolVersionHeader,
} from "../src/worker/mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly, trySendWebSocket,
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

await testMcpSessions();
await testRequestKeyReuse();
await testRegistrationFailures();
await testTerminalPaths();
await testReconnectRebinding();
await testDetachedTimeoutPause();
await testEventBoundaryDeadlineSweep();
await testRuntimeAlarmCoordinator();
await testTimeoutCallbackFailure();
await testEventDrivenPendingCalls();
await testEventDrivenStreamDispatch();
await testStreamDispatchFailureBoundaries();
await testAbortSignalCleanup();
await testMcpStreamResponse();
await testMcpStreamProxy();
testRelayTimeoutContract();
testWorkerPolicyParity();
testWorkerErrors();
testWorkerObservability();
testPrototypeSafeFormFields();
testMcpJsonRpcProtocol();
testWebSocketProtocol();
testDaemonLiveness();
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
  const scheduler = {
    setTimeout() { return nextTimer++; },
    clearTimeout() {},
  };
  const outcomes = [];
  const socket = {};
  const registry = new PendingCallRegistry(1, { now: () => now, scheduler });
  registry.registerEvent({
    id: "event-sweep-timeout", tool: "exec_command", socket, daemonInstanceId: "daemon_sweep_12345678",
    clientRequestKey: "event:sweep-timeout", timeoutMs: 100,
    onTimeout: () => new WorkerToolError("timeout", "event-boundary operation timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  assert(registry.nextDeadlineDelayMs() === 100, "pending registry did not expose the operation deadline for Durable Object alarm scheduling");
  now = 100;
  assert(await registry.expireDue() === 1, "event-boundary sweep did not expire an overdue attached call");
  assert(outcomes.at(-1).ok === false && outcomes.at(-1).error.code === "timeout", "event-boundary sweep lost the operation timeout error");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "event-boundary operation sweep leaked indexes");

  registry.registerEvent({
    id: "event-sweep-reconnect", tool: "exec_command", socket, daemonInstanceId: "daemon_sweep_12345678",
    clientRequestKey: "event:sweep-reconnect", timeoutMs: 500,
    onTimeout: () => new Error("operation timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  assert(registry.detachSocket(socket, 120, () => new WorkerToolError("unavailable", "event-boundary reconnect timeout", true)) === 1, "event-boundary sweep setup did not detach the call");
  assert(registry.nextDeadlineDelayMs() === 120, "pending registry did not expose the reconnect deadline for Durable Object alarm scheduling");
  now = 220;
  assert(await registry.expireDue() === 1, "event-boundary sweep did not expire an overdue detached call");
  assert(outcomes.at(-1).ok === false && outcomes.at(-1).error.message === "event-boundary reconnect timeout", "event-boundary sweep lost the reconnect timeout error");
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
  const context = {
    storage: {
      async setAlarm(value) { scheduled.push(Number(value)); },
      async deleteAlarm() { deleted += 1; },
    },
    pending,
    daemonRegistry,
    async invalidateDaemonSocket() { throw new Error("empty socket registry must not invalidate a daemon"); },
    onScheduleError() { scheduleErrors += 1; },
  };

  await scheduleRuntimeAlarm(context, 1000);
  assert(scheduled.length === 1 && scheduled[0] === 1075, "runtime alarm did not schedule the earliest pending deadline");
  assert(deleted === 0 && expired === 0, "alarm scheduling unexpectedly mutated pending state");

  pendingDelay = Number.POSITIVE_INFINITY;
  await processRuntimeAlarm(context, 2000);
  assert(expired === 1, "runtime alarm did not sweep overdue pending calls before rescheduling");
  assert(deleted === 1, "runtime alarm did not remove an alarm when no deadline remained");

  pendingDelay = 10;
  const failingContext = {
    ...context,
    storage: { async setAlarm() { throw new Error("synthetic alarm storage failure"); }, async deleteAlarm() {} },
  };
  await scheduleRuntimeAlarm(failingContext, 3000);
  assert(scheduleErrors === 1, "runtime alarm scheduling failure was not reported through the bounded callback");
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

async function testEventDrivenPendingCalls() {
  const socketA = {};
  const socketB = {};
  const outcomes = [];
  const registry = new PendingCallRegistry(4);
  const registration = registry.registerEvent({
    id: "event-success", tool: "list_dir", socket: socketA, daemonInstanceId: "daemon_event_12345678",
    clientRequestKey: "event:success", timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  assert(registration === undefined, "event registration returned a terminal promise");
  assert(outcomes.length === 0 && registry.snapshot().active === 1 && registry.hasRequestKey("event:success"), "event registration settled before a later event");
  assert(await registry.resolve("event-success", socketA, { ok: true }), "event result was not matched");
  assert(outcomes.length === 1 && outcomes[0].ok === true && outcomes[0].value.ok === true, "event result settlement lost its value");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "event success leaked pending indexes");

  registry.registerEvent({
    id: "event-cancel", tool: "list_dir", socket: socketA, clientRequestKey: "event:cancel",
    timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  assert(await registry.cancelRequest("event:cancel", () => new WorkerToolError("cancelled", "cancelled by test")), "event cancellation missed its request key");
  assert(outcomes.at(-1).ok === false && outcomes.at(-1).error.code === "cancelled", "event cancellation lost its stable error");

  registry.registerEvent({
    id: "event-reconnect", tool: "exec_command", socket: socketA, daemonInstanceId: "daemon_event_reconnect_1234",
    clientRequestKey: "event:reconnect", timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  assert(registry.detachSocket(socketA, 10_000, () => new Error("reconnect expired")) === 1, "event call did not detach");
  assert(registry.snapshot().detached === 1 && outcomes.length === 2, "detached event call settled prematurely");
  assert(registry.rebindInstance("daemon_event_reconnect_1234", socketB)[0] === "event-reconnect", "event call did not rebind to the same daemon instance");
  assert(await registry.resolve("event-reconnect", socketB, { resumed: true }), "rebound event call did not settle");
  assert(outcomes.at(-1).ok === true && outcomes.at(-1).value.resumed === true, "rebound event result was altered");

  registry.registerEvent({
    id: "event-timeout", tool: "run_process", socket: socketA, clientRequestKey: "event:timeout",
    timeoutMs: 1, onTimeout: () => new WorkerToolError("timeout", "event timeout"),
    settle: async (outcome) => { outcomes.push(outcome); },
  });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert(outcomes.at(-1).ok === false && outcomes.at(-1).error.code === "timeout", "event timeout did not settle through the terminal handler");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "event timeout leaked pending indexes");
}

async function testEventDrivenStreamDispatch() {
  const sent = [];
  const socket = { send(value) { sent.push(JSON.parse(value)); } };
  const pending = new PendingCallRegistry(2);
  const completed = [];
  const activated = [];
  const resumption = {
    activate(streamId) { activated.push(streamId); },
    async complete(streamId, message) { completed.push({ streamId, message }); },
  };
  const observability = new WorkerObservability();
  const started = startEventDrivenStreamCall({
    pending, resumption, observability, streamId: STREAM_TEST_ID, requestId: 44,
    clientRequestKey: "session:44", tool: "list_dir", arguments: { path: "." },
    socket, daemonInstanceId: "daemon_stream_event_1234", timeoutMs: 10_000,
    authorization: { account_id: "acct_test", account_version: 1, client_id: "client_test", family_id: "family_test", role: "owner" },
    onTimeout: () => new WorkerToolError("timeout", "stream timeout"), onSendFailure() {},
  });
  await started;
  assert(activated[0] === STREAM_TEST_ID, "stream dispatch did not mark the delivery active");
  assert(completed.length === 0, "stream initiation retained or completed a terminal promise");
  assert(pending.snapshot().active === 1 && pending.snapshot().request_keys === 1, "stream initiation did not leave an event-owned pending record");
  assert(sent.length === 1 && sent[0].type === "tool_call" && sent[0].tool === "list_dir", "stream dispatch sent the wrong daemon envelope");
  await pending.resolve(sent[0].id, socket, { entries: ["ok"] });
  assert(completed.length === 1 && completed[0].message.id === 44
    && completed[0].message.result.structuredContent.entries[0] === "ok", "daemon result event did not persist the exact streamed terminal result");
  const reconnectSocket = { send(value) { this.message = JSON.parse(value); } };
  const reboundSocket = {};
  await startEventDrivenStreamCall({
    pending, resumption, observability, streamId: STREAM_RESUMED_ID, requestId: 45,
    clientRequestKey: "session:45", tool: "list_dir", arguments: { path: "." },
    socket: reconnectSocket, daemonInstanceId: "daemon_stream_reconnect_1234", timeoutMs: 10_000,
    authorization: { account_id: "acct_test", account_version: 1, client_id: "client_test", family_id: "family_test", role: "owner" },
    onTimeout: () => new WorkerToolError("timeout", "stream timeout"), onSendFailure() {},
  });
  assert(pending.detachSocket(reconnectSocket, 10_000, () => new Error("reconnect expired")) === 1, "streamed call did not detach after daemon loss");
  assert(pending.rebindInstance("daemon_stream_reconnect_1234", reboundSocket)[0] === reconnectSocket.message.id, "same daemon instance did not reclaim the streamed call");
  await pending.resolve(reconnectSocket.message.id, reboundSocket, { resumed: true });
  assert(completed.at(-1).message.id === 45 && completed.at(-1).message.result.structuredContent.resumed === true, "rebound streamed call lost its terminal result");

  const rejectedSocket = { send(value) { this.message = JSON.parse(value); } };
  await startEventDrivenStreamCall({
    pending, resumption, observability, streamId: STREAM_DISCONNECTED_ID, requestId: 46,
    clientRequestKey: "session:46", tool: "list_dir", arguments: {},
    socket: rejectedSocket, daemonInstanceId: "daemon_stream_reject_12345", timeoutMs: 10_000,
    authorization: { account_id: "acct_test", account_version: 1, client_id: "client_test", family_id: "family_test", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() {},
  });
  await pending.reject(rejectedSocket.message.id, new WorkerToolError("execution_failed", "daemon rejected"), rejectedSocket);
  assert(completed.at(-1).message.id === 46 && completed.at(-1).message.result.isError === true
    && completed.at(-1).message.result.structuredContent.error.code === "execution_failed", "daemon rejection did not persist a streamed error result");

  const snapshot = observability.snapshot();
  assert(snapshot.calls.started === 3 && snapshot.calls.completed === 2 && snapshot.calls.failed === 1
    && snapshot.tools.list_dir.active === 0, "event-driven stream observability did not close cleanly");
}

async function testStreamDispatchFailureBoundaries() {
  const completed = [];
  const events = [];
  const observability = new WorkerObservability();
  const resumption = {
    activate() {},
    async complete(streamId, message) { completed.push({ streamId, message }); },
  };
  await persistImmediateStreamOutcome({
    resumption, observability, streamId: STREAM_COMPLETE_ID, requestId: 51,
    outcome: { ok: false, error: new WorkerToolError("authorization_denied", "denied") },
  });
  assert(completed.at(-1).message.result.isError === true
    && completed.at(-1).message.result.structuredContent.error.code === "authorization_denied", "immediate stream error lost its stable code");

  const failingResumption = {
    activate() {},
    async complete() { throw new Error("synthetic persistence failure"); },
  };
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

  const transformPending = new PendingCallRegistry(2);
  const transformSocket = { send(value) { this.message = JSON.parse(value); } };
  await startEventDrivenStreamCall({
    pending: transformPending, resumption, observability, streamId: STREAM_RESUMED_ID, requestId: 53,
    tool: "project_overview", arguments: {}, socket: transformSocket, daemonInstanceId: "daemon_transform_123456",
    timeoutMs: 10_000, authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() {}, transformResult(value) { return { transformed: value }; },
  });
  await transformPending.resolve(transformSocket.message.id, transformSocket, { source: true });
  assert(completed.at(-1).message.result.structuredContent.transformed.source === true, "stream result transformation was not applied");

  const throwingTransformPending = new PendingCallRegistry(2);
  const throwingSocket = { send(value) { this.message = JSON.parse(value); } };
  await startEventDrivenStreamCall({
    pending: throwingTransformPending, resumption: failingResumption, observability, streamId: STREAM_DISCONNECTED_ID, requestId: 54,
    tool: "project_overview", arguments: {}, socket: throwingSocket, daemonInstanceId: "daemon_throwing_123456",
    timeoutMs: 10_000, authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() {}, transformResult() { throw new Error("transform failed"); },
  });
  const originalError2 = console.error;
  console.error = (line) => { events.push(String(line)); };
  try { await throwingTransformPending.resolve(throwingSocket.message.id, throwingSocket, { source: true }); }
  finally { console.error = originalError2; }
  const failedSnapshot = observability.snapshot();
  assert(failedSnapshot.calls.failed >= 1 && events.some((line) => line.includes("mcp.stream.persist.failed")), "transform or settlement persistence failure was not closed observably");

  let sendFailureHandled = false;
  const sendFailurePending = new PendingCallRegistry(1);
  await startEventDrivenStreamCall({
    pending: sendFailurePending, resumption, observability, streamId: STREAM_TEST_ID, requestId: 55,
    tool: "list_dir", arguments: {}, socket: { send() { throw new Error("closed"); } }, daemonInstanceId: "daemon_send_fail_12345",
    timeoutMs: 10_000, authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() { sendFailureHandled = true; },
  });
  assert(sendFailureHandled && sendFailurePending.snapshot().active === 0
    && completed.at(-1).message.result.isError === true, "send failure did not settle and clean the streamed call");

  const full = new PendingCallRegistry(1);
  full.registerEvent({ id: "occupied", tool: "list_dir", socket: {}, timeoutMs: 10_000, onTimeout: () => new Error("timeout"), settle() {} });
  await expectRejectType(startEventDrivenStreamCall({
    pending: full, resumption, observability, streamId: STREAM_TEST_ID, requestId: 56,
    tool: "list_dir", arguments: {}, socket: { send() {} }, daemonInstanceId: "daemon_full_123456789",
    timeoutMs: 10_000, authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() {},
  }), WorkerToolError);
  await full.reject("occupied", new Error("cleanup"));

  const plainRegistrationFailure = {
    registerEvent() { throw new RangeError("synthetic registration failure"); },
  };
  await expectRejectType(startEventDrivenStreamCall({
    pending: plainRegistrationFailure, resumption, observability, streamId: STREAM_TEST_ID, requestId: 57,
    tool: "list_dir", arguments: {}, socket: { send() {} }, daemonInstanceId: "daemon_plain_fail_1234",
    timeoutMs: 10_000, authorization: { account_id: "acct", account_version: 1, client_id: "client", family_id: "family", role: "owner" },
    onTimeout: () => new Error("timeout"), onSendFailure() {},
  }), RangeError);

  const daemonRegistry = {
    probingSockets: () => [{}, {}], readySockets: () => [{}], candidateSockets: () => [{}], readyRoleSockets: () => [{}, {}],
  };
  const info = buildServerInfoResult({
    serverName: "machine-bridge-mcp", serverVersion: "test", base: "https://example.test", oauth: { issuer: "https://example.test" },
    authorization: { account: { role: "owner" }, summary: "summary" }, daemon: { tool_count: 2 }, tools: ["server_info", "list_dir"],
    pending: new PendingCallRegistry(1), daemonRegistry, observability: new WorkerObservability(),
  });
  assert(info.worker.sockets_live.authenticated === 4 && info.worker.daemon_candidates === 1
    && info.tool_delivery.effective_account_tool_count === 2, "server_info builder lost socket or tool-delivery diagnostics");
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
  const disconnected = streamJsonRpcResponse(disconnectedResult, {
    streamId: STREAM_DISCONNECTED_ID,
    scheduler: { setInterval() { return 2; }, clearInterval() {} },
    keepAlive(promise) { disconnectedCompletion = promise; },
  });
  const disconnectedReader = disconnected.body.getReader();
  await disconnectedReader.read();
  await disconnectedReader.cancel();
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

async function testMcpStreamProxy() {
  let terminalMessage = null;
  const resolveTerminal = (message) => { terminalMessage = message; };
  const calls = [];
  const bridge = {
    async fetch(request) {
      calls.push(request);
      const mode = request.headers.get(MCP_STREAM_PROXY_MODE_HEADER);
      if (mode === "prepare") return mcpStreamDescriptorResponse("initial", STREAM_TEST_ID);
      if (mode === "poll") {
        if (!terminalMessage) return new Response(null, { status: 202 });
        return new Response(JSON.stringify(terminalMessage), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected proxy mode: ${mode}`);
    },
  };
  const keptAlive = [];
  const request = new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: "https://chatgpt.com",
      [MCP_STREAM_PROXY_MODE_HEADER]: "poll",
      [MCP_STREAM_PROXY_ID_HEADER]: STREAM_COMPLETE_ID,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_dir", arguments: {} } }),
  });
  const response = await proxyMcpEventStream({
    request, bridge, extraOrigins: "", ctx: { waitUntil(promise) { keptAlive.push(promise); } }, pollIntervalMs: 1,
  });
  assert(response?.headers.get("content-type")?.startsWith("text/event-stream"), "outer Worker did not create the public SSE response");
  assert(response.headers.get("access-control-allow-origin") === "https://chatgpt.com", "outer Worker SSE response lost CORS");
  assert(calls[0].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "prepare", "public proxy mode header was not replaced");
  assert(calls[0].headers.get(MCP_STREAM_PROXY_ID_HEADER) === null, "public internal stream id reached BridgeRoom");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert(initial === `id: ${STREAM_TEST_ID}:0\ndata:\n\n`, "outer Worker proxy did not emit sequence zero");
  assert(calls.length >= 2 && calls[1].headers.get(MCP_STREAM_PROXY_MODE_HEADER) === "poll", "outer Worker did not start the internal terminal poll");
  assert(calls[1].headers.get(MCP_STREAM_PROXY_ID_HEADER) === STREAM_TEST_ID, "internal poll lost the stream id");
  resolveTerminal({ jsonrpc: "2.0", id: 10, result: { proxied: true } });
  const terminalText = decoder.decode((await reader.read()).value);
  assert(terminalText.includes(`${STREAM_TEST_ID}:1`) && terminalText.includes('"proxied":true'), "outer Worker proxy lost the terminal result");
  assert((await reader.read()).done, "outer Worker proxy did not close after terminal delivery");
  await Promise.all(keptAlive);

  const spoofed = new Request("https://example.test/healthz", { headers: {
    [MCP_STREAM_PROXY_MODE_HEADER]: "poll", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID,
  } });
  const sanitized = sanitizeBridgeRequest(spoofed);
  assert(!sanitized.headers.has(MCP_STREAM_PROXY_MODE_HEADER) && !sanitized.headers.has(MCP_STREAM_PROXY_ID_HEADER), "public internal stream headers were not stripped");

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

  const resumeBridge = {
    calls: 0,
    async fetch(_request) {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 11, result: { resumed: true } }), { headers: { "content-type": "application/json" } });
    },
  };
  const resumedProxy = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } }),
    bridge: resumeBridge, extraOrigins: "", ctx: { waitUntil() {} },
  });
  const resumedProxyText = await resumedProxy.text();
  assert(resumedProxyText.startsWith(": resumed\n\n") && resumedProxyText.includes(`${STREAM_RESUMED_ID}:1`), "resume descriptor did not create an outer resumed stream");

  const polledMessage = { jsonrpc: "2.0", id: 12, result: { polled: true } };
  const pollStore = { async pollMessage(id) {
    if (id === STREAM_TEST_ID) return { kind: "message", message: polledMessage };
    if (id === STREAM_RESUMED_ID) return { kind: "pending" };
    return { kind: "not_found" };
  } };
  const noPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp"), pollStore);
  assert(noPoll === null, "ordinary request entered the internal stream poll path");
  const postPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp", {
    method: "POST", headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "poll" }, body: "{}",
  }), pollStore);
  assert(postPoll.status === 405 && postPoll.headers.get("allow") === "GET", "internal stream poll accepted POST");
  const invalidPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "poll", [MCP_STREAM_PROXY_ID_HEADER]: "bad" },
  }), pollStore);
  assert(invalidPoll.status === 400, "internal stream poll accepted an invalid stream id");
  const foundPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " Poll ", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID },
  }), pollStore);
  assert(foundPoll.status === 200 && (await foundPoll.json()).result.polled === true, "internal stream poll lost the terminal message");
  const pendingPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "poll", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_RESUMED_ID },
  }), pollStore);
  assert(pendingPoll.status === 202, "internal stream poll did not report pending execution immediately");
  const missingPoll = await handleMcpStreamPollRequest(new Request("https://example.test/mcp", {
    headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "poll", [MCP_STREAM_PROXY_ID_HEADER]: STREAM_COMPLETE_ID },
  }), pollStore);
  assert(missingPoll.status === 404, "internal stream poll did not report a missing stream");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " PREPARE " } })) === "prepare", "internal prepare mode was not normalized");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: " POLL " } })) === "poll", "internal poll mode was not normalized");
  assert(mcpStreamProxyMode(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_MODE_HEADER]: "other" } })) === "", "unknown internal proxy mode was accepted");
  assert(mcpStreamProxyId(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_ID_HEADER]: STREAM_TEST_ID } })) === STREAM_TEST_ID, "valid internal stream id was rejected");
  assert(mcpStreamProxyId(new Request("https://example.test", { headers: { [MCP_STREAM_PROXY_ID_HEADER]: "bad" } })) === "", "invalid internal stream id was accepted");
  expectThrow(() => mcpStreamDescriptorResponse("initial", "stream_short"), "invalid MCP stream descriptor id");

  await expectReject(proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: { async fetch() { return new Response(JSON.stringify({ kind: "invalid", stream_id: STREAM_TEST_ID }), { headers: { "x-machine-bridge-mcp-stream-descriptor": "1" } }); } },
    extraOrigins: "", ctx: { waitUntil() {} },
  }), "descriptor is invalid");
  await expectReject(proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: { async fetch() { return new Response("null", { headers: { "x-machine-bridge-mcp-stream-descriptor": "1" } }); } },
    extraOrigins: "", ctx: { waitUntil() {} },
  }), "descriptor is invalid");

  const failedWaitBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify({ error: "missing" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  };
  const failedWait = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: failedWaitBridge, extraOrigins: "", ctx: { waitUntil() {} }, pollIntervalMs: 1,
  });
  assert((await failedWait.text()).startsWith(": resumed\n\n"), "failed internal wait did not close the outer stream safely");

  const invalidMessageBridge = {
    calls: 0,
    async fetch() {
      this.calls += 1;
      if (this.calls === 1) return mcpStreamDescriptorResponse("resume", STREAM_RESUMED_ID);
      return new Response(JSON.stringify({ not_jsonrpc: true }), { headers: { "content-type": "application/json" } });
    },
  };
  const invalidMessage = await proxyMcpEventStream({
    request: new Request("https://example.test/mcp", { method: "GET" }),
    bridge: invalidMessageBridge, extraOrigins: "", ctx: { waitUntil() {} }, pollIntervalMs: 1,
  });
  assert((await invalidMessage.text()).startsWith(": resumed\n\n"), "invalid internal terminal message did not close the outer stream safely");
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

function testRelayTimeoutContract() {
  assert(relayContract.reconnectGraceMs === 120_000, "relay reconnect grace drifted from the incident-tested budget");
  assert(relayContract.streamHeartbeatMs === 10_000, "SSE heartbeat interval drifted from the idle-connection contract");
  assert(relayContract.streamResumeRetentionMs === 120_000, "resumable result retention drifted from the bounded recovery window");
  assert(relayContract.maximumResumableStreams === 64, "resumable stream capacity drifted from the bounded Worker contract");
  assert(relayContract.maximumResumableMessageBytes === 1_500_000, "resumable message storage exceeded the Durable Object row budget");
  assert(daemonToolTimeoutMs("session_bootstrap", {}) === 10_000, "bootstrap timeout incorrectly inherited the reconnect budget");
  assert(daemonToolTimeoutMs("read_file", {}) === 60_000, "ordinary tool timeout was extended without a disconnect");
  assert(daemonToolTimeoutMs("exec_command", { timeout_seconds: 120 }) === 125_000, "configurable tool timeout lost its protocol overhead");
  assert(daemonToolTimeoutMs("exec_command", { timeout_seconds: 600 }) === 605_000, "maximum configurable execution timeout drifted from the relay contract");
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
  const unknown = daemonToolError({ code: "caller_defined_code", message: "unsupported" });
  assert(unknown.code === "execution_failed", "Worker accepted an unregistered daemon error code");
  const directUnknown = new WorkerToolError("future_custom_code", "unsupported");
  assert(directUnknown.code === "execution_failed", "WorkerToolError accepted an unregistered direct code");
  const hidden = publicWorkerToolError(new Error("private internal details"));
  assert(hidden.message === "tool execution failed" && !hidden.message.includes("private"), "Worker exposed raw internal exception text");
}

function testWorkerObservability() {
  const metrics = new WorkerObservability();
  metrics.requestFinished(200);
  metrics.requestFinished(403);
  metrics.requestFinished(503);
  metrics.callStarted("read_file");
  metrics.callFinished("read_file");
  metrics.callStarted("write_file");
  metrics.callFinished("write_file", "policy_denied");
  metrics.unmatchedResult();
  metrics.socketCandidate();
  metrics.socketAuthenticated();
  metrics.socketDisconnected();
  metrics.socketProtocolError("protocol_error");
  const snapshot = metrics.snapshot();
  assert(snapshot.requests.total === 3 && snapshot.requests.client_error === 1 && snapshot.requests.server_error === 1, "Worker request metrics are incomplete");
  assert(snapshot.calls.started === 2 && snapshot.calls.completed === 1 && snapshot.calls.failed === 1, "Worker call metrics are incomplete");
  assert(snapshot.calls.unmatched_results === 1, "Worker unmatched-result metric was not retained");
  assert(snapshot.errors.policy_denied === 1 && snapshot.errors.protocol_error === 1, "Worker error-code metrics are incomplete");
  assert(snapshot.tools.read_file.completed === 1 && snapshot.tools.write_file.failed === 1, "Worker per-tool metrics are incomplete");
  assert(snapshot.sockets.candidates === 1 && snapshot.sockets.authenticated === 1 && snapshot.sockets.disconnected === 1, "Worker socket metrics are incomplete");

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
