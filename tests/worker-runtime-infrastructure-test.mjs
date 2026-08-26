import { PendingCallRegistry } from "../src/worker/pending-calls.ts";
import {
  MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT,
  pendingCapacityProjection,
} from "../src/worker/pending-call-capacity.ts";
import { DaemonSocketRegistry } from "../src/worker/daemon-sockets.ts";
import { cancelReadyDaemonAuthority, notifyReadyDaemon, readyDaemonWaiterSnapshot, waitForReadyDaemon } from "../src/worker/daemon-ready-waiters.ts";
import { immediateReadyDaemonForDispatch, readyDaemonForDispatch } from "../src/worker/daemon-ready-dispatch.ts";
import { daemonReconnectExpiry, daemonToolTimeoutBudgetAfterDelay } from "../src/worker/daemon-recovery-budget.ts";
import { relayDiagnosticsAfterReady, sanitizeDaemonRelayDiagnostics } from "../src/worker/daemon-relay-diagnostics.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "../src/worker/runtime-alarm.ts";
import { respondWithoutDurableObject } from "../src/worker/worker-static-routes.ts";
import { createThrottledEdgeLogger } from "../src/worker/worker-edge-log.ts";
import {
  admitGlobalStatefulRequest, admitStatefulRequest, durableObjectQuotaResponse, isDurableObjectQuotaError,
  outerWorkerErrorClass, statefulRateLimitKey, statefulRouteClass, workerGatewayErrorResponse,
} from "../src/worker/worker-edge-guard.ts";
import { daemonToolTimeoutBudget, isRemoteDurableProcessTool, remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds, REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS, REMOTE_FOREGROUND_TIMEOUT_SECONDS } from "../src/worker/tool-timeout.ts";
import { managedJobReadArgumentsWithinExecutionBudget, managedJobReadExecutionBudgetHasHeadroom } from "../src/worker/managed-job-read-timeout.ts";
import { serverInfoTool, validateWorkerToolArguments, workerToolSchemaGeneration, workspaceTools } from "../src/worker/tool-catalog.ts";
import { workerAuthorityContext, workerToolsForRole } from "../src/worker/worker-tool-authority.ts";
import { daemonToolRecovery } from "../src/worker/tool-call-recovery.ts";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import {
  daemonCallNotReceivedAfterReconnectError, daemonToolError, dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError,
  dispatchedDaemonPlannedDrainError, dispatchedDaemonTimeoutError, publicWorkerToolError, revokedDaemonAuthorityError, WorkerToolError,
} from "../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../src/worker/policy.ts";
import { WorkerObservability } from "../src/worker/observability.ts";
import {
  readWorkerContinuityEvidence, recordWorkerClientCancellation, recordWorkerPlannedDrain, recordWorkerSocketDisconnect,
} from "../src/worker/worker-continuity-evidence.ts";
import { daemonStatusSnapshot } from "../src/worker/daemon-status.ts";
import { DaemonLastObservation } from "../src/worker/daemon-last-observation.ts";
import { buildServerInfoResult, serverInfoDetail } from "../src/worker/server-info.ts";
import { remoteToolDeliveryContract } from "../src/worker/server-info-tool-delivery.ts";
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../src/worker/mcp-subscription-contract.ts";
import { workerBodyLimitBytes } from "../src/worker/worker-runtime-config.ts";
import { retainWorkerTask } from "../src/worker/worker-task-lifetime.ts";
import { applyCors, corsPreflight, searchParamsObject } from "../src/worker/http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  textToolResult,
} from "../src/worker/mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, daemonResumeMissingCallIds, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "../src/worker/websocket-protocol.ts";
import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
  isLiveDaemonAttachment,
  withDaemonLastSeenAt,
} from "../src/worker/daemon-liveness.ts";

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


testWorkerToolAuthorityProjection();
await testRequestKeyReuse();
await testAuthorityRevocationPending();
await testRegistrationFailures();
await testInvalidPendingDelays();
await testPendingControlCapacity();
await testPendingReadJobAccountCapacity();
await testTerminalPaths();
await testReconnectRebinding();
await testDetachedTimeoutPause();
await testEventBoundaryDeadlineSweep();
await testRuntimeAlarmCoordinator();
await testTimeoutCallbackFailure();
await testDaemonReadyWaiters();
await testAbortSignalCleanup();
await testDaemonSocketIsolation();
testDaemonRelayDiagnostics();
await testWorkerTaskLifetime();
testWorkerRuntimeConfig();
testRelayTimeoutContract();
testWorkerPolicyParity();
testWorkerErrors();
testDaemonAndServerInfoProjection();
await testWorkerContinuityEvidence();

testWorkerObservability();
testPrototypeSafeFormFields();
testMcpJsonRpcProtocol();
testWebSocketProtocol();
testDaemonLiveness();
await testThrottledEdgeLogger();
await testWorkerStaticRoutes();
console.log("worker runtime infrastructure test ok");



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

function testWorkerToolAuthorityProjection() {
  const ownerTools = workerToolsForRole("owner");
  const reviewerTools = workerToolsForRole("reviewer");
  assert(ownerTools.some((tool) => tool.name === "server_info") && ownerTools.some((tool) => tool.name === "start_job"),
    "owner Worker catalog lost server_info or persistent-job authority");
  assert(reviewerTools.some((tool) => tool.name === "server_info") && reviewerTools.some((tool) => tool.name === "read_file")
    && !reviewerTools.some((tool) => tool.name === "start_job"),
  "reviewer Worker catalog escaped role filtering");
  ownerTools[0].name = "mutated-test-tool";
  assert(workerToolsForRole("owner")[0].name !== "mutated-test-tool",
    "Worker role catalog returned shared mutable tool definitions");

  const context = workerAuthorityContext({
    authorized: {
      tokenKey: "synthetic-token", accountId: "synthetic-account", accountVersion: 1,
      clientId: "synthetic-client", familyId: "synthetic-family", dpopJkt: "", role: "reviewer",
    },
    daemonStatus: {
      policy: {
        profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell",
        unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true,
      },
      tools: ["read_file", "start_job"],
    },
    daemonTools: ["read_file", "start_job"],
  });
  assert(context.advertisedTools.includes("server_info") && context.advertisedTools.includes("read_file")
      && !context.advertisedTools.includes("start_job"),
  "Worker advertised-tool projection escaped reviewer authority");
  assert(context.effectiveTools.includes("server_info") && context.effectiveTools.includes("read_file")
      && !context.effectiveTools.includes("start_job"),
  "Worker effective-tool projection escaped reviewer authority");
  assert(context.authorization.account_role_is_owner === false,
    "Worker authority projection mislabeled reviewer as owner");
}

async function testAuthorityRevocationPending() {
  const socket = {};
  const registry = new PendingCallRegistry(3);
  const accountId = `acct_${"w".repeat(32)}`;
  const clientId = `mcp_client_${"w".repeat(43)}`;
  const familyId = `mcp_family_${"w".repeat(43)}`;
  const oldCall = registry.register({
    id: "authority-old", tool: "run_process", socket, timeoutMs: 10_000,
    authority: { accountId, accountVersion: 8, clientId, familyId },
    onTimeout: () => new Error("timeout"),
  });
  const currentCall = registry.register({
    id: "authority-current", tool: "read_file", socket, timeoutMs: 10_000,
    authority: { accountId, accountVersion: 9, clientId, familyId },
    onTimeout: () => new Error("timeout"),
  });
  assert(await registry.cancelAuthority({ accountId, accountVersion: 8, clientId, familyId }, () => new WorkerToolError("authorization_denied", "revoked")) === 1,
    "Worker authority revocation did not cancel exactly the old-version pending call");
  await oldCall.then(() => { throw new Error("revoked Worker call resolved successfully"); }, (error) => {
    assert(error.code === "authorization_denied", "revoked Worker call lost its authorization error");
  });
  assert(registry.snapshot().active === 1, "Worker authority revocation removed an unrelated current-version call");
  await registry.resolve("authority-current", socket, { ok: true });
  assert((await currentCall).ok === true, "current-version Worker call was corrupted by old-version revocation");
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

async function testInvalidPendingDelays() {
  const socket = {};
  for (const timeoutMs of [
    Number.POSITIVE_INFINITY, Number.NaN, 0, -1,
    relayContract.maximumOrdinaryRelayToolTimeoutMs + 1,
  ]) {
    const registry = new PendingCallRegistry(1);
    expectThrow(() => registry.register({
      id: `invalid-delay-${String(timeoutMs)}`, tool: "read_file", socket, timeoutMs,
      onTimeout: () => new Error("timeout"),
    }), "pending-call delay must be an integer");
    assert(registry.snapshot().active === 0, "invalid operation timeout mutated pending state before rejection");
  }

  const managedReadRegistry = new PendingCallRegistry(1);
  const maximumManagedRead = managedReadRegistry.register({
    id: "maximum-managed-read-delay", tool: "read_job", socket,
    timeoutMs: relayContract.maximumRelayToolTimeoutMs,
    onTimeout: () => new Error("timeout"),
  });
  await managedReadRegistry.resolve("maximum-managed-read-delay", socket, true);
  assert(await maximumManagedRead === true, "pending registry rejected the dedicated read_job long-poll deadline");
  expectThrow(() => new PendingCallRegistry(1).register({
    id: "managed-read-over-limit", tool: "read_job", socket,
    timeoutMs: relayContract.maximumRelayToolTimeoutMs + 1,
    onTimeout: () => new Error("timeout"),
  }), "pending-call delay must be an integer");

  const registry = new PendingCallRegistry(1);
  const pending = registry.register({
    id: "invalid-reconnect-delay", tool: "read_file", socket, timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  expectThrow(() => registry.detachSocket(socket, Number.POSITIVE_INFINITY, () => new Error("reconnect timeout")),
    "pending-call delay must be an integer");
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 0,
    "invalid reconnect grace partially detached the pending call");
  await registry.resolve("invalid-reconnect-delay", socket, true);
  assert(await pending === true, "invalid reconnect grace corrupted the original pending call");
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

async function testPendingReadJobAccountCapacity() {
  const socket = {};
  const registry = new PendingCallRegistry(20);
  const authority = (accountId) => ({
    accountId, accountVersion: 1,
    clientId: `client-${accountId}`, familyId: `family-${accountId}`,
  });
  const accountA = "account-long-poll-a";
  const accountB = "account-long-poll-b";
  const held = [];
  for (let index = 0; index < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT; index += 1) {
    held.push(registry.register({
      id: `account-a-read-${index}`, tool: "read_job", socket,
      authority: authority(accountA), timeoutMs: relayContract.maximumRelayToolTimeoutMs,
      onTimeout: () => new Error("timeout"),
    }));
  }
  expectRegistrationError(() => registry.register({
    id: "account-a-read-overflow", tool: "read_job", socket,
    authority: authority(accountA), timeoutMs: relayContract.maximumRelayToolTimeoutMs,
    onTimeout: () => new Error("timeout"),
  }), "limit_exceeded", true);

  const sameAccountOrdinary = registry.register({
    id: "account-a-ordinary", tool: "read_file", socket,
    authority: authority(accountA), timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  const otherAccountRead = registry.register({
    id: "account-b-read", tool: "read_job", socket,
    authority: authority(accountB), timeoutMs: relayContract.maximumRelayToolTimeoutMs,
    onTimeout: () => new Error("timeout"),
  });
  assert(registry.snapshot().by_tool.read_job === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT + 1,
    "per-account managed-job read ceiling became a global long-poll ceiling");

  await registry.resolve("account-a-read-0", socket, true);
  assert(await held[0] === true, "managed-job read slot did not settle before reuse");
  const recovered = registry.register({
    id: "account-a-read-recovered", tool: "read_job", socket,
    authority: authority(accountA), timeoutMs: relayContract.maximumRelayToolTimeoutMs,
    onTimeout: () => new Error("timeout"),
  });

  for (let index = 1; index < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT; index += 1) {
    await registry.resolve(`account-a-read-${index}`, socket, true);
  }
  await registry.resolve("account-a-ordinary", socket, true);
  await registry.resolve("account-b-read", socket, true);
  await registry.resolve("account-a-read-recovered", socket, true);
  await Promise.all([...held.slice(1), sameAccountOrdinary, otherAccountRead, recovered]);
  assert(registry.snapshot().active === 0, "per-account managed-job read test leaked pending calls");
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

  const notReceived = registry.register({
    id: "not-received", tool: "list_dir", socket: socketA, daemonInstanceId: "daemon_same_instance_1234",
    timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
    redeliverAfterProvenMissing: () => true,
  });
  registry.detachSocket(socketA, 1000, () => new Error("reconnect timeout"));
  assert(registry.rebindInstance("daemon_same_instance_1234", socketB).includes("not-received"),
    "daemon-proven non-delivery fixture did not rebind the pending call");
  let redelivered = 0;
  assert(await registry.rejectSocketIds(["not-received", "unknown"], socketB,
    () => daemonCallNotReceivedAfterReconnectError(), undefined, (record) => {
      const handled = record.redeliverAfterProvenMissing?.(record, socketB) === true;
      if (handled) redelivered += 1;
      return handled;
    }) === 0 && redelivered === 1,
  "daemon-proven non-delivery did not preserve a safely redelivered pending call");
  assert(await registry.resolve("not-received", socketB, { redelivered: true }),
    "redelivered pending call no longer accepted its replacement-channel result");
  assert((await notReceived).redelivered === true, "safe redelivery lost the original pending settlement");

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
  assert(registry.nextDeadlineDelayMs() === 60, "detached reconnect grace extended the original operation deadline");
  advance(59);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 1, "detached call expired before its original operation deadline");
  assert(registry.rebindInstance("daemon_pause_12345678", socketB).length === 1, "detached timeout test did not rebind");
  advance(1);
  await expectReject(pending, "operation timeout");
  assert(registry.snapshot().active === 0, "rebound call extended beyond its original operation deadline");

  const detachedExpiry = registry.register({
    id: "detached-original-deadline", tool: "run_process", socket: socketA, daemonInstanceId: "daemon_detached_deadline_1",
    timeoutMs: 100, onTimeout: () => new Error("operation timeout"),
  });
  advance(40);
  assert(registry.detachSocket(socketA, 120, () => new Error("reconnect timeout")) === 1, "original-deadline detach did not find its call");
  advance(60);
  await expectReject(detachedExpiry, "reconnect timeout");
  assert(registry.snapshot().active === 0, "detached reconnect grace outlived the original operation deadline");

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

  const staleCandidate = {};
  const candidateInvalidations = [];
  const candidateContext = {
    ...context,
    storage: {
      async getAlarm() { return null; },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: {
      candidateSockets() { return [staleCandidate]; },
      attachment() { return { role: "candidate", connectedAt: "2026-08-04T00:00:00.000Z" }; },
      probingSockets() { return []; },
      readyRoleSockets() { return []; },
    },
    async invalidateDaemonSocket(socket, message, closeReason, errorCode) {
      candidateInvalidations.push({ socket, message, closeReason, errorCode });
    },
  };
  await processRuntimeAlarm(candidateContext, Date.parse("2026-08-04T00:01:00.000Z"));
  assert(candidateInvalidations.length === 1
    && candidateInvalidations[0].socket === staleCandidate
    && candidateInvalidations[0].errorCode === "daemon_hello_timeout",
  "stale daemon candidate bypassed the unified socket invalidation path");

  const staleProbe = {};
  const staleReady = {};
  const processInvalidations = [];
  await processRuntimeAlarm({
    ...context,
    storage: { async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {} },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: {
      candidateSockets() { return []; },
      probingSockets() { return [staleProbe]; },
      readyRoleSockets() { return [staleReady]; },
      attachment() {
        return { role: "probing", connectedAt: "2026-08-04T00:00:00.000Z", lastSeenAt: "2026-08-04T00:00:00.000Z" };
      },
      readyAttachment() {
        return { role: "daemon", connectedAt: "2026-08-04T00:00:00.000Z", lastSeenAt: "2026-08-04T00:00:00.000Z" };
      },
    },
    async invalidateDaemonSocket(socket, message, closeReason, errorCode) {
      processInvalidations.push({ socket, message, closeReason, errorCode });
    },
  }, Date.parse("2026-08-04T00:02:00.000Z"));
  assert(processInvalidations.length === 2
    && processInvalidations[0].socket === staleProbe
    && processInvalidations[0].errorCode === "daemon_ready_timeout"
    && processInvalidations[1].socket === staleReady
    && processInvalidations[1].closeReason === "daemon liveness timeout",
  "runtime alarm did not expire stale probing and ready daemon sockets");

  let changedPendingDelay = 1000;
  let changedAlarm = null;
  const invalidTimestampCandidate = {};
  const changedDeadlineContext = {
    ...context,
    storage: {
      async getAlarm() { return null; },
      async setAlarm(value) { changedAlarm = Number(value); },
      async deleteAlarm() { changedAlarm = null; },
    },
    pending: {
      async expireDue() { return 0; },
      nextDeadlineDelayMs() { return changedPendingDelay; },
    },
    daemonRegistry: {
      candidateSockets() { return [invalidTimestampCandidate]; },
      attachment() { return { role: "candidate", connectedAt: "invalid" }; },
      probingSockets() { return []; },
      readyRoleSockets() { return []; },
    },
    async invalidateDaemonSocket(socket) {
      assert(socket === invalidTimestampCandidate, "runtime alarm invalidated the wrong candidate");
      changedPendingDelay = 25;
    },
  };
  await scheduleRuntimeAlarm(changedDeadlineContext, 5000);
  assert(changedAlarm === 5025,
    "runtime alarm did not recompute pending deadlines after socket invalidation changed call ownership");

  const invalidProbe = {};
  const invalidReady = {};
  const scheduleInvalidations = [];
  await scheduleRuntimeAlarm({
    ...context,
    storage: { async getAlarm() { return 6000; }, async setAlarm() {}, async deleteAlarm() {} },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: {
      candidateSockets() { return []; },
      probingSockets() { return [invalidProbe]; },
      readyRoleSockets() { return [invalidReady]; },
      attachment(socket) { return socket === invalidProbe ? { role: "probing", connectedAt: "invalid", lastSeenAt: "invalid" } : undefined; },
      readyAttachment() { return { role: "daemon", lastSeenAt: "invalid" }; },
    },
    async invalidateDaemonSocket(socket, message) { scheduleInvalidations.push({ socket, message }); },
  }, 5000);
  assert(scheduleInvalidations.length === 2
    && scheduleInvalidations[0].socket === invalidProbe
    && scheduleInvalidations[1].socket === invalidReady,
  "event-time alarm scheduling did not fail closed on invalid probing/ready liveness timestamps");

  const validCandidate = {};
  const validProbe = {};
  const validReady = {};
  let validSocketAlarm = null;
  const baseNow = Date.parse("2026-08-04T00:00:20.000Z");
  await scheduleRuntimeAlarm({
    ...context,
    storage: {
      async getAlarm() { return validSocketAlarm; },
      async setAlarm(value) { validSocketAlarm = Number(value); },
      async deleteAlarm() { validSocketAlarm = null; },
    },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: {
      candidateSockets() { return [validCandidate]; },
      probingSockets() { return [validProbe]; },
      readyRoleSockets() { return [validReady]; },
      attachment(socket) {
        if (socket === validCandidate) return { role: "candidate", connectedAt: "2026-08-04T00:00:15.000Z" };
        if (socket === validProbe) return { role: "probing", connectedAt: "2026-08-04T00:00:18.000Z", lastSeenAt: "2026-08-04T00:00:18.000Z" };
        return undefined;
      },
      readyAttachment() { return { role: "daemon", lastSeenAt: "2026-08-04T00:00:19.000Z" }; },
    },
    async invalidateDaemonSocket() { throw new Error("valid daemon liveness state was invalidated"); },
  }, baseNow);
  assert(validSocketAlarm === Date.parse("2026-08-04T00:00:25.000Z"),
    "event-time alarm scheduling did not select the earliest valid daemon deadline");

  const staleHttpChannel = { daemonTransport: "https", sessionId: "relay_http_alarm_stale_12345678" };
  const httpInvalidations = [];
  let httpCandidatesSwept = 0;
  let httpAlarm = null;
  const httpRegistry = {
    candidateSockets() { return []; }, probingSockets() { return []; }, readyRoleSockets() { return []; },
    httpCandidates(at) { assert(at === 7000, "HTTP candidate sweep received the wrong alarm time"); httpCandidatesSwept += 1; },
    http: {
      staleOwned(at) { assert(at === 7000, "HTTP stale-owner sweep received the wrong alarm time"); return [staleHttpChannel]; },
      nextDeadline(at) { assert(at === 7000, "HTTP fallback deadline received the wrong alarm time"); return 7040; },
    },
  };
  await processRuntimeAlarm({
    ...context,
    storage: { async getAlarm() { return null; }, async setAlarm(value) { httpAlarm = Number(value); }, async deleteAlarm() { httpAlarm = null; } },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: httpRegistry,
    async invalidateDaemonSocket() { throw new Error("HTTP-only alarm fixture unexpectedly invalidated WebSocket state"); },
    async invalidateDaemonChannel(channel, message, errorCode) { httpInvalidations.push({ channel, message, errorCode }); },
  }, 7000);
  assert(httpCandidatesSwept === 1 && httpInvalidations.length === 1
    && httpInvalidations[0].channel === staleHttpChannel
    && httpInvalidations[0].errorCode === "daemon_liveness_timeout"
    && httpAlarm === 7040,
  "runtime alarm did not expire a stale HTTPS fallback channel and retain its next transport deadline");

  httpCandidatesSwept = 0;
  httpAlarm = null;
  await scheduleRuntimeAlarm({
    ...context,
    storage: { async getAlarm() { return null; }, async setAlarm(value) { httpAlarm = Number(value); }, async deleteAlarm() { httpAlarm = null; } },
    pending: { async expireDue() { return 0; }, nextDeadlineDelayMs() { return Number.POSITIVE_INFINITY; } },
    daemonRegistry: httpRegistry,
    async invalidateDaemonSocket() { throw new Error("HTTP-only schedule fixture unexpectedly invalidated WebSocket state"); },
    async invalidateDaemonChannel() { throw new Error("event-time HTTP scheduling must not invalidate a channel directly"); },
  }, 7000);
  assert(httpCandidatesSwept === 1 && httpAlarm === 7040,
    "event-time alarm scheduling omitted the HTTPS fallback liveness deadline");

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

async function testDaemonReadyWaiters() {
  let readySockets = [];
  const registry = { readySockets: () => readySockets };
  const socket = { readyState: 1 };
  const waiting = waitForReadyDaemon(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1 && await waiting === socket,
    "brief daemon reconnect did not wake a waiting new call");
  assert(await waitForReadyDaemon(registry, { graceMs: 1 }) === socket,
    "ready daemon call admission unnecessarily waited");
  const synchronousImmediate = immediateReadyDaemonForDispatch(registry);
  assert(synchronousImmediate?.socket === socket && synchronousImmediate.recoveryDelayMs === 0,
    "ready daemon dispatch lost its synchronous no-yield admission path");
  let immediateClockReads = 0;
  const immediateDispatch = await readyDaemonForDispatch(registry, { graceMs: 1 }, () => {
    immediateClockReads += 1;
    return 100;
  });
  assert(immediateDispatch.socket === socket && immediateDispatch.recoveryDelayMs === 0 && immediateClockReads === 0,
    "already-ready daemon dispatch consumed recovery budget or sampled the recovery clock");
  readySockets = [];
  let recoveryClock = 100;
  const delayedDispatch = readyDaemonForDispatch(registry, { graceMs: 100 }, () => {
    const value = recoveryClock;
    recoveryClock += 50;
    return value;
  });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1, "recovered daemon dispatch did not wake its waiter");
  const recoveredDispatch = await delayedDispatch;
  assert(recoveredDispatch.socket === socket && recoveredDispatch.recoveryDelayMs === 50,
    "daemon recovery wait did not report only the actual recovery interval");
  readySockets = [];
  const defaultClockDispatch = readyDaemonForDispatch(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1, "default recovery clock case did not wake its waiter");
  const defaultClockRecovered = await defaultClockDispatch;
  assert(defaultClockRecovered.socket === socket && defaultClockRecovered.recoveryDelayMs >= 0,
    "default monotonic recovery clock did not produce a bounded interval");
  readySockets = [];
  const handoverFirst = waitForReadyDaemon(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(immediateReadyDaemonForDispatch(registry) === null,
    "new call bypassed retained pre-dispatch waiters while daemon handover was not yet released");
  let handoverSecondSettled = false;
  const handoverSecond = waitForReadyDaemon(registry, { graceMs: 100 }).then((value) => {
    handoverSecondSettled = true;
    return value;
  });
  await Promise.resolve();
  assert(handoverSecondSettled === false && readyDaemonWaiterSnapshot(registry).active === 2,
    "ready socket let fresh traffic leapfrog reconnect waiters before final handover notification");
  assert(notifyReadyDaemon(registry) === 2
    && (await handoverFirst) === socket && (await handoverSecond) === socket,
  "final daemon handover did not release the complete capacity-reserved waiter batch");
  readySockets = [];
  const unreleasedReady = waitForReadyDaemon(registry, { graceMs: 5 });
  await Promise.resolve();
  readySockets = [socket];
  let unreleasedReadyError = null;
  try { await unreleasedReady; } catch (error) { unreleasedReadyError = error; }
  assert(unreleasedReadyError?.code === "unavailable",
    "ready-daemon waiter timeout bypassed the missing final handover notification");
  readySockets = [];
  let timeoutError = null;
  try { await waitForReadyDaemon(registry, { graceMs: 5 }); } catch (error) { timeoutError = error; }
  assert(timeoutError?.code === "unavailable", "daemon reconnect admission timeout did not remain retryable-unavailable");
  const controller = new AbortController();
  const aborted = waitForReadyDaemon(registry, { graceMs: 100, signal: controller.signal });
  controller.abort();
  let abortError = null;
  try { await aborted; } catch (error) { abortError = error; }
  assert(abortError?.code === "cancelled", "daemon reconnect admission ignored client cancellation");
  const accountA = "account-ready-read-a";
  const accountB = "account-ready-read-b";
  const waiterAuthority = (accountId, familyId = `family-${accountId}`) => ({
    accountId, accountVersion: 4, clientId: `client-${accountId}`, familyId,
  });
  const revokedWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", authority: waiterAuthority(accountA),
    pending: { active: 0, by_tool: {} },
  });
  assert(cancelReadyDaemonAuthority(registry, {
    accountId: accountA, accountVersion: 4,
    clientId: `client-${accountA}`, familyId: "different-family",
  }) === 0, "daemon readiness authority revocation matched a different refresh family");
  assert(cancelReadyDaemonAuthority(registry, waiterAuthority(accountA)) === 1,
    "daemon readiness authority revocation did not cancel a matching pre-dispatch waiter");
  let revokedWaiterError = null;
  try { await revokedWaiter; } catch (error) { revokedWaiterError = error; }
  assert(revokedWaiterError?.code === "authorization_denied" && readyDaemonWaiterSnapshot(registry).active === 0,
    "revoked pre-dispatch daemon waiter retained stale authority or capacity");
  const handoverRevoked = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", authority: waiterAuthority(accountA),
    pending: { active: 0, by_tool: {} },
  });
  await Promise.resolve();
  readySockets = [socket];
  assert(immediateReadyDaemonForDispatch(registry) === null
    && cancelReadyDaemonAuthority(registry, waiterAuthority(accountA)) === 1,
  "visible ready socket bypassed authority revocation before final handover release");
  let handoverRevokedError = null;
  try { await handoverRevoked; } catch (error) { handoverRevokedError = error; }
  assert(handoverRevokedError?.code === "authorization_denied" && readyDaemonWaiterSnapshot(registry).active === 0,
    "handover-phase ready waiter escaped revocation before pending ownership transfer");
  readySockets = [];
  const readJobWaiters = [];
  for (let index = 0; index < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT; index += 1) {
    readJobWaiters.push(waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
    }));
  }
  let accountReadLimitError = null;
  try {
    await waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
    });
  } catch (error) { accountReadLimitError = error; }
  assert(accountReadLimitError?.code === "limit_exceeded",
    "daemon reconnect waiters let one account monopolize managed-job long-poll recovery capacity");
  const otherAccountReadWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountB),
    activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
  });
  assert(readyDaemonWaiterSnapshot(registry).by_tool.read_job === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT + 1,
    "daemon reconnect managed-job read ceiling became a global account-independent ceiling");
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT + 1,
    "daemon reconnect did not release the account-bounded read_job waiter batch");
  assert((await Promise.all([...readJobWaiters, otherAccountReadWaiter])).every((value) => value === socket),
    "account-bounded daemon reconnect waiters did not settle on the recovered daemon");
  readySockets = [];
  const activeReadWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
    activeReadJobCallsForAccount: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1,
    pending: { active: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1, by_tool: { read_job: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1 } },
  });
  let combinedReadLimitError = null;
  try {
    await waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1,
      pending: { active: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1, by_tool: { read_job: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1 } },
    });
  } catch (error) { combinedReadLimitError = error; }
  assert(combinedReadLimitError?.code === "limit_exceeded",
    "daemon reconnect read_job ceiling ignored already-active long polls for the same account");
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1 && await activeReadWaiter === socket,
    "daemon reconnect read_job waiter did not release after combining active and waiting account usage");
  readySockets = [];
  const detachedPending = { active: 29, by_tool: { read_file: 29 } };
  const ordinaryWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", pending: detachedPending,
  });
  await Promise.resolve();
  let ordinaryLimitError = null;
  try {
    await waitForReadyDaemon(registry, { graceMs: 1000, tool: "read_file", pending: detachedPending });
  } catch (error) { ordinaryLimitError = error; }
  assert(ordinaryLimitError?.code === "limit_exceeded",
    "daemon reconnect ordinary waiters consumed reserved control-plane capacity");
  const controlWaiters = [
    waitForReadyDaemon(registry, { graceMs: 1000, tool: "diagnose_runtime", pending: detachedPending }),
    waitForReadyDaemon(registry, { graceMs: 1000, tool: "list_roots", pending: detachedPending }),
  ];
  await Promise.resolve();
  let totalLimitError = null;
  try {
    await waitForReadyDaemon(registry, { graceMs: 1000, tool: "diagnose_runtime", pending: detachedPending });
  } catch (error) { totalLimitError = error; }
  assert(totalLimitError?.code === "limit_exceeded", "daemon reconnect waiters exceeded the shared 30+2 call ceiling");
  const waiterSnapshot = readyDaemonWaiterSnapshot(registry);
  assert(waiterSnapshot.active === 3
    && waiterSnapshot.by_tool.read_file === 1
    && waiterSnapshot.by_tool.diagnose_runtime === 1
    && waiterSnapshot.by_tool.list_roots === 1,
  "daemon reconnect waiter diagnostics lost privacy-safe per-tool capacity counts");
  const capacityProjection = pendingCapacityProjection({
    active: 29, detached: 29, request_keys: 0, maximum: 32, ordinary_capacity: 30, reserved_capacity: 2,
    active_reserved: 0, active_ordinary: 29, oldest_ms: 123, by_tool: { read_file: 29 },
  }, waiterSnapshot);
  assert(capacityProjection.active === 29
    && capacityProjection.pre_dispatch_waiters === 3
    && capacityProjection.capacity_active === 32
    && capacityProjection.capacity_active_ordinary === 30
    && capacityProjection.capacity_active_reserved === 2,
  "Worker capacity diagnostics omitted pre-dispatch daemon waiters or reserved-control usage");
  readySockets = [socket];
  const boundedWaiters = [ordinaryWaiter, ...controlWaiters];
  assert(notifyReadyDaemon(registry) === 3 && (await Promise.all(boundedWaiters)).every((value) => value === socket),
    "daemon reconnect did not release the shared-capacity waiter batch exactly once");
  assert(readyDaemonWaiterSnapshot(registry).active === 0, "ready notification retained stale waiter diagnostics");
}

async function testDaemonSocketIsolation() {
  const candidate = new TestWebSocket();
  candidate.serializeAttachment({ role: "candidate", connectedAt: new Date().toISOString() });
  const registry = new DaemonSocketRegistry({ getWebSockets: () => [candidate] });
  const sockets = registry.nonReadySockets();
  assert(sockets.length === 1 && sockets[0] === candidate, "daemon candidate lookup lost the authenticated socket");
  const expired = registry.expire(candidate);
  assert(expired?.role === "candidate" && registry.attachment(candidate)?.role === "expired",
    "daemon socket expiry did not return and preserve the original attachment identity");
  assert(registry.expire(candidate) === undefined, "daemon socket expiry was not idempotent");

  const probing = new TestWebSocket();
  probing.serializeAttachment({
    role: "probing", connectedAt: "2026-08-04T11:36:29.000Z", lastSeenAt: "2026-08-04T11:36:29.000Z",
    probeId: "probe_ready_projection", instanceId: "daemon_ready_projection_123456",
    connectionId: `connection_${"R".repeat(43)}`,
    policy: { profile: "full", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
    tools: ["list_roots"],
    relayDiagnostics: {
      schema_version: 1, network_route: "system-network-stack", outage_count: 1, outage_active: true,
      outage_started_at: "2026-08-04T11:36:20.000Z", outage_duration_ms: 9000, outage_attempts: 2,
      last_close_category: "relay_transport_error", last_close_code: 1006,
      last_transport_error_class: "network_error", last_disconnected_at: "2026-08-04T11:36:20.000Z",
      previous_ready_duration_ms: 123456,
    },
  });
  const readyRegistry = new DaemonSocketRegistry({ getWebSockets: () => [probing] });
  const promoted = readyRegistry.promote(probing, "2026-08-04T11:36:30.000Z");
  assert(promoted?.role === "daemon"
    && promoted.relayDiagnostics?.outage_active === false
    && promoted.relayDiagnostics.outage_duration_ms === 10_000,
  "ready socket promotion retained a reconnect-in-progress or pre-readiness diagnostic duration");

  const cleanupSocket = new TestWebSocket();
  cleanupSocket.serializeAttachment({
    role: "daemon", connectedAt: "2026-08-04T11:36:29.000Z", lastSeenAt: "2026-08-04T11:36:30.000Z",
    instanceId: "daemon_cleanup_retry_123456", connectionId: `connection_${"C".repeat(43)}`,
  });
  const cleanupRegistry = new DaemonSocketRegistry({ getWebSockets: () => [cleanupSocket] });
  let rejectCleanup;
  let cleanupCalls = 0;
  const cleanupFailure = new Promise((_resolve, reject) => { rejectCleanup = reject; });
  const firstCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => {
    cleanupCalls += 1;
    await cleanupFailure;
  });
  const duplicateCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 100; });
  assert(firstCleanup?.first === true && duplicateCleanup?.first === false
    && firstCleanup.task === duplicateCleanup.task,
  "concurrent daemon cleanup did not share one ownership task");
  await Promise.resolve();
  rejectCleanup(new Error("synthetic relay detach failure"));
  await expectReject(firstCleanup.task, "synthetic relay detach failure");
  const retryCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 1; });
  assert(retryCleanup?.first === false, "failed daemon cleanup retry duplicated the disconnected transition");
  await retryCleanup.task;
  const settledCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 100; });
  await settledCleanup.task;
  assert(cleanupCalls === 3 && settledCleanup.first === false,
    "daemon cleanup failure was not retryable or successful cleanup ran more than once");
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

function testDaemonRelayDiagnostics() {
  const diagnostics = sanitizeDaemonRelayDiagnostics({
    schema_version: 1,
    network_route: "system-network-stack",
    connect_timeout_ms: 30000,
    outage_count: 8,
    outage_active: true,
    outage_started_at: "2026-08-04T11:36:20.000Z",
    outage_duration_ms: 9000,
    outage_attempts: 2,
    last_close_category: "relay_heartbeat_timeout",
    last_close_code: 1006,
    last_transport_error_class: "network_error",
    last_transport_error_reason: "network_unreachable",
    last_transport_error_ready: false,
    last_transport_error_authenticated: false,
    last_probe_buffered_bytes: 4096,
    max_probe_buffered_bytes: 8192,
    last_probe_dispatch_ms: 17,
    max_probe_dispatch_ms: 44,
    last_probe_dispatch_timeout_age_ms: 0,
    last_probe_timeout_age_ms: 10000,
    transport_confirmation_dispatch_timeout_ms: 30000,
    last_transport_confirmation_dispatch_ms: 19,
    max_transport_confirmation_dispatch_ms: 47,
    last_transport_confirmation_dispatch_timeout_age_ms: 30000,
    transport_confirmation_timeout_ms: 15000,
    last_transport_confirmation_ms: 2300,
    max_transport_confirmation_ms: 4100,
    last_transport_confirmation_timeout_age_ms: 15000,
    last_disconnected_at: "2026-08-04T11:36:20.000Z",
    last_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 17, tcp_connected: 29, tls_established: 51, private_stage: 7 },
    last_failed_connect_stage: "tls_established",
    last_failed_connect_duration_ms: 61,
    last_failed_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 16, tcp_connected: 28, tls_established: 61, private_stage: 8 },
    last_failed_connect_http_status: 503,
    previous_ready_duration_ms: 123456,
    previous_ready_inbound_silence_ms: 15000,
    https_fallback_last_takeover_ms: 1350,
  });
  assert(diagnostics?.outage_count === 8
    && diagnostics.connect_timeout_ms === 30000
    && diagnostics.outage_attempts === 2
    && diagnostics.last_close_category === "relay_heartbeat_timeout"
    && diagnostics.last_close_code === 1006
    && diagnostics.last_transport_error_class === "network_error"
    && diagnostics.last_transport_error_reason === "network_unreachable"
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
    && diagnostics.last_connect_milestones_ms.dns_resolved === 17
    && diagnostics.last_connect_milestones_ms.tls_established === 51
    && diagnostics.last_connect_milestones_ms.private_stage === undefined
    && diagnostics.last_failed_connect_stage === "tls_established"
    && diagnostics.last_failed_connect_duration_ms === 61
    && diagnostics.last_failed_connect_milestones_ms.tls_established === 61
    && diagnostics.last_failed_connect_milestones_ms.private_stage === undefined
    && diagnostics.last_failed_connect_http_status === 503
    && diagnostics.last_transport_error_ready === false
    && diagnostics.last_transport_error_authenticated === false
    && diagnostics.outage_started_at === "2026-08-04T11:36:20.000Z"
    && diagnostics.previous_ready_inbound_silence_ms === 15000
    && diagnostics.https_fallback_last_takeover_ms === 1350,
  "Worker relay diagnostics sanitizer lost valid bounded evidence");
  const readyDiagnostics = relayDiagnosticsAfterReady(diagnostics);
  assert(readyDiagnostics?.outage_active === false && readyDiagnostics.outage_duration_ms === 9000,
    "ready daemon diagnostics still reported the preceding reconnect as active");
  const localRetryDiagnostics = sanitizeDaemonRelayDiagnostics({
    schema_version: 1, last_close_category: "local_authority_revocation_retry",
  });
  assert(localRetryDiagnostics?.last_close_category === "local_authority_revocation_retry",
    "Worker relay diagnostics dropped the privacy-bounded local authority-retry category");
  const rejected = sanitizeDaemonRelayDiagnostics({ schema_version: 2, outage_count: 1 });
  assert(rejected === undefined, "Worker relay diagnostics accepted an unknown schema");
  const bounded = sanitizeDaemonRelayDiagnostics({
    schema_version: 1, network_route: "private-route", outage_count: -1, outage_duration_ms: Number.POSITIVE_INFINITY,
    last_connect_milestones_ms: { dns_resolved: Number.POSITIVE_INFINITY, tcp_connected: -1 },
    last_failed_connect_stage: "private_stage", last_failed_connect_duration_ms: Number.POSITIVE_INFINITY,
    last_failed_connect_milestones_ms: { tls_established: -1 }, last_failed_connect_http_status: 999,
    previous_ready_inbound_silence_ms: Number.POSITIVE_INFINITY,
    https_fallback_last_takeover_ms: Number.POSITIVE_INFINITY,
    last_close_category: "private-category", last_close_code: 99999, last_transport_error_class: "x".repeat(200),
    last_transport_error_reason: "private-network-detail",
    last_probe_buffered_bytes: Number.POSITIVE_INFINITY, last_probe_dispatch_ms: -1,
    last_transport_error_ready: "yes", last_transport_error_authenticated: 1,
  });
  assert(bounded?.network_route === "unresolved"
    && bounded.outage_count === 0
    && bounded.outage_duration_ms === 0
    && Object.keys(bounded.last_connect_milestones_ms).length === 0
    && bounded.last_failed_connect_stage === null
    && bounded.last_failed_connect_duration_ms === 0
    && Object.keys(bounded.last_failed_connect_milestones_ms).length === 0
    && bounded.last_failed_connect_http_status === null
    && bounded.last_transport_error_reason === "unknown"
    && bounded.last_probe_buffered_bytes === 0
    && bounded.last_probe_dispatch_ms === 0
    && bounded.last_transport_error_ready === false
    && bounded.last_transport_error_authenticated === false
    && bounded.previous_ready_inbound_silence_ms === 0
    && bounded.https_fallback_last_takeover_ms === 0
    && bounded.last_close_category === null
    && bounded.last_close_code === null
    && bounded.last_transport_error_class === null,
  "Worker relay diagnostics sanitizer did not reject untrusted daemon metadata");
}

async function testWorkerTaskLifetime() {
  const retained = [];
  const errors = [];
  const context = { waitUntil(promise) { retained.push(promise); } };
  const task = retainWorkerTask(context, Promise.reject(new Error("synthetic cleanup failure")), (error) => {
    errors.push(String(error?.message || error));
  });
  await task;
  assert(retained.length === 1 && retained[0] === task
    && errors[0] === "synthetic cleanup failure",
  "Worker task lifetime did not retain and classify an asynchronous cleanup rejection");
  const callbackFailure = retainWorkerTask(context, Promise.reject(new Error("primary")), () => {
    throw new Error("secondary");
  });
  await callbackFailure;
  assert(retained.length === 2, "Worker task lifetime lost a retained cleanup after diagnostic callback failure");
}

function testWorkerRuntimeConfig() {
  assert(workerBodyLimitBytes(undefined) === 8 * 1024 * 1024, "missing Worker body limit did not use the safe default");
  assert(workerBodyLimitBytes("0") === 8 * 1024 * 1024, "zero Worker body limit bypassed the safe default");
  assert(workerBodyLimitBytes("1048576") === 1024 * 1024, "valid Worker body limit was not preserved");
  assert(workerBodyLimitBytes(String(32 * 1024 * 1024)) === 16 * 1024 * 1024, "Worker body limit exceeded the hard maximum");
}

function testRelayTimeoutContract() {
  assert(relayContract.reconnectGraceMs === 120_000, "relay reconnect grace drifted from the incident-tested budget");
  assert(relayContract.newCallReconnectGraceMs === 15_000,
    "new-call recovery no longer covers the bounded HTTPS fallback window before the original execution budget is reduced");
  assert(relayContract.httpFallbackMinimumRequestIntervalMs >= 750
    && Math.ceil(60_000 / relayContract.httpFallbackMinimumRequestIntervalMs) < 120,
  "HTTPS fallback can consume the full daemon route rate-limit budget without headroom");
  assert(relayContract.httpFallbackRequestTimeoutMs < relayContract.newCallReconnectGraceMs
    && relayContract.httpFallbackLivenessTimeoutMs <= relayContract.newCallReconnectGraceMs,
  "HTTPS fallback request/liveness windows no longer fit inside new-call recovery grace");
  assert(relayContract.transportPingIntervalMs === 5_000
    && relayContract.transportPongTimeoutMs === 10_000
    && relayContract.transportPingIntervalMs + relayContract.transportPongTimeoutMs < relayContract.defaultRemoteToolExecutionTimeoutMs,
  "relay transport watchdog worst-case detection horizon can no longer leave reconnect headroom inside the ordinary foreground execution window");
  assert(relayContract.daemonApplicationHeartbeatIntervalMs === 25_000
    && relayContract.daemonApplicationHeartbeatTimeoutMs === 75_000
    && DAEMON_LIVENESS_TIMEOUT_MS > relayContract.daemonApplicationHeartbeatTimeoutMs,
  "application heartbeat timeout and Worker daemon-liveness fallback drifted out of their layered recovery contract");
  assert(relayContract.streamHeartbeatMs === 5_000, "SSE heartbeat interval drifted from the reply-liveness contract");
  assert(!("streamResumeRetentionMs" in relayContract)
    && !("maximumResumableStreams" in relayContract)
    && !("maximumResumableMessageBytes" in relayContract),
  "relay contract retained removed MCP replay/resumption storage budgets");
  assert(relayContract.workerSettlementOverheadMs === 5_000
    && !("toolCallOverheadMs" in relayContract),
  "Worker settlement overhead retained its ambiguous execution-budget name");
  const bootstrapBudget = daemonToolTimeoutBudget("session_bootstrap", {});
  assert(bootstrapBudget.executionTimeoutMs === 10_000 && bootstrapBudget.settlementTimeoutMs === 15_000,
    "bootstrap execution and settlement deadlines were not separated");
  const ordinaryBudget = daemonToolTimeoutBudget("read_file", {});
  assert(ordinaryBudget.executionTimeoutMs === 20_000 && ordinaryBudget.settlementTimeoutMs === 25_000,
    "ordinary remote tool execution regained the full host-interaction window");
  assert(relayContract.defaultRemoteToolExecutionTimeoutMs === 20_000,
    "ordinary remote tool budget drifted from its reply-safe ceiling");
  assert(relayContract.maximumInteractiveExecutionTimeoutMs === 45_000, "interactive relay deadline lost its host-delivery margin");
  assert(REMOTE_FOREGROUND_TIMEOUT_SECONDS === 45, "remote foreground schema limit drifted from the relay execution budget");
  assert(!("maximumProcessForegroundExecutionTimeoutMs" in relayContract),
    "relay contract retained the obsolete request-scoped remote process execution budget");
  assert(relayContract.processSessionStartExecutionTimeoutMs === 10_000,
    "remote process-session startup budget drifted from its short request-owned envelope");
  assert(relayContract.durableProcessAcceptanceTimeoutMs === 10_000
    && relayContract.maximumDurableProcessExecutionTimeoutMs === 600_000
    && relayContract.maximumManagedJobResourceAdmissionWaitMs === 1_800_000
    && REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS === 600
    && REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS === 600,
  "durable remote process acceptance/execution budgets drifted from their separated contract");
  const defaultExecBudget = daemonToolTimeoutBudget("exec_command", {});
  assert(defaultExecBudget.executionTimeoutMs === 10_000 && defaultExecBudget.settlementTimeoutMs === 15_000,
    "durable remote process acceptance regained the command execution lifetime");
  const maximumExecBudget = daemonToolTimeoutBudget("exec_command", { timeout_seconds: 600 });
  assert(maximumExecBudget.executionTimeoutMs === 10_000 && maximumExecBudget.settlementTimeoutMs === 15_000,
    "durable process execution timeout leaked into the MCP acceptance deadline");
  const recoveredMaximumBudget = daemonToolTimeoutBudgetAfterDelay(maximumExecBudget, 5_000);
  assert(recoveredMaximumBudget.executionTimeoutMs === 5_000 && recoveredMaximumBudget.settlementTimeoutMs === 10_000,
    "new-call daemon recovery extended the durable process acceptance envelope");
  for (const malformedElapsed of [-1, Number.NaN]) {
    const unchanged = daemonToolTimeoutBudgetAfterDelay(maximumExecBudget, malformedElapsed);
    assert(unchanged.executionTimeoutMs === 10_000 && unchanged.settlementTimeoutMs === 15_000,
      "invalid daemon-recovery elapsed time enlarged or reduced the original timeout budget");
  }
  const oneSecondBudget = daemonToolTimeoutBudget("exec_command", { timeout_seconds: 1 });
  const recoveredOneSecondBudget = daemonToolTimeoutBudgetAfterDelay(oneSecondBudget, 500);
  assert(recoveredOneSecondBudget.executionTimeoutMs === 9_500 && recoveredOneSecondBudget.settlementTimeoutMs === 14_500,
    "durable process command timeout incorrectly controlled the MCP acceptance window");
  let exhaustedRecoveryError = null;
  try { daemonToolTimeoutBudgetAfterDelay(oneSecondBudget, 10_000); } catch (error) { exhaustedRecoveryError = error; }
  assert(exhaustedRecoveryError instanceof WorkerToolError
    && exhaustedRecoveryError.code === "unavailable"
    && exhaustedRecoveryError.retryable === true
    && exhaustedRecoveryError.details?.side_effects_started === false,
  "daemon recovery could dispatch after consuming the complete foreground execution window");
  const originalDeadlineExpiry = daemonReconnectExpiry({ remainingTimeoutMs: 20_000 }, relayContract.reconnectGraceMs);
  assert(originalDeadlineExpiry.reason === "original_call_deadline_expired_during_reconnect"
    && originalDeadlineExpiry.message === "original call deadline expired during reconnect",
  "disconnect diagnostics mislabeled the original foreground deadline as the longer reconnect grace");
  const reconnectGraceExpiry = daemonReconnectExpiry({ remainingTimeoutMs: relayContract.reconnectGraceMs }, relayContract.reconnectGraceMs);
  assert(reconnectGraceExpiry.reason === "reconnect_grace_expired"
    && reconnectGraceExpiry.message === "reconnect grace expired",
  "disconnect diagnostics failed to report a full reconnect-grace expiry when it is the actual limiter");
  const browserForegroundBudget = daemonToolTimeoutBudget("browser_action", { timeout_seconds: 45 });
  assert(browserForegroundBudget.executionTimeoutMs === 45_000 && browserForegroundBudget.settlementTimeoutMs === 50_000,
    "non-process configurable foreground tool lost its reply-safe maximum budget");
  const computerObserveDefaultBudget = daemonToolTimeoutBudget("computer_observe", {});
  const computerActDefaultBudget = daemonToolTimeoutBudget("computer_act", {});
  assert(computerObserveDefaultBudget.executionTimeoutMs === 30_000 && computerObserveDefaultBudget.settlementTimeoutMs === 35_000,
    "compound Computer Use observation default is shorter than its local end-to-end capture budget");
  assert(computerActDefaultBudget.executionTimeoutMs === 30_000 && computerActDefaultBudget.settlementTimeoutMs === 35_000,
    "compound Computer Use action default is shorter than its local end-to-end action budget");
  for (const requested of [46, "45"]) {
    let rejected;
    try { daemonToolTimeoutBudget("browser_action", { timeout_seconds: requested }); }
    catch (error) { rejected = error; }
    assert(rejected instanceof WorkerToolError && rejected.code === "invalid_request" && rejected.retryable === false,
      `non-process remote foreground timeout ${String(requested)} was not rejected before dispatch`);
    assert(rejected.details?.side_effects_started === false
      && rejected.details?.maximum_foreground_timeout_seconds === 45,
    `non-process remote foreground timeout ${String(requested)} omitted its no-side-effect limit`);
  }
  for (const requested of [31, 46, 61, 85, 120, 600]) {
    const accepted = daemonToolTimeoutBudget("exec_command", { timeout_seconds: requested });
    assert(accepted.executionTimeoutMs === 10_000 && accepted.settlementTimeoutMs === 15_000,
      `durable remote execution timeout ${requested} altered the acceptance budget`);
  }
  for (const requested of [0, -1, 1.5, "60", null, {}, Number.NaN, 601]) {
    let rejected;
    try { daemonToolTimeoutBudget("exec_command", { timeout_seconds: requested }); }
    catch (error) { rejected = error; }
    assert(rejected instanceof WorkerToolError && rejected.code === "invalid_request" && rejected.retryable === false,
      `malformed durable remote timeout ${String(requested)} was not rejected before dispatch`);
    assert(rejected.details?.side_effects_started === false
      && rejected.details?.minimum_execution_timeout_seconds === 1
      && rejected.details?.maximum_execution_timeout_seconds === 600,
    `malformed durable remote timeout ${String(requested)} omitted its strict pre-dispatch bounds`);
  }
  const validArguments = validateWorkerToolArguments("read_file", { path: "fixture.txt" });
  assert(validArguments.known && validArguments.valid, "Worker tool argument validator rejected a valid catalog call");
  const invalidArguments = validateWorkerToolArguments("read_file", { path: "fixture.txt", unexpected: true });
  assert(invalidArguments.known && !invalidArguments.valid
    && invalidArguments.issues.some((issue) => issue.keyword === "additionalProperties"),
  "Worker tool argument validator accepted an unknown field or lost its stable issue keyword");
  assert(validateWorkerToolArguments("missing_tool", {}).known === false,
    "Worker tool argument validator treated an unknown tool as a known schema");
  assert(remoteForegroundMaximumSeconds.length === 1,
    "remote foreground maximum implementation drifted from its declared one-parameter API");
  const configurableRemoteTools = workspaceTools.filter((tool) => tool.inputSchema?.properties?.timeout_seconds);
  for (const tool of configurableRemoteTools) {
    const timeout = tool.inputSchema.properties.timeout_seconds;
    if (isRemoteDurableProcessTool(tool.name)) {
      assert(timeout.maximum === 600 && timeout.default === 600,
        `remote ${tool.name} schema did not expose the durable execution budget`);
      assert(Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes("idempotency_key"),
        `remote ${tool.name} schema did not require a caller-held recovery credential before dispatch`);
      const budget = daemonToolTimeoutBudget(tool.name, {});
      assert(budget.executionTimeoutMs === 10_000 && budget.settlementTimeoutMs === 15_000,
        `remote ${tool.name} acceptance budget regained command lifetime coupling`);
      continue;
    }
    const expectedDefault = remoteForegroundDefaultSeconds(tool.name);
    const expectedMaximum = remoteForegroundMaximumSeconds(tool.name);
    assert(timeout.maximum === expectedMaximum && timeout.default === expectedDefault,
      `remote ${tool.name} schema drifted from its hosted timeout contract`);
    const budget = daemonToolTimeoutBudget(tool.name, {});
    assert(budget.executionTimeoutMs === expectedDefault * 1000
      && budget.settlementTimeoutMs === expectedDefault * 1000 + relayContract.workerSettlementOverheadMs,
    `remote ${tool.name} runtime default did not preserve a distinct settlement margin`);
  }
  assert(String(serverInfoTool.description || "").includes(`Tool schema generation ${workerToolSchemaGeneration}.`)
    && workspaceTools.every((tool) => String(tool.description || "").includes(`Tool schema generation ${workerToolSchemaGeneration}.`)),
  "host-visible tool descriptions omitted the current schema generation marker");
  const remoteBrowserDescription = String(workspaceTools.find((tool) => tool.name === "browser_action")?.description || "");
  assert(remoteBrowserDescription.includes("request-bounded")
    && remoteBrowserDescription.includes("split longer browser/application workflows")
    && remoteBrowserDescription.includes("run_process/start_job")
    && remoteBrowserDescription.includes("start_process only when interactive stdin or incremental process output")
    && !remoteBrowserDescription.includes("use process sessions or managed jobs for longer work"),
  "configurable foreground guidance still routes generic long browser/application work into process sessions");
  const remoteExec = workspaceTools.find((tool) => tool.name === "exec_command");
  const remoteExecDescription = String(remoteExec?.description || "");
  assert(remoteExecDescription.includes("one-step durable job")
    && remoteExecDescription.includes("job_id")
    && remoteExecDescription.includes("read_job")
    && remoteExecDescription.includes("30 minutes pre-spawn")
    && remoteExecDescription.includes("current_phase=resource_admission")
    && remoteExecDescription.includes("bounded same-response read_job follow-up")
    && remoteExecDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time")
    && remoteExecDescription.includes(`Tool schema generation ${workerToolSchemaGeneration}.`),
  "remote exec_command description omitted the durable execution, pre-spawn admission, recovery, or bounded follow-up contract");
  const remoteStartJob = workspaceTools.find((tool) => tool.name === "start_job");
  const remoteStageJob = workspaceTools.find((tool) => tool.name === "stage_job");
  const remoteStartJobDescription = String(remoteStartJob?.description || "");
  const remoteListJobsDescription = String(workspaceTools.find((tool) => tool.name === "list_jobs")?.description || "");
  const remoteReadJob = workspaceTools.find((tool) => tool.name === "read_job");
  const remoteReadJobDescription = String(remoteReadJob?.description || "");
  assert(remoteStartJob?.inputSchema?.required?.includes("idempotency_key")
    && remoteStartJobDescription.includes("idempotency_key known before dispatch")
    && remoteStartJobDescription.includes("same idempotency_key")
    && remoteStartJobDescription.includes("durable background ownership")
    && remoteStartJobDescription.includes("bounded same-response read_job follow-up")
    && remoteStartJobDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time"),
  "remote start_job schema/description omitted idempotent acceptance recovery or the durable autonomous-follow-up contract");
  const startJobWithoutRecoveryKey = validateWorkerToolArguments("start_job", { steps: [{ argv: ["true"] }] });
  const startJobWithRecoveryKey = validateWorkerToolArguments("start_job", {
    idempotency_key: "hosted-start-job-validator", steps: [{ argv: ["true"] }],
  });
  assert(startJobWithoutRecoveryKey.known && !startJobWithoutRecoveryKey.valid
    && startJobWithoutRecoveryKey.issues.some((issue) => issue.keyword === "required")
    && startJobWithRecoveryKey.known && startJobWithRecoveryKey.valid,
  "actual Worker invocation validator did not enforce hosted start_job recovery-key admission");
  const startJobRecovery = daemonToolRecovery("start_job", { idempotency_key: "hosted-start-job-recovery" });
  assert(startJobRecovery?.credential === "idempotency_key"
    && startJobRecovery?.action === "retry_same_tool_arguments_with_same_idempotency_key"
    && startJobRecovery?.result_tool_after_acceptance === "read_job"
    && daemonToolRecovery("start_job", {}) === null,
  "hosted start_job timeout/disconnect recovery did not bind the same idempotency credential used by admission");
  const readJobRecovery = daemonToolRecovery("read_job", { job_id: `job_${"r".repeat(64)}` });
  const readJobDisconnect = publicWorkerToolError(dispatchedDaemonDisconnectError("daemon restart", readJobRecovery, "daemon_planned_drain"));
  assert(readJobRecovery?.credential === "job_id"
    && readJobRecovery?.action === "retry_read_job_with_same_job_id"
    && readJobDisconnect.code === "unavailable"
    && readJobDisconnect.retryable === true
    && readJobDisconnect.details?.side_effects_started === false
    && readJobDisconnect.details?.reason === "daemon_planned_drain"
    && readJobDisconnect.details?.recovery?.job_id === readJobRecovery.job_id
    && daemonToolRecovery("read_job", {}) === null,
  "hosted read_job disconnect recovery did not preserve the same read-only job identity");
  const genericPlannedDrain = publicWorkerToolError(dispatchedDaemonPlannedDrainError());
  assert(genericPlannedDrain.code === "unavailable"
    && genericPlannedDrain.retryable === false
    && genericPlannedDrain.details?.side_effects_started === true
    && genericPlannedDrain.details?.effect_settlement === "unknown"
    && genericPlannedDrain.details?.reason === "daemon_planned_drain",
  "planned daemon drain weakened ambiguous generic-call settlement into a blind retry");
  for (const tool of [remoteStageJob, remoteStartJob]) {
    assert(tool?.inputSchema?.properties?.steps?.items?.properties?.timeout_seconds?.maximum === 21_600
      && tool?.inputSchema?.properties?.finally_steps?.items?.properties?.timeout_seconds?.maximum === 21_600,
    "remote managed-job schema cannot express one continuous step beyond 100 minutes");
  }
  assert(remoteListJobsDescription.includes("inventory operation")
    && remoteListJobsDescription.includes("Do not repeat list_jobs")
    && remoteListJobsDescription.includes("use read_job instead"),
  "remote list_jobs description no longer routes known-job follow-up through read_job");
  assert(remoteReadJob?.inputSchema?.properties?.wait_ms?.default === 40_000
    && remoteReadJob?.inputSchema?.properties?.wait_ms?.maximum === 300_000
    && remoteReadJobDescription.includes("server-side long-poll")
    && remoteReadJobDescription.includes("wait up to 40 seconds")
    && remoteReadJobDescription.includes("wait_ms=0")
    && remoteReadJobDescription.includes("same assistant response")
    && remoteReadJobDescription.includes("Do not busy-loop")
    && remoteReadJobDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time"),
  "remote read_job schema/description lost paced same-turn autonomous follow-up");
  const immediateJobReadBudget = daemonToolTimeoutBudget("read_job", { wait_ms: 0 });
  const defaultJobReadBudget = daemonToolTimeoutBudget("read_job", {});
  const maximumJobReadBudget = daemonToolTimeoutBudget("read_job", { wait_ms: 300_000 });
  assert(immediateJobReadBudget.executionTimeoutMs === 10_000 && immediateJobReadBudget.settlementTimeoutMs === 15_000
    && defaultJobReadBudget.executionTimeoutMs === 50_000 && defaultJobReadBudget.settlementTimeoutMs === 55_000
    && maximumJobReadBudget.executionTimeoutMs === 310_000 && maximumJobReadBudget.settlementTimeoutMs === 315_000,
  "remote read_job long-poll did not retain enough execution/settlement headroom inside its dedicated relay ceiling");
  const recoveredJobReadBudget = daemonToolTimeoutBudgetAfterDelay(defaultJobReadBudget, 15_000);
  const recoveredJobReadArgs = managedJobReadArgumentsWithinExecutionBudget({}, recoveredJobReadBudget.executionTimeoutMs);
  assert(recoveredJobReadBudget.executionTimeoutMs === 35_000
    && recoveredJobReadBudget.settlementTimeoutMs === 40_000
    && recoveredJobReadArgs.wait_ms === 25_000,
  "daemon recovery left read_job sleeping beyond its reduced execution deadline");
  const shortJobReadArgs = { wait_ms: 20_000 };
  assert(managedJobReadArgumentsWithinExecutionBudget(shortJobReadArgs, recoveredJobReadBudget.executionTimeoutMs) === shortJobReadArgs,
    "daemon recovery rewrote a read_job wait that already fit inside the remaining execution budget");
  assert(managedJobReadArgumentsWithinExecutionBudget({ wait_ms: 0 }, 1_000).wait_ms === 0,
    "read_job recovery budget rewrote an explicit immediate checkpoint");
  assert(managedJobReadArgumentsWithinExecutionBudget({}, 20_000).wait_ms === 10_000,
    "read_job redelivery did not reserve reconciliation headroom from the remaining execution window");
  assert(managedJobReadExecutionBudgetHasHeadroom(10_000) === true
    && managedJobReadExecutionBudgetHasHeadroom(9_999) === false
    && managedJobReadExecutionBudgetHasHeadroom(Number.NaN) === false,
  "read_job recovery accepted a dispatch window that cannot cover its bounded reconciliation headroom");
  const remoteStartProcess = workspaceTools.find((tool) => tool.name === "start_process");
  const remoteStartProcessDescription = String(remoteStartProcess?.description || "");
  assert(remoteStartProcessDescription.includes("interactive stdin or incremental-output")
    && remoteStartProcessDescription.includes("run_process")
    && remoteStartProcessDescription.includes("Bounded same-response read_process follow-up")
    && remoteStartProcessDescription.includes("blocking-poll cooldown")
    && remoteStartProcessDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time"),
  "remote start_process description omitted the paced hosted-follow-up contract");
  const remoteReadProcess = workspaceTools.find((tool) => tool.name === "read_process");
  const remoteReadProcessDescription = String(remoteReadProcess?.description || "");
  assert(remoteReadProcess?.inputSchema?.properties?.wait_ms?.maximum === 1_000
    && remoteReadProcess?.inputSchema?.properties?.wait_ms?.default === 1_000,
    "remote read_process schema lost its one-second server-paced default/maximum");
  assert(remoteReadProcessDescription.includes("paced follow-up")
    && remoteReadProcessDescription.includes("same MCP call")
    && remoteReadProcessDescription.includes("cooldown boundary")
    && remoteReadProcessDescription.includes("same assistant response")
    && remoteReadProcessDescription.includes("next_blocking_poll_after_ms")
    && remoteReadProcessDescription.includes("must not busy-loop")
    && remoteReadProcessDescription.includes("run_process/read_job")
    && !remoteReadProcessDescription.includes("poll again"),
  "remote read_process description lost server-paced same-response follow-up limits");
  const immediateReadBudget = daemonToolTimeoutBudget("read_process", { wait_ms: 0 });
  const defaultReadBudget = daemonToolTimeoutBudget("read_process", {});
  const maximumReadBudget = daemonToolTimeoutBudget("read_process", { wait_ms: 1_000 });
  assert(immediateReadBudget.executionTimeoutMs === 5_000 && immediateReadBudget.settlementTimeoutMs === 10_000
    && defaultReadBudget.executionTimeoutMs === 20_000 && defaultReadBudget.settlementTimeoutMs === 25_000
    && maximumReadBudget.executionTimeoutMs === 20_000 && maximumReadBudget.settlementTimeoutMs === 25_000,
  "remote process polling budget cannot cover the server-paced default/cooldown without widening the relay ceiling");
  const startProcessBudget = daemonToolTimeoutBudget("start_process", {});
  assert(startProcessBudget.executionTimeoutMs === relayContract.processSessionStartExecutionTimeoutMs
    && startProcessBudget.settlementTimeoutMs === relayContract.processSessionStartExecutionTimeoutMs + relayContract.workerSettlementOverheadMs,
    "process-session startup regained an interruption-prone remote deadline");
  assert(relayContract.maximumExecutionTimeoutMs === 45_000
    && relayContract.maximumOrdinaryRelayToolTimeoutMs === 50_000
    && relayContract.maximumRelayToolTimeoutMs === 315_000,
  "ordinary relay tools lost their reply-safe ceiling or managed-job status lost its dedicated long-poll envelope");
  const deliveryContract = remoteToolDeliveryContract("test-version", { activeForAccount: 1, openedForAccount: true });
  assert(deliveryContract.remote_process_blocking_poll_wait_max_ms === 1_000
    && deliveryContract.remote_process_blocking_poll_cooldown_ms === 15_000
    && deliveryContract.remote_managed_job_read_wait_default_ms === 40_000
    && deliveryContract.remote_managed_job_read_wait_max_ms === 300_000
    && deliveryContract.remote_managed_job_read_concurrency_max_per_account === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT
    && deliveryContract.tool_schema_generation === workerToolSchemaGeneration
    && deliveryContract.tool_schema_server_version === "test-version"
    && deliveryContract.discovery_ttl_ms === 0
    && deliveryContract.tool_list_ttl_ms === 0
    && deliveryContract.host_visible_schema_known_to_server === false
    && deliveryContract.host_schema_refresh_required_on_generation_change === true
    && deliveryContract.tools_list_change_subscription_supported === true
    && deliveryContract.tools_list_change_subscription_active_for_account === 1
    && deliveryContract.tools_list_change_subscription_opened_for_account === true
    && deliveryContract.tools_list_change_subscription_client_receipt_observable === false
    && deliveryContract.tools_list_change_subscription_lease_ms === MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS
    && deliveryContract.host_turn_deadline_observable === false
    && deliveryContract.managed_jobs_detached_from_mcp_response === true
    && !("remote_process_poll_wait_max_ms" in deliveryContract)
    && !("remote_process_poll_cooldown_ms" in deliveryContract),
  "server_info tool-delivery projection lost schema freshness evidence or retained ambiguous process-poll field names");
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
  const poisonedTools = sanitizeDaemonTools([
    "read_file", "read_file", "server_info", "unknown_private_tool", "__proto__", 17,
  ], review);
  assert(poisonedTools.length === 1 && poisonedTools[0] === "read_file",
    "daemon capability metadata injected an unknown, reserved, duplicate, or non-string tool into the Worker ceiling");
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
  assert(structured.resultType === "complete" && structured.structuredContent?.ok === true,
    "special MCP tool result lost current result type or structured content");
  const ordinary = textToolResult({ ok: true });
  assert(ordinary.resultType === "complete" && ordinary.structuredContent?.ok === true && ordinary.content[0].type === "text",
    "ordinary tool result lost current result type, text, or structured content");
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
  const disconnected = publicWorkerToolError(dispatchedDaemonDisconnectError(
    "daemon disconnected; original call deadline expired during reconnect", undefined,
    "original_call_deadline_expired_during_reconnect",
  ));
  assert(disconnected.code === "unavailable" && disconnected.retryable === false
    && disconnected.details?.side_effects_started === true
    && disconnected.details?.termination_requested === false
    && disconnected.details?.effect_settlement === "unknown"
    && disconnected.details?.reason === "original_call_deadline_expired_during_reconnect",
  "dispatched daemon reconnect deadline lost its safe cause or advertised unknown side effects as safely retryable");
  const timedOut = publicWorkerToolError(dispatchedDaemonTimeoutError("exec_command"));
  assert(timedOut.code === "timeout" && timedOut.retryable === false
    && timedOut.details?.termination_requested === true && timedOut.details?.effect_settlement === "pending",
  "dispatched daemon timeout lost ambiguous-side-effect settlement metadata");
  const durableRecovery = {
    mode: "idempotent_replay", source_tool: "run_process", credential: "idempotency_key",
    credential_source: "original_request_arguments", action: "retry_same_tool_arguments_with_same_idempotency_key",
  };
  const durableTimedOut = publicWorkerToolError(dispatchedDaemonTimeoutError("run_process", true, durableRecovery));
  assert(durableTimedOut.details?.recovery?.credential === "idempotency_key"
    && durableTimedOut.details?.recovery?.credential_source === "original_request_arguments"
    && durableTimedOut.details?.recovery?.idempotency_key === undefined
    && durableTimedOut.details?.recovery?.action === "retry_same_tool_arguments_with_same_idempotency_key",
  "durable process acceptance timeout lost its recovery instruction or echoed the caller-held key");
  const durableDisconnected = publicWorkerToolError(dispatchedDaemonDisconnectError("daemon disconnected", durableRecovery));
  assert(durableDisconnected.details?.recovery?.credential_source === "original_request_arguments"
    && durableDisconnected.details?.recovery?.idempotency_key === undefined,
  "durable process daemon disconnect lost its idempotent replay recovery contract or echoed the recovery key");
  const notReceived = publicWorkerToolError(daemonCallNotReceivedAfterReconnectError(durableRecovery));
  assert(notReceived.code === "unavailable" && notReceived.retryable === true
    && notReceived.details?.side_effects_started === false
    && notReceived.details?.reason === "daemon_call_not_received_after_reconnect"
    && notReceived.details?.recovery?.credential_source === "original_request_arguments"
    && notReceived.details?.recovery?.idempotency_key === undefined,
  "daemon-proven non-delivery did not become a safe retry without echoing the durable recovery key");
  const cancelUnknown = publicWorkerToolError(dispatchedDaemonCancellationError("cancelled after disconnect", false));
  assert(cancelUnknown.code === "cancelled" && cancelUnknown.details?.termination_requested === false
    && cancelUnknown.details?.effect_settlement === "unknown",
  "dispatched daemon cancellation invented a termination request after transport loss");
  const revoked = publicWorkerToolError(revokedDaemonAuthorityError());
  assert(revoked.code === "authorization_denied" && revoked.retryable === false
    && revoked.details?.side_effects_started === true && revoked.details?.effect_settlement === "unknown",
  "authority revocation lost its non-retryable dispatched-call settlement boundary");
  const malformed = daemonToolError(null);
  assert(malformed.code === "execution_failed" && malformed.message === "daemon tool failed" && malformed.details === undefined,
    "malformed daemon error did not collapse to the bounded public fallback");
  const hidden = publicWorkerToolError(new Error("private internal details"));
  assert(hidden.message === "tool execution failed" && !hidden.message.includes("private"), "Worker exposed raw internal exception text");
  assert(JSON.stringify(daemonResumeMissingCallIds(["call_valid_12345678"])) === JSON.stringify(["call_valid_12345678"]),
    "Worker rejected a bounded valid resume acknowledgement call ID");
  assert(daemonResumeMissingCallIds(["call_duplicate_12345678", "call_duplicate_12345678"]) === null
    && daemonResumeMissingCallIds(["invalid"]) === null
    && daemonResumeMissingCallIds(null) === null,
  "Worker accepted malformed or duplicate resume acknowledgement call IDs");
}

function testDaemonAndServerInfoProjection() {
  const lastObservation = new DaemonLastObservation();
  lastObservation.remember({ daemonTransport: "https" }, {
    role: "daemon", connectedAt: "2026-08-10T00:00:00.000Z", lastSeenAt: "2026-08-10T00:00:01.000Z",
    instanceId: "daemon_private_instance_1234", policy: { profile: "full" }, tools: ["read_file"],
    relayDiagnostics: { schema_version: 1, transport: "https", outage_count: 4 },
  }, true);
  const retainedObservation = lastObservation.snapshot();
  assert(retainedObservation?.transport === "https" && retainedObservation.relayDiagnostics?.outage_count === 4
    && !("tools" in retainedObservation) && !("policy" in retainedObservation) && !("instanceId" in retainedObservation),
  "last daemon observation retained authority, tool, or instance identity instead of only forensic transport state");

  const socket = {};
  const attachment = {
    connectedAt: "2026-08-10T00:00:00.000Z",
    lastSeenAt: "2026-08-10T00:00:01.000Z",
    tools: ["read_file", "git_status"],
    policy: "workspace",
    relayDiagnostics: { transport: "websocket" },
  };
  const daemonRegistry = {
    readySockets() { return [socket]; },
    readyAttachment(value) { return value === socket ? attachment : undefined; },
    probingSockets() { return [{}]; },
    candidateSockets() { return [{}, {}]; },
    readyRoleSockets() { return [socket]; },
  };
  const compactDaemon = daemonStatusSnapshot(daemonRegistry, false);
  assert(compactDaemon.connected === true && compactDaemon.count === 1 && compactDaemon.tool_count === 2
    && !("tools" in compactDaemon), "daemon status summary exposed detail fields or lost readiness");
  const fullDaemon = daemonStatusSnapshot(daemonRegistry, true);
  assert(fullDaemon.policy === "workspace" && fullDaemon.tools.length === 2
    && fullDaemon.relay_transport?.transport === "websocket", "daemon status full projection lost current runtime detail");
  const emptyDaemon = daemonStatusSnapshot({
    readySockets() { return []; },
    readyAttachment() { return undefined; },
  }, true);
  assert(emptyDaemon.connected === false && emptyDaemon.tool_count === 0 && emptyDaemon.policy === null,
    "empty daemon status invented a connected daemon");
  const disconnectedDaemon = daemonStatusSnapshot({
    readySockets() { return []; },
    readyAttachment() { return undefined; },
    lastDaemonObservation() {
      return {
        transport: "websocket", connectedAt: "2026-08-10T00:00:00.000Z",
        lastSeenAt: "2026-08-10T00:00:03.000Z", disconnectedAt: "2026-08-10T00:00:04.000Z",
        relayDiagnostics: { schema_version: 1, transport: "websocket", outage_count: 2 },
      };
    },
  }, false);
  assert(disconnectedDaemon.connected === false
    && disconnectedDaemon.previous_connection?.transport === "websocket"
    && disconnectedDaemon.previous_connection?.disconnected_at === "2026-08-10T00:00:04.000Z"
    && disconnectedDaemon.previous_connection?.relay_transport?.outage_count === 2,
  "disconnected daemon status discarded the privacy-bounded last verified transport observation");

  const pendingSnapshot = {
    active: 2, pre_dispatch_waiters: 1, capacity_active: 3,
    maximum: 8, ordinary_capacity: 7, reserved_capacity: 1,
    active_ordinary: 1, active_reserved: 1, capacity_active_ordinary: 2, capacity_active_reserved: 1,
    detached: 1, oldest_ms: 42,
  };
  const observability = { snapshot() { return { requests: { total: 3 } }; } };
  const ownerAuthorization = {
    account: { role: "owner", version: 4, id: "hidden-owner-id" },
    summary: { role: "owner" }, effective_policy: "full", effective_tool_count: 2,
    account_role_is_owner: true, effective_profile_is_full: true,
    execution_model: { within_effective_authority: true, owner_ambient_authority: true, private: "drop" },
  };
  const input = {
    serverName: "machine-bridge-mcp", serverVersion: "3.0.0-beta.61", base: "https://example.test",
    oauth: { issuer: "https://example.test" }, authorization: ownerAuthorization,
    daemon: { ...fullDaemon, policy_scope: "ceiling", tools_scope: "daemon", extra: "detail" },
    effectiveTools: ["read_file", "git_status"], advertisedTools: ["read_file", "git_status", "write_file"],
    pendingSnapshot, daemonRegistry, observability,
    continuityEvidence: {
      schema_version: 1, planned_drains: 2, planned_drain_calls: 3,
      last_planned_drain_at: "2026-08-10T00:00:05.000Z", socket_disconnects: 4,
      unplanned_socket_disconnects: 1,
      last_socket_disconnect: { at: "2026-08-10T00:00:06.000Z", planned: true, kind: "close", close_code: 1001, was_clean: true },
      last_request_abort_at: null, last_stream_cancel_control_at: null,
    },
  };
  assert(serverInfoDetail({ detail: "summary" }) === "summary" && serverInfoDetail({ detail: "future" }) === "full"
    && serverInfoDetail() === "full",
    "server_info detail selector guessed an unsupported projection");
  const ownerFull = buildServerInfoResult(input, "full");
  assert(ownerFull.worker.pending_calls.active === 2
    && ownerFull.worker.pending_calls.pre_dispatch_waiters === 1
    && ownerFull.worker.pending_calls.capacity_active === 3
    && ownerFull.worker.daemon_candidates === 2
    && ownerFull.worker.observability.requests.total === 3
    && ownerFull.worker.continuity_evidence.planned_drains === 2
    && ownerFull.worker.continuity_evidence.last_socket_disconnect.planned === true
    && ownerFull.tools.length === 2,
  "owner server_info full projection lost current Worker activity or pre-dispatch capacity");
  const ownerSummary = buildServerInfoResult(input, "summary");
  assert(ownerSummary.detail === "summary" && ownerSummary.authorization.account.role === "owner"
    && ownerSummary.authorization.account.id === undefined
    && ownerSummary.authorization.execution_model.private === undefined
    && ownerSummary.worker.pending_calls.detached === 1
    && ownerSummary.worker.pending_calls.pre_dispatch_waiters === 1
    && ownerSummary.worker.pending_calls.capacity_active === 3
    && ownerSummary.worker.pending_calls.capacity_active_ordinary === 2
    && ownerSummary.worker.pending_calls.capacity_active_reserved === 1,
  "owner server_info summary did not compact identity/activity/capacity fields");
  const delegatedInput = {
    ...input,
    authorization: {
      ...ownerAuthorization, account: "invalid-account-shape", account_role_is_owner: false,
      execution_model: null,
    },
  };
  const delegatedFull = buildServerInfoResult(delegatedInput, "full");
  assert(delegatedFull.worker.pending_calls.activity_hidden_by_authority === true
    && delegatedFull.daemon.tools_hidden_by_authority === true && delegatedFull.daemon.tools.length === 0
    && delegatedFull.worker.continuity_evidence === undefined,
  "delegated server_info full projection leaked global Worker or daemon tool activity");
  const delegatedSummary = buildServerInfoResult(delegatedInput, "summary");
  assert(delegatedSummary.authorization.account === null
    && delegatedSummary.authorization.execution_model === null
    && delegatedSummary.worker.pending_calls.activity_hidden_by_authority === true,
  "delegated server_info summary invented compact private identity/activity");

  const emptyRegistry = {
    readySockets() { return []; }, probingSockets() { return []; }, candidateSockets() { return []; }, readyRoleSockets() { return []; },
  };
  const emptyOwnerSummary = buildServerInfoResult({
    ...input,
    authorization: { account_role_is_owner: true },
    daemon: {},
    effectiveTools: [],
    advertisedTools: [],
    pendingSnapshot: {},
    daemonRegistry: emptyRegistry,
  }, "summary");
  assert(emptyOwnerSummary.authorization.account === null
    && emptyOwnerSummary.authorization.effective_policy === null
    && emptyOwnerSummary.authorization.effective_tool_count === 0
    && emptyOwnerSummary.authorization.account_role_is_owner === true
    && emptyOwnerSummary.authorization.effective_profile_is_full === false
    && emptyOwnerSummary.authorization.execution_model === null
    && emptyOwnerSummary.daemon.connected === false
    && emptyOwnerSummary.daemon.count === 0
    && emptyOwnerSummary.daemon.connected_at === null
    && emptyOwnerSummary.daemon.readiness_timeout_ms === null
    && emptyOwnerSummary.daemon.relay_transport === null
    && emptyOwnerSummary.worker.pending_calls.active === 0
    && emptyOwnerSummary.worker.pending_calls.maximum === 0
    && emptyOwnerSummary.worker.pending_calls.detached === 0,
  "server_info summary default projection invented current daemon, authority, or pending activity");
}

async function testWorkerContinuityEvidence() {
  const values = new Map();
  const transaction = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
  };
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async transaction(callback) { return callback(transaction); },
  };
  assert(await recordWorkerPlannedDrain(storage, 3, Date.parse("2026-08-25T13:00:00.000Z")),
    "planned-drain continuity evidence was not persisted");
  assert(await recordWorkerSocketDisconnect(storage, {
    planned: true, kind: "close", closeCode: 1001, wasClean: true,
  }, Date.parse("2026-08-25T13:00:01.000Z")), "planned socket-close evidence was not persisted");
  assert(await recordWorkerSocketDisconnect(storage, {
    planned: false, kind: "error",
  }, Date.parse("2026-08-25T13:00:02.000Z")), "unplanned socket-error evidence was not persisted");
  assert(await recordWorkerClientCancellation(storage, "request_abort", Date.parse("2026-08-25T13:00:03.000Z"))
    && await recordWorkerClientCancellation(storage, "stream_cancel_control", Date.parse("2026-08-25T13:00:04.000Z")),
  "client-cancellation continuity evidence was not persisted");
  const snapshot = await readWorkerContinuityEvidence(storage);
  assert(snapshot.schema_version === 1
    && snapshot.planned_drains === 1 && snapshot.planned_drain_calls === 3
    && snapshot.socket_disconnects === 2 && snapshot.unplanned_socket_disconnects === 1
    && snapshot.last_socket_disconnect?.kind === "error" && snapshot.last_socket_disconnect?.planned === false
    && snapshot.last_request_abort_at === "2026-08-25T13:00:03.000Z"
    && snapshot.last_stream_cancel_control_at === "2026-08-25T13:00:04.000Z",
  "durable continuity evidence lost fixed-category incident history across reads");
  values.set("worker-continuity-evidence", {
    schema_version: 99, planned_drains: 7, last_socket_disconnect: { at: "private", kind: "other" },
  });
  const sanitized = await readWorkerContinuityEvidence(storage);
  assert(sanitized.schema_version === 1 && sanitized.planned_drains === 0 && sanitized.last_socket_disconnect === null,
    "durable continuity evidence trusted malformed stored state instead of failing closed to bounded defaults");
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
  metrics.daemonTerminalResult("committed");
  metrics.daemonTerminalResult("owner_missing_acknowledged");
  metrics.daemonTerminalResult("stale_connection_rejected");
  metrics.recordError("request_metadata_failed");
  metrics.socketCandidate();
  metrics.socketAuthenticated();
  metrics.socketReady();
  metrics.socketDisconnected();
  metrics.socketProtocolError("protocol_error");
  metrics.oauthRefreshEvent("rotated");
  metrics.oauthRefreshEvent("retry_issued");
  metrics.runtimeAlarmMutation("set");
  metrics.runtimeAlarmMutation("noop");
  const snapshot = metrics.snapshot();
  assert(snapshot.metric_scope.lifecycle === "current_worker_isolate"
    && snapshot.metric_scope.request_scoped_calls === true
    && snapshot.metric_scope.counters_may_not_balance_across_isolate_restarts === true,
  "Worker metrics do not disclose their isolate-local request-scoped time domain");
  assert(snapshot.requests.total === 3 && snapshot.requests.client_error === 1 && snapshot.requests.server_error === 1, "Worker request metrics are incomplete");
  assert(snapshot.calls.started === 2 && snapshot.calls.completed === 1 && snapshot.calls.failed === 1, "Worker call metrics are incomplete");
  assert(snapshot.terminal_results.committed === 1
    && snapshot.terminal_results.owner_missing_acknowledged === 1
    && snapshot.terminal_results.stale_connection_rejected === 1,
  "Worker terminal-result dispositions were not retained independently");
  assert(snapshot.errors.policy_denied === 1 && snapshot.errors.protocol_error === 1
    && snapshot.errors.request_metadata_failed === 1, "Worker error-code metrics are incomplete");
  assert(snapshot.tools.read_file.completed === 1 && snapshot.tools.write_file.failed === 1, "Worker per-tool metrics are incomplete");
  assert(snapshot.sockets.candidates === 1 && snapshot.sockets.authenticated === 1
    && snapshot.sockets.ready === 1 && snapshot.sockets.disconnected === 1,
  "Worker socket metrics are incomplete");
  assert(snapshot.oauth_refresh.rotated === 1 && snapshot.oauth_refresh.retry_issued === 1, "OAuth refresh metrics are incomplete");
  assert(snapshot.runtime_alarm.sets === 1 && snapshot.runtime_alarm.noops === 1,
    "runtime alarm mutation metrics are incomplete");
  assert(!("stream_transport" in snapshot) && !("durable_budget" in snapshot),
    "Worker observability retained removed durable/replay metrics");

  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    metrics.event("warn", "security.test", {
      access_token: "must-not-leak",
      api_key: "opaque-api-value",
      proof: "opaque-proof-value",
      monkey: "safe-animal",
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
  assert(event.access_token === "<redacted>" && event.api_key === "<redacted>" && event.proof === "<redacted>"
    && !lines[0].includes("must-not-leak") && !lines[0].includes("opaque-api-value") && !lines[0].includes("opaque-proof-value"),
  "Worker structured event leaked a sensitive field-name variant");
  assert(event.monkey === "safe-animal", "Worker sensitive-key matching over-redacted an unrelated field name");
  assert(event.path === "/mcp", "Worker structured event removed a safe route field");
  assert(!lines[0].includes("abcdefghijklmnopqrstuvwxyz") && !lines[0].includes("operator@example.com") && !lines[0].includes("/Users/example"), "Worker structured event leaked a sensitive value embedded in a non-sensitive field");
  assert(event.detail.includes("Bearer <redacted>") && event.detail.includes("<redacted-email>") && event.detail.includes("<home>"), "Worker structured event did not retain redaction markers");
  assert(event.level === "warn" && event.component === "worker" && event.event === "security.test" && event.timestamp !== "1970-01-01T00:00:00.000Z", "Worker event fields overrode authoritative log metadata");

  const prototypeLines = [];
  console.warn = (line) => prototypeLines.push(String(line));
  try {
    metrics.event("warn", "prototype.fields", JSON.parse('{"__proto__":"ordinary-proto","constructor":"ordinary-constructor","access_token":"must-not-leak"}'));
  } finally {
    console.warn = originalWarn;
  }
  const prototypeEvent = JSON.parse(prototypeLines[0]);
  assert(Object.hasOwn(prototypeEvent, "__proto__") && prototypeEvent.__proto__ === "ordinary-proto"
    && prototypeEvent.constructor === "ordinary-constructor" && prototypeEvent.access_token === "<redacted>"
    && !prototypeLines[0].includes("must-not-leak"),
  "Worker structured event did not preserve prototype-shaped keys as sanitized ordinary data");
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
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 30_000).toISOString(),
  }, now), "daemon attachment without the current lastSeenAt field did not fail closed for reconnect");
  assert(Number.isNaN(daemonLivenessDeadlineMs({
    role: "daemon",
    connectedAt: new Date(now - 30_000).toISOString(),
  })), "daemon attachment without current liveness state fabricated a deadline");
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
  let wallNow = 1_700_000_000_000;
  const lines = [];
  const log = createThrottledEdgeLogger({
    intervalMs: 100,
    monotonicNow: () => now,
    wallNow: () => wallNow,
    write: (level, text) => lines.push({ level, value: JSON.parse(text) }),
  });
  assert(log("warn", "rate.failure", {
    detail: "Bearer abcdefghijklmnopqrstuvwxyz for operator@example.com under /Users/example/private\nline",
    access_token: "must-not-leak",
    apiKey: "opaque-api-value",
    proof: "opaque-proof-value",
    monkey: "safe-animal",
  }) === true, "first edge degradation log was suppressed");
  assert(log("warn", "rate.failure", { detail: "second" }) === false, "duplicate edge degradation log was not suppressed");
  assert(log("warn", "rate.failure", { detail: "third" }) === false, "repeated edge degradation log was not suppressed");
  wallNow -= 60_000;
  now += 100;
  assert(log("warn", "rate.failure", { detail: "reopened" }) === true,
    "edge degradation log did not reopen on monotonic time after a wall-clock rollback");
  assert(lines.length === 2 && lines[1].value.suppressed === 2, "edge log did not report its suppressed duplicate count");
  assert(lines[0].value.detail.includes("Bearer <redacted>")
    && lines[0].value.detail.includes("<redacted-email>") && lines[0].value.detail.includes("<home>")
    && lines[0].value.component === "worker-edge" && lines[0].value.access_token === "<redacted>"
    && lines[0].value.apikey === "<redacted>" && lines[0].value.proof === "<redacted>" && lines[0].value.monkey === "safe-animal"
    && !JSON.stringify(lines[0]).includes("must-not-leak") && !JSON.stringify(lines[0]).includes("opaque-api-value")
    && !JSON.stringify(lines[0]).includes("opaque-proof-value") && !JSON.stringify(lines[0]).includes("abcdefghijklmnopqrstuvwxyz")
    && !JSON.stringify(lines[0]).includes("operator@example.com") && !JSON.stringify(lines[0]).includes("/Users/example"),
  "edge log did not apply shared field/value privacy redaction without over-redacting unrelated names");
  now += 100;
  assert(log("warn", "prototype.fields", JSON.parse('{"__proto__":"ordinary-proto","constructor":"ordinary-constructor","private_key":"must-not-leak"}')) === true,
    "prototype-shaped edge log was unexpectedly suppressed");
  const prototype = lines.at(-1).value;
  assert(Object.hasOwn(prototype, "__proto__") && prototype.__proto__ === "ordinary-proto"
    && prototype.constructor === "ordinary-constructor" && prototype.private_key === "<redacted>"
    && !JSON.stringify(prototype).includes("must-not-leak"),
  "edge logger did not preserve prototype-shaped keys as sanitized ordinary data");

  let defaultNow = 10_000;
  const defaultLines = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (line) => defaultLines.push({ level: "warn", value: JSON.parse(String(line)) });
  console.error = (line) => defaultLines.push({ level: "error", value: JSON.parse(String(line)) });
  try {
    const defaultLog = createThrottledEdgeLogger({ intervalMs: 0, monotonicNow: () => defaultNow });
    assert(defaultLog("warn", "Default Writer", { count: 1, ok: true, empty: null, nested: { dropped: true } }),
      "default edge logger suppressed its first warning");
    defaultNow += 60_000;
    assert(defaultLog("error", "Default Writer Error", { count: 2 }),
      "default edge logger did not reopen after its fallback interval");
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert(defaultLines.length === 2 && defaultLines[0].level === "warn" && defaultLines[1].level === "error"
    && defaultLines[0].value.count === 1 && defaultLines[0].value.ok === true && defaultLines[0].value.empty === null
    && !("nested" in defaultLines[0].value) && defaultLines[0].value.event === "default_writer",
  "default edge writer, fallback interval, or scalar field projection lost its contract");
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
      "Access-Control-Request-Headers": "authorization, content-type, dpop, mcp-protocol-version, mcp-method, mcp-name",
    },
  }), identity);
  assert(preflight?.status === 204, "CORS preflight must not depend on Durable Object state");
  assert(preflight.headers.get("access-control-allow-origin") === "https://chatgpt.com", "CORS preflight lost origin allowlist");
  for (const removedHeader of ["last-event-id", "mcp-session-id"]) {
    const removedPreflight = respondWithoutDurableObject(new Request("https://example.test/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://chatgpt.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `authorization, ${removedHeader}`,
      },
    }), identity);
    assert(removedPreflight?.status === 403, `CORS still admitted removed ${removedHeader}`);
  }
  const corsResponse = applyCors(new Response("ok"), new Request("https://example.test/mcp", {
    headers: { Origin: "https://chatgpt.com" },
  }), "https://example.test", "https://chatgpt.com");
  assert(corsResponse.headers.get("access-control-expose-headers") === "www-authenticate",
    "CORS response still exposed a removed MCP session header");

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
  assert(statefulRouteClass("/mcp") === "mcp"
    && statefulRouteClass("/daemon/ws") === "daemon"
    && statefulRouteClass("/oauth/token") === "oauth"
    && statefulRouteClass("/admin/accounts/private-looking-suffix") === "admin"
    && statefulRouteClass("/private-looking-path") === "other",
  "Worker route classifier lost its bounded low-cardinality logging/rate-limit contract");
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
