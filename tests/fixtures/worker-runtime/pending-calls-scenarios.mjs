import schemaMetadata from "../../../src/shared/server-metadata.json" with { type: "json" };
import * as common from "./common.mjs";
const {
   PendingCallRegistry, pendingCallReconnectSettlement,
  MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, settleDaemonProvenMissingCalls, daemonReconnectExpiry, daemonToolTimeoutBudgetAfterDelay, processRuntimeAlarm,
  scheduleRuntimeAlarm, daemonToolTimeoutBudget, isRemoteDurableProcessTool,
  remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds,
  REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS, managedJobReadArgumentsWithinExecutionBudget,
  managedJobReadExecutionBudgetHasHeadroom, daemonToolRedeliveryArguments, issueManagedJobCapability,
  verifyManagedJobCapability, hostedManagedJobDaemonArguments, projectHostedManagedJobResult,
  jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool,
  validateWorkerToolArguments, workerToolParameterHeaders, workerToolSchemaGeneration, workspaceTools,
  staleSchemaGuidanceResult, workerToolsForRole, daemonToolRecovery,
  relayContract, dispatchedDaemonDisconnectError,
  dispatchedDaemonPlannedDrainError, publicWorkerToolError, WorkerToolError, WorkerObservability, readWorkerContinuityEvidence, recordWorkerClientCancellation,
  recordWorkerPlannedDrain, recordWorkerSocketDisconnect, remoteToolDeliveryContract,
  MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS, JOB_MONITOR_RESOURCE_URI, MCP_APP_MIME_TYPE,
  MCP_UI_EXTENSION_ID, managedJobMonitorResource, managedJobMonitorResources,
  supportsManagedJobMonitor, ManagedJobMonitorClaimStore, cancelManagedJobMonitorClaimsIfAvailable,
  claimManagedJobMonitor, hasManagedJobMonitorClaim, hasManagedJobMonitorClaimIfAvailable,
  issueManagedJobMonitorIfAvailable, JOB_MONITOR_CLAIM_TOOL, JOB_MONITOR_READ_TOOL,
  JOB_MONITOR_RENDER_TOOL, managedJobMonitorReadDaemonArguments, renderManagedJobMonitor,
  projectManagedJobMonitorStatus, retainWorkerTask, DAEMON_LIVENESS_TIMEOUT_MS, testDurableStorage, expectRegistrationError, expectReject, assert, expectThrow
} = common;

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
  const socketC = {};
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
    redeliverAfterProvenMissing: () => { redeliveryAttempts += 1; return true; },
  });
  let redeliveryAttempts = 0;
  registry.detachSocket(socketA, 1000, () => new Error("reconnect timeout"));
  assert(registry.rebindInstance("daemon_same_instance_1234", socketB).includes("not-received"),
    "daemon-proven non-delivery fixture did not rebind the pending call");
  const observability = new WorkerObservability();
  const firstMissing = await settleDaemonProvenMissingCalls({
    ids: ["not-received", "unknown"], channel: socketB, pending: registry, observability,
  });
  const duplicateMissing = await settleDaemonProvenMissingCalls({
    ids: ["not-received"], channel: socketB, pending: registry, observability,
  });
  assert(firstMissing.rejected === 0 && firstMissing.redelivered === 1
    && duplicateMissing.rejected === 0 && duplicateMissing.redelivered === 0
    && redeliveryAttempts === 1,
  "daemon-proven non-delivery did not preserve a safely redelivered pending call");
  assert(await registry.resolve("not-received", socketB, { redelivered: true }),
    "redelivered pending call no longer accepted its replacement-channel result");
  assert((await notReceived).redelivered === true, "safe redelivery lost the original pending settlement");

  const missingTwice = registry.register({
    id: "missing-twice", tool: "list_dir", socket: socketA, daemonInstanceId: "daemon_same_instance_1234",
    timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
    redeliverAfterProvenMissing: () => true,
  });
  registry.detachSocket(socketA, 1000, () => new Error("reconnect timeout"));
  assert(registry.rebindInstance("daemon_same_instance_1234", socketB).includes("missing-twice"),
    "first redelivery reconnect did not rebind the pending call");
  const firstRedelivery = await settleDaemonProvenMissingCalls({
    ids: ["missing-twice"], channel: socketB, pending: registry, observability,
  });
  assert(firstRedelivery.redelivered === 1 && firstRedelivery.rejected === 0,
    "first daemon-proven non-delivery did not allow its one transport redelivery");
  registry.detachSocket(socketB, 1000, () => new Error("second reconnect timeout"));
  assert(registry.rebindInstance("daemon_same_instance_1234", socketC).includes("missing-twice"),
    "second reconnect did not rebind the once-redelivered pending call");
  const secondRedelivery = await settleDaemonProvenMissingCalls({
    ids: ["missing-twice"], channel: socketC, pending: registry, observability,
  });
  assert(secondRedelivery.redelivered === 0 && secondRedelivery.rejected === 1,
    "a second daemon-proven non-delivery replayed a call that had already used its one transport redelivery");
  await expectReject(missingTwice, "daemon reconnect confirmed the tool call was not received");

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
  assert(registry.nextDeadlineDelayMs() === 120, "detached call did not receive its bounded result-delivery reconnect grace");
  advance(59);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 1, "detached call expired before its reconnect delivery grace");
  assert(registry.rebindInstance("daemon_pause_12345678", socketB).length === 1, "detached timeout test did not rebind");
  advance(15000);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 0,
    "rebound call expired before the one-time result-delivery grace elapsed");
  advance(1);
  await expectReject(pending, "operation timeout");
  assert(registry.snapshot().active === 0, "rebound call exceeded its bounded result-delivery grace");

  const detachedExpiry = registry.register({
    id: "detached-original-deadline", tool: "run_process", socket: socketA, daemonInstanceId: "daemon_detached_deadline_1",
    timeoutMs: 100, onTimeout: () => new Error("operation timeout"),
  });
  advance(40);
  assert(registry.detachSocket(socketA, 120, () => new Error("reconnect timeout")) === 1, "original-deadline detach did not find its call");
  advance(119);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 1,
    "detached call ignored reconnect grace after extending result settlement");
  advance(1);
  await expectReject(detachedExpiry, "reconnect timeout");
  assert(registry.snapshot().active === 0, "detached reconnect grace exceeded its own fixed ceiling");

  const lateResult = registry.register({
    id: "late-result-after-original-deadline", tool: "exec_command", socket: socketA,
    daemonInstanceId: "daemon_late_result_12345678", timeoutMs: 1000,
    onTimeout: () => new Error("late result operation timeout"),
  });
  advance(400);
  assert(registry.detachSocket(socketA, 20_000, () => new Error("late result reconnect timeout")) === 1,
    "late-result fixture did not detach its call");
  advance(1100);
  assert(registry.rebindInstance("daemon_late_result_12345678", socketB).includes("late-result-after-original-deadline"),
    "result owner expired at the original settlement deadline before same-instance recovery");
  assert(await registry.resolve("late-result-after-original-deadline", socketB, { delivered_after_reconnect: true }),
    "late terminal result was rejected inside the bounded reconnect delivery grace");
  assert((await lateResult).delivered_after_reconnect === true,
    "late terminal result did not settle the original caller after reconnect");

  const socketC = {};
  const handover = registry.register({
    id: "live-handover", tool: "exec_command", socket: socketA, daemonInstanceId: "daemon_handover_12345678",
    timeoutMs: 100, onTimeout: () => new Error("handover operation timeout"),
  });
  advance(40);
  assert(registry.rebindInstance("daemon_handover_12345678", socketC)[0] === "live-handover", "verified same-instance handover did not transfer an attached call");
  assert(!(await registry.resolve("live-handover", socketA, { stale: true })), "old daemon socket retained ownership after handover");
  advance(1000);
  assert(registry.rebindInstance("daemon_handover_12345678", socketB)[0] === "live-handover",
    "second same-instance handover did not transfer the call");
  assert(registry.nextDeadlineDelayMs() === 14_060,
    "repeated same-instance handover changed the fixed result-delivery deadline");
  advance(14_059);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 0,
    "repeated handover shortened or cumulatively extended the fixed delivery grace");
  advance(1);
  await expectReject(handover, "handover operation timeout");
  assert(registry.snapshot().active === 0, "live handover result-delivery grace leaked from the registry");

  const deliveryGrace = registry.register({
    id: "maximum-settlement-delivery-grace", tool: "browser_action", socket: socketA,
    daemonInstanceId: "daemon_maximum_cap_12345678", timeoutMs: relayContract.maximumOrdinaryRelayToolTimeoutMs,
    onTimeout: () => new Error("maximum settlement timeout"),
  });
  advance(1);
  assert(registry.detachSocket(socketA, relayContract.reconnectGraceMs, () => new Error("maximum reconnect timeout")) === 1,
    "maximum-settlement fixture did not detach its call");
  assert(registry.rebindInstance("daemon_maximum_cap_12345678", socketB).includes("maximum-settlement-delivery-grace"),
    "maximum-settlement fixture did not rebind");
  assert(registry.nextDeadlineDelayMs() === relayContract.maximumOrdinaryRelayToolTimeoutMs
      + relayContract.reconnectResultDeliveryGraceMs - 1,
    "reconnect did not preserve a full one-time result-delivery grace beyond the initial settlement ceiling");
  advance(relayContract.maximumOrdinaryRelayToolTimeoutMs - 1);
  assert(registry.snapshot().active === 1,
    "rebound call expired at the initial settlement ceiling instead of retaining result-delivery authority");
  advance(relayContract.reconnectResultDeliveryGraceMs - 1);
  assert(registry.snapshot().active === 1, "result-delivery grace expired one millisecond early");
  advance(1);
  await expectReject(deliveryGrace, "maximum settlement timeout");
  assert(registry.snapshot().active === 0, "one-time result-delivery grace leaked from the registry");
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

async function testRelayTimeoutContract() {
  assert(relayContract.reconnectGraceMs === 120_000, "relay reconnect grace drifted from the incident-tested budget");
  assert(relayContract.newCallReconnectGraceMs === 15_000,
    "new-call recovery no longer covers the bounded HTTPS fallback window before the original execution budget is reduced");
  assert(relayContract.reconnectResultDeliveryGraceMs === 15_000
    && relayContract.reconnectResultDeliveryGraceMs < relayContract.reconnectGraceMs,
  "terminal-result reconnect delivery grace drifted from its bounded one-time recovery contract");
  const firstSettlement = pendingCallReconnectSettlement({
    tool: "exec_command", startedAt: 0, originalDeadlineAt: 1_000, deadlineAt: 1_000,
  }, 400);
  const repeatedSettlement = pendingCallReconnectSettlement({
    tool: "exec_command", startedAt: 0, originalDeadlineAt: 1_000, deadlineAt: firstSettlement.deadlineAt,
  }, 1_400);
  assert(firstSettlement.deadlineAt === 16_000 && firstSettlement.remainingTimeoutMs === 15_600
    && repeatedSettlement.deadlineAt === firstSettlement.deadlineAt && repeatedSettlement.remainingTimeoutMs === 14_600,
  "focused reconnect-settlement policy accumulated grace across same-daemon handovers");
  const cappedSettlement = pendingCallReconnectSettlement({
    tool: "exec_command", startedAt: 0, originalDeadlineAt: 49_000, deadlineAt: 49_000,
  }, 49_500);
  assert(cappedSettlement.deadlineAt === 64_000
    && cappedSettlement.remainingTimeoutMs === 14_500,
  "focused reconnect-settlement policy lost the one-time result-delivery grace near the original settlement ceiling");
  const maximumSettlement = pendingCallReconnectSettlement({
    tool: "exec_command", startedAt: 0, originalDeadlineAt: relayContract.maximumOrdinaryRelayToolTimeoutMs,
    deadlineAt: relayContract.maximumOrdinaryRelayToolTimeoutMs,
  }, relayContract.maximumOrdinaryRelayToolTimeoutMs - 1_000);
  assert(maximumSettlement.deadlineAt === relayContract.maximumOrdinaryRelayToolTimeoutMs + relayContract.reconnectResultDeliveryGraceMs
    && maximumSettlement.remainingTimeoutMs === relayContract.reconnectResultDeliveryGraceMs + 1_000,
  "reconnect result-delivery grace was still capped by the original foreground settlement ceiling");
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
  const originalDeadlineExpiry = daemonReconnectExpiry({
    remainingTimeoutMs: 20_000, originalDeadlineAt: 25_000, deadlineAt: 25_000,
  }, relayContract.reconnectGraceMs);
  assert(originalDeadlineExpiry.reason === "original_call_deadline_expired_during_reconnect"
    && originalDeadlineExpiry.message === "original call deadline expired during reconnect",
  "disconnect diagnostics mislabeled the original foreground deadline as the longer reconnect grace");
  const deliveryGraceExpiry = daemonReconnectExpiry({
    remainingTimeoutMs: 40_000, originalDeadlineAt: 25_000, deadlineAt: 40_000,
  }, relayContract.reconnectGraceMs);
  assert(deliveryGraceExpiry.reason === "terminal_result_delivery_grace_expired"
    && deliveryGraceExpiry.message === "terminal result delivery grace expired during reconnect",
  "disconnect diagnostics did not distinguish bounded terminal-result delivery grace from the original execution envelope");
  const reconnectGraceExpiry = daemonReconnectExpiry({
    remainingTimeoutMs: relayContract.reconnectGraceMs, originalDeadlineAt: 25_000, deadlineAt: 40_000,
  }, relayContract.reconnectGraceMs);
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
  assert(workerToolSchemaGeneration === schemaMetadata.toolSchemaGeneration, "hosted current tool schema generation differs from shared metadata");
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
  const remoteReadFile = workspaceTools.find((tool) => tool.name === "read_file");
  const remoteReadFileDescription = String(remoteReadFile?.description || "");
  assert(remoteReadFile?.inputSchema?.properties?.max_bytes?.maximum === 64 * 1024
    && remoteReadFile?.inputSchema?.properties?.max_bytes?.default === 64 * 1024
    && remoteReadFileDescription.includes("complete serialized read_file result")
    && remoteReadFileDescription.includes("whole-line pagination")
    && remoteReadFileDescription.includes("next_start_line")
    && remoteReadFileDescription.includes("Local/stdio read capacity is unchanged"),
  "remote read_file schema/description omitted the hosted complete-result pagination budget");
  const remoteExec = workspaceTools.find((tool) => tool.name === "exec_command");
  const remoteExecDescription = String(remoteExec?.description || "");
  assert(remoteExecDescription.includes("one-step durable job")
    && remoteExecDescription.includes("job_id")
    && remoteExecDescription.includes("read_job")
    && remoteExecDescription.includes("30 minutes pre-spawn")
    && remoteExecDescription.includes("current_phase=resource_admission")
    && remoteExecDescription.includes("bounded same-response read_job follow-up")
    && remoteExecDescription.includes("redirect it to a file")
    && remoteExecDescription.includes("bounded read_file pages")
    && remoteExecDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time")
    && remoteExecDescription.includes(`Tool schema generation ${workerToolSchemaGeneration}.`),
  "remote exec_command description omitted the durable execution, pre-spawn admission, recovery, or bounded follow-up contract");
  const remoteStartJob = workspaceTools.find((tool) => tool.name === "start_job");
  const remoteStageJob = workspaceTools.find((tool) => tool.name === "stage_job");
  const remoteStartJobDescription = String(remoteStartJob?.description || "");
  const remoteListJobsDescription = String(workspaceTools.find((tool) => tool.name === "list_jobs")?.description || "");
  const remoteReadJob = workspaceTools.find((tool) => tool.name === "read_job");
  const remoteReadJobDescription = String(remoteReadJob?.description || "");
  const remoteCancelJob = workspaceTools.find((tool) => tool.name === "cancel_job");
  const ownerJobMonitorRender = workerToolsForRole("owner").find((tool) => tool.name === JOB_MONITOR_RENDER_TOOL);
  const ownerJobMonitorClaim = workerToolsForRole("owner").find((tool) => tool.name === JOB_MONITOR_CLAIM_TOOL);
  const ownerJobMonitorRead = workerToolsForRole("owner").find((tool) => tool.name === JOB_MONITOR_READ_TOOL);
  assert(remoteStartJob?.inputSchema?.required?.includes("idempotency_key")
    && JSON.stringify(remoteStartJob?.inputSchema?.properties?.continuation_mode?.enum) === '["task_supervisor"]'
    && remoteStartJob?.inputSchema?.properties?.dependency_recovery?.type === "object"
    && remoteStartJob?._meta?.ui?.resourceUri === undefined
    && remoteStartJob?._meta?.["ui/resourceUri"] === undefined
    && ownerJobMonitorRender?._meta?.ui?.resourceUri === JOB_MONITOR_RESOURCE_URI
    && JSON.stringify(ownerJobMonitorRender?._meta?.ui?.visibility) === '["model"]'
    && ownerJobMonitorRender?._meta?.["openai/outputTemplate"] === JOB_MONITOR_RESOURCE_URI
    && ownerJobMonitorRender?._meta?.["openai/toolInvocation/invoking"] === undefined
    && ownerJobMonitorRender?._meta?.["openai/toolInvocation/invoked"] === undefined
    && JSON.stringify(remoteReadJob?._meta?.ui?.visibility) === '["model"]'
    && remoteReadJob?._meta?.["openai/widgetAccessible"] === undefined
    && JSON.stringify(ownerJobMonitorClaim?._meta?.ui?.visibility) === '["app"]'
    && ownerJobMonitorClaim?._meta?.["openai/widgetAccessible"] === true
    && JSON.stringify(ownerJobMonitorRead?._meta?.ui?.visibility) === '["app"]'
    && ownerJobMonitorRead?._meta?.["openai/widgetAccessible"] === true
    && remoteStartJobDescription.includes("idempotency_key known before dispatch")
    && remoteStartJobDescription.includes("recovery_key and control_key")
    && remoteStartJobDescription.includes("dependency_recovery")
    && remoteStartJobDescription.includes("continuation_mode=task_supervisor")
    && remoteStartJobDescription.includes("render_job_monitor")
    && remoteStartJobDescription.includes("status_polling_mode=ui_monitor")
    && remoteStartJobDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time"),
  "remote start_job schema/description omitted idempotent acceptance, managed-job capabilities, or the UI monitor handoff");
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
  assert(readJobRecovery?.credential === "job_id+recovery_key"
    && readJobRecovery?.action === "retry_read_job_with_same_job_id_and_recovery_key"
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
  assert(remoteListJobsDescription.includes("aggregate retained/capacity/activity state only")
    && remoteListJobsDescription.includes("deliberately omits job handles")
    && remoteListJobsDescription.includes("recovery_key")
    && remoteListJobsDescription.includes("do not repeat list_jobs"),
  "remote list_jobs description no longer enforces aggregate-only hosted recovery inventory");
  assert(remoteReadJob?.inputSchema?.properties?.wait_ms?.default === 40_000
    && remoteReadJob?.inputSchema?.properties?.wait_ms?.maximum === 60_000
    && remoteReadJob?.inputSchema?.required?.includes("recovery_key")
    && remoteReadJob?.inputSchema?.properties?.recovery_key?.pattern === "^mcp_jr_[A-Za-z0-9_-]{43}$"
    && remoteReadJob?.inputSchema?.properties?.ui_monitor_id?.pattern === "^mcp_jm_[a-f0-9]{32}$"
    && remoteReadJobDescription.includes("server-side long-poll")
    && remoteReadJobDescription.includes("wait up to 40 seconds")
    && remoteReadJobDescription.includes("public wait_ms maximum of 60 seconds")
    && remoteReadJobDescription.includes("job_id alone is not remote read authority")
    && remoteReadJobDescription.includes("same assistant response")
    && remoteReadJobDescription.includes("do not busy-loop")
    && remoteReadJobDescription.includes("Do not infer or preempt a host/tool deadline from elapsed wall-clock time"),
  "remote read_job schema/description lost capability-bound paced same-turn follow-up");
  assert(remoteCancelJob?.inputSchema?.required?.includes("control_key")
    && remoteCancelJob?.inputSchema?.properties?.control_key?.pattern === "^mcp_jc_[A-Za-z0-9_-]{43}$"
    && String(remoteCancelJob?.description || "").includes("job_id or recovery_key alone is not cancellation authority"),
  "remote cancel_job schema/description lost control-capability enforcement");
  const capabilityAuthority = {
    tokenKey: "synthetic-token", accountId: "synthetic-account", accountVersion: 4,
    clientId: "synthetic-client", familyId: "synthetic-family", dpopJkt: "", role: "owner",
  };
  const otherCapabilityAuthority = { ...capabilityAuthority, familyId: "other-family" };
  const capabilityKeyMaterial = "synthetic-worker-identity-key";
  const capabilityJobId = `job_${"q".repeat(24)}`;
  const recoveryKey = await issueManagedJobCapability(capabilityKeyMaterial, capabilityAuthority, capabilityJobId, "read");
  const controlKey = await issueManagedJobCapability(capabilityKeyMaterial, capabilityAuthority, capabilityJobId, "control");
  assert(await verifyManagedJobCapability(capabilityKeyMaterial, capabilityAuthority, capabilityJobId, "read", recoveryKey)
    && await verifyManagedJobCapability(capabilityKeyMaterial, capabilityAuthority, capabilityJobId, "control", controlKey)
    && !await verifyManagedJobCapability(capabilityKeyMaterial, capabilityAuthority, capabilityJobId, "control", recoveryKey)
    && !await verifyManagedJobCapability(capabilityKeyMaterial, otherCapabilityAuthority, capabilityJobId, "read", recoveryKey),
  "managed-job capabilities lost purpose/principal binding");
  const claimStorage = testDurableStorage();
  const claimStore = new ManagedJobMonitorClaimStore(claimStorage);
  const uiClientCapabilities = { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };
  const activeWithUi = await projectHostedManagedJobResult("start_job", {
    accepted: true, job_id: capabilityJobId, status: "running", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, { clientCapabilities: uiClientCapabilities, uiMonitorStore: claimStore });
  const monitorId = activeWithUi.ui_monitor_id;
  assert(/^mcp_jm_[a-f0-9]{32}$/.test(String(monitorId))
    && activeWithUi.ui_monitor_candidate === true && activeWithUi.ui_monitor_claim_required === true,
  "active MCP Apps start_job did not pre-issue a bounded monitor correlation ID");
  const brokenStorage = {
    async get() { throw new Error("synthetic monitor storage failure"); },
    async put() { throw new Error("synthetic monitor storage failure"); },
    async delete() { throw new Error("synthetic monitor storage failure"); },
    async transaction() { throw new Error("synthetic monitor storage failure"); },
  };
  const brokenClaimStore = new ManagedJobMonitorClaimStore(brokenStorage);
  const coordinationFailures = [];
  const activeWithBrokenUi = await projectHostedManagedJobResult("start_job", {
    accepted: true, job_id: capabilityJobId, status: "running", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, {
    clientCapabilities: uiClientCapabilities, uiMonitorStore: brokenClaimStore,
    onMonitorCoordinationFailure: (operation) => coordinationFailures.push(operation),
  });
  assert(activeWithBrokenUi.accepted === true && activeWithBrokenUi.follow_up_read_required === true
    && activeWithBrokenUi.ui_monitor_candidate === undefined && coordinationFailures.join(",") === "issue",
  "optional monitor issuance failure obscured an already accepted durable job");
  assert(await hasManagedJobMonitorClaimIfAvailable(
    brokenClaimStore, capabilityJobId, monitorId, capabilityAuthority, (operation) => coordinationFailures.push(operation),
  ) === false && await cancelManagedJobMonitorClaimsIfAvailable(
    brokenClaimStore, { accountId: capabilityAuthority.accountId, accountVersion: capabilityAuthority.accountVersion },
    (operation) => coordinationFailures.push(operation),
  ) === 0 && coordinationFailures.slice(-2).join(",") === "claim_probe,revocation_cleanup",
  "monitor coordination failure did not degrade to no-handoff/no-cleanup without changing core authority semantics");
  assert(await issueManagedJobMonitorIfAvailable(
    brokenClaimStore, capabilityJobId, capabilityAuthority, () => { throw new Error("observer failure"); },
  ) === null, "monitor failure observer was allowed to become durable-job result authority");
  let preRenderClaimError;
  try {
    await claimManagedJobMonitor(claimStore, {
      job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
    }, capabilityAuthority, capabilityKeyMaterial);
  } catch (error) { preRenderClaimError = error; }
  assert(preRenderClaimError instanceof WorkerToolError && preRenderClaimError.code === "invalid_request"
    && !await hasManagedJobMonitorClaim(claimStore, capabilityJobId, monitorId, capabilityAuthority),
  "pre-issued managed-job monitor ID became claimable before render activation");
  const renderResult = await renderManagedJobMonitor(claimStore, {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
  },
    capabilityAuthority, capabilityKeyMaterial);
  assert(renderResult.job_id === capabilityJobId && renderResult.ui_monitor_id === monitorId
    && renderResult.ui_monitor_claim_required === true && renderResult.follow_up_read_required === true
    && renderResult.$mcpText === ""
    && jobMonitorRenderTool.name === JOB_MONITOR_RENDER_TOOL
    && jobMonitorRenderTool.inputSchema?.required?.includes("ui_monitor_id")
    && jobMonitorRenderTool.inputSchema?.properties?.ui_monitor_id?.pattern === "^mcp_jm_[a-f0-9]{32}$"
    && jobMonitorReadTool.name === JOB_MONITOR_READ_TOOL
    && jobMonitorClaimTool.name === JOB_MONITOR_CLAIM_TOOL,
  "managed-job render tool did not activate the exact monitor ID without adding host status prose");
  const reloadedClaimStore = new ManagedJobMonitorClaimStore(claimStorage);
  let preClaimMonitorReadError;
  try {
    await managedJobMonitorReadDaemonArguments(reloadedClaimStore, {
      job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
    }, capabilityAuthority, capabilityKeyMaterial);
  } catch (error) { preClaimMonitorReadError = error; }
  assert(preClaimMonitorReadError instanceof WorkerToolError && preClaimMonitorReadError.code === "invalid_request",
    "app-only monitor read became available before the View claimed continuation");
  const initialClaimResult = await claimManagedJobMonitor(reloadedClaimStore, {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(initialClaimResult.claimed === true,
    "rendered managed-job monitor claim did not survive Worker isolate/store reconstruction");
  const monitorReadArgs = await managedJobMonitorReadDaemonArguments(claimStore, {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(monitorReadArgs.job_id === capabilityJobId && monitorReadArgs.wait_ms === 40_000
    && !("recovery_key" in monitorReadArgs) && !("ui_monitor_id" in monitorReadArgs),
  "app-only monitor status read did not reduce to one fixed capability-checked daemon read_job request");
  let wrongMonitorReadAuthority;
  try {
    await managedJobMonitorReadDaemonArguments(claimStore, {
      job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
    }, otherCapabilityAuthority, capabilityKeyMaterial);
  } catch (error) { wrongMonitorReadAuthority = error; }
  assert(wrongMonitorReadAuthority instanceof WorkerToolError && wrongMonitorReadAuthority.code === "authorization_denied",
    "app-only monitor status read accepted the wrong principal recovery capability");
  const projectedMonitorStatus = projectManagedJobMonitorStatus({
    job_id: capabilityJobId, status: "failed", current_phase: "recovery-cleanup", current_step: 2,
    dependency_total: 3, dependency_pending_count: 1, finished_at: "2026-09-02T14:00:00.000Z",
    error_class: "execution_failed", recovery_key: "monitor-secret-recovery", control_key: "monitor-secret-control",
    private_path: "/private/monitor-secret-path", result: { steps: [{
      stdout: "monitor-secret-output", stderr: "monitor-secret-error", command: "monitor-secret-command",
    }] },
  }, capabilityJobId);
  const projectedMonitorStatusText = JSON.stringify(projectedMonitorStatus);
  assert(projectedMonitorStatus.job_id === capabilityJobId && projectedMonitorStatus.status === "failed"
    && projectedMonitorStatus.current_phase === "recovery-cleanup" && projectedMonitorStatus.current_step === 2
    && projectedMonitorStatus.dependency_total === 3 && projectedMonitorStatus.dependency_pending_count === 1
    && projectedMonitorStatus.finished_at === "2026-09-02T14:00:00.000Z"
    && projectedMonitorStatus.error_class === "execution_failed"
    && !projectedMonitorStatusText.includes("monitor-secret") && !("result" in projectedMonitorStatus)
    && !("recovery_key" in projectedMonitorStatus) && !("control_key" in projectedMonitorStatus)
    && !("private_path" in projectedMonitorStatus),
  "app-only monitor status projection retained job output, command, path, or capability material");
  let mismatchedMonitorStatusError;
  try { projectManagedJobMonitorStatus({ job_id: `job_${"z".repeat(24)}`, status: "running" }, capabilityJobId); }
  catch (error) { mismatchedMonitorStatusError = error; }
  assert(mismatchedMonitorStatusError instanceof WorkerToolError
    && mismatchedMonitorStatusError.code === "execution_failed" && mismatchedMonitorStatusError.retryable === true,
  "app-only monitor status accepted a mismatched job identity");
  const projectedReadArgs = await hostedManagedJobDaemonArguments("read_job", {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId, wait_ms: 0,
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(projectedReadArgs.job_id === capabilityJobId && projectedReadArgs.wait_ms === 0
    && !("recovery_key" in projectedReadArgs) && !("ui_monitor_id" in projectedReadArgs),
    "hosted read_job forwarded Worker-only recovery/monitor coordination material to the daemon");
  const projectedDependencyArgs = await hostedManagedJobDaemonArguments("start_job", {
    idempotency_key: "capability-dependency", continuation_mode: "task_supervisor", depends_on: [capabilityJobId],
    dependency_recovery: { [capabilityJobId]: recoveryKey }, steps: [{ argv: ["true"] }],
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(Array.isArray(projectedDependencyArgs.depends_on) && projectedDependencyArgs.continuation_mode === "task_supervisor" && !("dependency_recovery" in projectedDependencyArgs),
    "hosted dependency authorization material crossed the Worker/daemon boundary");
  let coercedDependencyError;
  try {
    await hostedManagedJobDaemonArguments("start_job", {
      depends_on: [[capabilityJobId]], dependency_recovery: { [capabilityJobId]: recoveryKey }, steps: [{ argv: ["true"] }],
    }, capabilityAuthority, capabilityKeyMaterial);
  } catch (error) { coercedDependencyError = error; }
  assert(coercedDependencyError instanceof WorkerToolError && coercedDependencyError.code === "invalid_request"
    && coercedDependencyError.details?.side_effects_started === false,
  "hosted dependency authority coerced a non-string dependency id before daemon dispatch");
  let wrongCapabilityError;
  try {
    await hostedManagedJobDaemonArguments("read_job", {
      job_id: capabilityJobId, recovery_key: recoveryKey,
    }, otherCapabilityAuthority, capabilityKeyMaterial);
  } catch (error) { wrongCapabilityError = error; }
  assert(wrongCapabilityError instanceof WorkerToolError && wrongCapabilityError.code === "authorization_denied"
    && wrongCapabilityError.details?.side_effects_started === false,
  "wrong-principal hosted job recovery did not fail before daemon dispatch");
  const acceptedWithCapabilities = await projectHostedManagedJobResult("start_job", {
    accepted: true, job_id: capabilityJobId,
    recovery: { tool: "read_job", job_id: capabilityJobId, fallback_tool: "list_jobs" },
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(acceptedWithCapabilities.recovery_key === recoveryKey && acceptedWithCapabilities.control_key === controlKey
    && acceptedWithCapabilities.recovery?.recovery_key === recoveryKey
    && acceptedWithCapabilities.recovery?.control_key === controlKey
    && !("fallback_tool" in acceptedWithCapabilities.recovery),
  "hosted managed-job acceptance did not return deterministic recovery/control capabilities or retained an unusable aggregate-only fallback");
  const activeWithoutUi = await projectHostedManagedJobResult("start_job", {
    accepted: true, job_id: capabilityJobId, status: "running", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, { clientCapabilities: {} });
  assert(activeWithoutUi.follow_up_read_required === true && activeWithoutUi.status_polling_mode !== "ui_monitor"
    && activeWithUi.follow_up_read_required === true && activeWithUi.ui_monitor_candidate === true
    && activeWithUi.ui_monitor_id === monitorId
    && activeWithUi.ui_monitor_claim_required === true && activeWithUi.status_polling_mode !== "ui_monitor"
    && activeWithUi.host_turn_handoff_recommended === false
    && activeWithUi.completion_delivery === "mcp_app_job_monitor_pending_claim"
    && activeWithUi.ui_monitor_render_tool === JOB_MONITOR_RENDER_TOOL
    && activeWithUi.ui_resource_uri === undefined,
  "MCP Apps capability alone incorrectly transferred active start_job continuation before the monitor proved server-tool access");
  const activeClaimed = await projectHostedManagedJobResult("read_job", {
    job_id: capabilityJobId, status: "running", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, { uiMonitorClaimed: true });
  assert(activeClaimed.follow_up_read_required === false && activeClaimed.ui_follow_up_read_required === true
    && activeClaimed.ui_monitor_claimed === true && activeClaimed.status_polling_mode === "ui_monitor"
    && activeClaimed.host_turn_handoff_recommended === false && activeClaimed.same_response_followup_supported === false
    && activeClaimed.completion_delivery === "mcp_app_job_monitor",
  "a proven Job Monitor claim incorrectly recommended transferring the whole assistant turn instead of only job polling");
  const supervisorWithoutClaim = await projectHostedManagedJobResult("read_job", {
    job_id: capabilityJobId, status: "running", continuation_mode: "task_supervisor", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, { uiMonitorClaimed: false });
  assert(supervisorWithoutClaim.follow_up_read_required === true
    && supervisorWithoutClaim.host_turn_handoff_recommended === false
    && supervisorWithoutClaim.status_polling_mode !== "ui_monitor",
  "unclaimed task supervisor incorrectly recommended host-turn handoff");
  const activeSupervisorClaimed = await projectHostedManagedJobResult("read_job", {
    job_id: capabilityJobId, status: "running", continuation_mode: "task_supervisor", follow_up_read_required: true,
    host_turn_handoff_recommended: false, same_response_followup_supported: true,
  }, capabilityAuthority, capabilityKeyMaterial, { uiMonitorClaimed: true });
  assert(activeSupervisorClaimed.continuation_mode === "task_supervisor"
    && activeSupervisorClaimed.follow_up_read_required === false && activeSupervisorClaimed.ui_follow_up_read_required === true
    && activeSupervisorClaimed.ui_monitor_claimed === true && activeSupervisorClaimed.status_polling_mode === "ui_monitor"
    && activeSupervisorClaimed.host_turn_handoff_recommended === true && activeSupervisorClaimed.same_response_followup_supported === false,
  "claimed active task supervisor did not transfer host-turn continuation to its durable supervisor lifecycle");
  const terminalSupervisorClaimed = await projectHostedManagedJobResult("read_job", {
    job_id: capabilityJobId, status: "succeeded", continuation_mode: "task_supervisor", follow_up_read_required: false,
    host_turn_handoff_recommended: false, same_response_followup_supported: false,
  }, capabilityAuthority, capabilityKeyMaterial, { uiMonitorClaimed: true });
  assert(terminalSupervisorClaimed.host_turn_handoff_recommended === false
    && terminalSupervisorClaimed.status_polling_mode !== "ui_monitor",
  "terminal task supervisor incorrectly emitted a new host-turn handoff recommendation");
  const terminalWithUi = await projectHostedManagedJobResult("start_job", {
    accepted: true, job_id: capabilityJobId, status: "succeeded", follow_up_read_required: false,
  }, capabilityAuthority, capabilityKeyMaterial, { clientCapabilities: uiClientCapabilities, uiMonitorClaimed: true });
  assert(terminalWithUi.follow_up_read_required === false && terminalWithUi.status_polling_mode !== "ui_monitor",
    "already-terminal start_job was incorrectly converted into UI-owned continuation");
  const otherClaimStore = new ManagedJobMonitorClaimStore(testDurableStorage());
  const forgedMonitorId = `mcp_jm_${String(monitorId).endsWith("0") ? "1" : "0"}${"0".repeat(31)}`;
  let unissuedClaimError;
  try {
    await claimManagedJobMonitor(claimStore, {
      job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: forgedMonitorId,
    }, capabilityAuthority, capabilityKeyMaterial);
  } catch (error) { unissuedClaimError = error; }
  assert(unissuedClaimError instanceof WorkerToolError && unissuedClaimError.code === "invalid_request"
    && !await hasManagedJobMonitorClaim(claimStore, capabilityJobId, forgedMonitorId, capabilityAuthority),
  "managed-job monitor accepted an unissued render-instance ID");
  const claimResult = await claimManagedJobMonitor(claimStore, {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
  }, capabilityAuthority, capabilityKeyMaterial);
  const replayedClaimResult = await claimManagedJobMonitor(claimStore, {
    job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(initialClaimResult.claimed === true && claimResult.claimed === true && replayedClaimResult.claimed === true
    && await hasManagedJobMonitorClaim(claimStore, capabilityJobId, monitorId, capabilityAuthority)
    && !await hasManagedJobMonitorClaim(claimStore, capabilityJobId, `mcp_jm_${"0".repeat(32)}`, capabilityAuthority)
    && !await hasManagedJobMonitorClaim(claimStore, capabilityJobId, monitorId, otherCapabilityAuthority)
    && !await hasManagedJobMonitorClaim(otherClaimStore, capabilityJobId, monitorId, capabilityAuthority),
  "managed-job monitor claim lost replay safety, render-instance, principal, or Worker-room scope binding");
  let invalidClaimError;
  try {
    await claimManagedJobMonitor(claimStore, {
      job_id: capabilityJobId, recovery_key: recoveryKey, ui_monitor_id: monitorId,
    }, otherCapabilityAuthority, capabilityKeyMaterial);
  } catch (error) { invalidClaimError = error; }
  assert(invalidClaimError instanceof WorkerToolError && invalidClaimError.code === "authorization_denied",
    "managed-job monitor accepted a claim with the wrong principal");
  const boundedClaims = new ManagedJobMonitorClaimStore(testDurableStorage());
  const boundedMonitorId = await boundedClaims.issue(capabilityJobId, capabilityAuthority, 1000);
  assert(!await boundedClaims.claim(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001),
    "freshly issued monitor ID became claimable without render activation");
  assert(await boundedClaims.activate(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001),
    "issued monitor ID could not be activated by the render phase");
  assert(!await boundedClaims.activate(capabilityJobId, boundedMonitorId, capabilityAuthority, 1002),
    "one monitor ID was reusable across multiple render instances");
  await boundedClaims.claim(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001);
  assert(await boundedClaims.has(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001)
    && !await boundedClaims.has(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001 + 5 * 60 * 1000),
  "managed-job monitor handoff proof did not expire at its bounded lifetime");
  assert(await boundedClaims.refresh(capabilityJobId, boundedMonitorId, capabilityAuthority, 1001 + 5 * 60 * 1000)
    && await boundedClaims.has(capabilityJobId, boundedMonitorId, capabilityAuthority, 1002 + 5 * 60 * 1000),
  "still-latest claimed monitor could not resume app continuation after handoff freshness expired");
  const leasedClaims = new ManagedJobMonitorClaimStore(testDurableStorage());
  const leasedMonitorId = await leasedClaims.issue(capabilityJobId, capabilityAuthority, 2000);
  assert(await leasedClaims.activate(capabilityJobId, leasedMonitorId, capabilityAuthority, 2001)
    && await leasedClaims.claim(capabilityJobId, leasedMonitorId, capabilityAuthority, 2001)
    && await leasedClaims.refresh(capabilityJobId, leasedMonitorId, capabilityAuthority, 2001 + 4 * 60 * 1000)
    && await leasedClaims.has(capabilityJobId, leasedMonitorId, capabilityAuthority, 2001 + 6 * 60 * 1000),
  "active app-only monitor reads did not refresh the claimed monitor lease");
  const replacementMonitorId = await leasedClaims.issue(capabilityJobId, capabilityAuthority, 2001 + 6 * 60 * 1000);
  assert(replacementMonitorId !== leasedMonitorId
    && !await leasedClaims.has(capabilityJobId, leasedMonitorId, capabilityAuthority, 2001 + 6 * 60 * 1000),
  "new monitor issuance did not revoke the older View for the same job/principal");
  const corruptValues = new Map();
  const corruptStorage = {
    async get(key) { const value = corruptValues.get(key); return value === undefined ? undefined : structuredClone(value); },
    async put(key, value) { corruptValues.set(key, structuredClone(value)); },
    async delete(key) { return corruptValues.delete(key); },
    async transaction(callback) { return callback(corruptStorage); },
  };
  const corruptClaims = new ManagedJobMonitorClaimStore(corruptStorage);
  const corruptMonitorId = await corruptClaims.issue(capabilityJobId, capabilityAuthority, 3000);
  const corruptState = structuredClone(corruptValues.get("managed-job-monitor-claims-v1"));
  corruptState.claims.push({ ...corruptState.claims[0] });
  corruptValues.set("managed-job-monitor-claims-v1", corruptState);
  let corruptMonitorStateError;
  try { await corruptClaims.has(capabilityJobId, corruptMonitorId, capabilityAuthority, 3001); }
  catch (error) { corruptMonitorStateError = error; }
  assert(corruptMonitorStateError instanceof Error
    && /managed-job monitor durable state is invalid/.test(corruptMonitorStateError.message),
  "duplicate monitor/sequence durable state was accepted instead of failing closed");
  assert(supportsManagedJobMonitor(uiClientCapabilities)
    && !supportsManagedJobMonitor({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ["text/plain"] } } })
    && !supportsManagedJobMonitor({}),
  "MCP Apps support detection did not require the negotiated extension MIME type");
  const monitorList = managedJobMonitorResources({ name: "machine-bridge-mcp", version: "test" });
  const monitorRead = managedJobMonitorResource(JOB_MONITOR_RESOURCE_URI, { name: "machine-bridge-mcp", version: "test" });
  const monitorHtml = monitorRead.contents?.[0]?.text || "";
  assert(monitorList.resultType === "complete" && monitorList.ttlMs === 0 && monitorList.cacheScope === "public"
    && monitorList.resources?.[0]?.uri === JOB_MONITOR_RESOURCE_URI
    && monitorList.resources?.[0]?.mimeType === MCP_APP_MIME_TYPE
    && monitorRead.contents?.[0]?.mimeType === MCP_APP_MIME_TYPE
    && monitorRead.contents?.[0]?._meta?.ui?.csp?.connectDomains?.length === 0
    && monitorRead.contents?.[0]?._meta?.["openai/widgetCSP"]?.connect_domains?.length === 0
    && monitorRead.contents?.[0]?._meta?.["openai/widgetPrefersBorder"] === true
    && monitorHtml.includes('name:"read_job_monitor"') && !monitorHtml.includes('name:"read_job"')
    && monitorHtml.includes("inputBound") && monitorHtml.includes("displayStatus") && monitorHtml.includes("clearPending")
    && !monitorHtml.includes("cleanForDisplay") && !monitorHtml.includes("Monitor initialization failed:")
    && !monitorHtml.includes("String(error?.message") && !monitorHtml.includes('method==="ui/notifications/tool-result"')
    && monitorHtml.includes("retryDelays=[1000,2000,4000,8000,15000,30000]")
    && monitorHtml.includes("claimRetryDelays=[1000,2000,4000,8000,15000]")
    && monitorHtml.includes("readResponseTimeoutMs=60000")
    && monitorHtml.includes("claimResponseTimeoutMs=30000")
    && monitorHtml.includes("host tool response timeout")
    && monitorHtml.includes("retryAttempt>=retryDelays.length")
    && monitorHtml.includes("claimRetryAttempt>=claimRetryDelays.length")
    && monitorHtml.includes("scheduleClaimRetry")
    && monitorHtml.includes('if(error?.retryable===true){scheduleClaimRetry();return;}')
    && monitorHtml.includes("error?.retryable===true") && monitorHtml.includes("scheduleReadRetry")
    && monitorHtml.includes(`name:"${JOB_MONITOR_CLAIM_TOOL}"`)
    && monitorHtml.includes("ui_monitor_id:monitorId")
    && monitorHtml.includes('typeof input.ui_monitor_id!=="string"')
    && monitorHtml.includes('method==="ui/notifications/tool-input"')
    && monitorHtml.includes("hostCapabilities?.serverTools")
    && monitorHtml.includes('request("ui/initialize"')
    && monitorHtml.includes('method:"ui/notifications/initialized"')
    && monitorHtml.includes('method==="ui/resource-teardown"')
    && monitorHtml.includes('clearPending();recoveryKey="";jobId="";monitorId="";inputBound=false')
    && monitorHtml.includes('protocolVersion:"2026-01-26"')
    && !/https?:\/\//.test(monitorHtml) && !monitorHtml.includes("sendFollowUpMessage"),
  "managed-job monitor resource lost MCP Apps handshake, static/no-network, or server-paced continuation boundaries");
  const aggregateInventory = await projectHostedManagedJobResult("list_jobs", {
    jobs: [{ job_id: capabilityJobId, name: "must-not-cross-hosted-boundary", status: "running" }],
    recent_process_recovery: [{ job_id: capabilityJobId }], retained: 1, maximum: 512,
    capacity: { retained_state: 1 }, recent_activity: { created_recently: 1 },
  }, capabilityAuthority, capabilityKeyMaterial);
  assert(Array.isArray(aggregateInventory.jobs) && aggregateInventory.jobs.length === 0
    && Array.isArray(aggregateInventory.recent_process_recovery) && aggregateInventory.recent_process_recovery.length === 0
    && aggregateInventory.hosted_inventory_scope === "aggregate_only"
    && !JSON.stringify(aggregateInventory).includes(capabilityJobId)
    && !JSON.stringify(aggregateInventory).includes("must-not-cross-hosted-boundary"),
  "hosted list_jobs still exposed globally discoverable durable job handles or names");
  const validReadCapabilityShape = validateWorkerToolArguments("read_job", { job_id: capabilityJobId, recovery_key: recoveryKey, wait_ms: 0 });
  const missingReadCapabilityShape = validateWorkerToolArguments("read_job", { job_id: capabilityJobId, wait_ms: 0 });
  const validCancelCapabilityShape = validateWorkerToolArguments("cancel_job", { job_id: capabilityJobId, control_key: controlKey });
  const dependencyWithoutCapability = validateWorkerToolArguments("start_job", {
    idempotency_key: "dependency-without-capability", depends_on: [capabilityJobId], steps: [{ argv: ["true"] }],
  });
  assert(validReadCapabilityShape.valid && !missingReadCapabilityShape.valid && validCancelCapabilityShape.valid
    && !dependencyWithoutCapability.valid,
  "actual Worker validator did not enforce hosted managed-job capabilities/dependency recovery");
  assert(!workerToolParameterHeaders.has("mcp-param-recovery-key")
    && !workerToolParameterHeaders.has("mcp-param-control-key")
    && !workerToolParameterHeaders.has("mcp-param-dependency-recovery"),
  "managed-job bearer capabilities leaked into mirrored HTTP routing headers");
  assert(!validateWorkerToolArguments("browser_inspect_page", {}).valid
    && validateWorkerToolArguments("browser_inspect_page", { tab_id: 1 }).valid
    && !validateWorkerToolArguments("computer_observe", { surface: "browser" }).valid
    && validateWorkerToolArguments("computer_observe", { surface: "browser", tab_id: 1 }).valid
    && validateWorkerToolArguments("computer_observe", { surface: "application", application: "synthetic" }).valid,
  "hosted browser schemas still allowed implicit active-tab targeting or over-required tab_id for applications");
  const immediateJobReadBudget = daemonToolTimeoutBudget("read_job", { wait_ms: 0 });
  const defaultJobReadBudget = daemonToolTimeoutBudget("read_job", {});
  const maximumJobReadBudget = daemonToolTimeoutBudget("read_job", { wait_ms: 60_000 });
  assert(immediateJobReadBudget.executionTimeoutMs === 10_000 && immediateJobReadBudget.settlementTimeoutMs === 15_000
    && defaultJobReadBudget.executionTimeoutMs === 50_000 && defaultJobReadBudget.settlementTimeoutMs === 55_000
    && maximumJobReadBudget.executionTimeoutMs === 70_000 && maximumJobReadBudget.settlementTimeoutMs === 75_000,
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
  const lowHeadroomReadRedelivery = daemonToolRedeliveryArguments("read_job", { wait_ms: 20_000 }, 9_999);
  const minimumReadRedelivery = daemonToolRedeliveryArguments("read_job", { wait_ms: 20_000 }, 1_000);
  const exactHeadroomReadArgs = { wait_ms: 0 };
  assert(lowHeadroomReadRedelivery?.wait_ms === 0
    && minimumReadRedelivery?.wait_ms === 0
    && daemonToolRedeliveryArguments("read_job", exactHeadroomReadArgs, 10_000) === exactHeadroomReadArgs
    && daemonToolRedeliveryArguments("read_job", { wait_ms: 0 }, 999) === null
    && daemonToolRedeliveryArguments("read_job", { wait_ms: 0 }, Number.NaN) === null
    && daemonToolRedeliveryArguments("read_job", { wait_ms: 0 }, Number.POSITIVE_INFINITY) === null
    && daemonToolRedeliveryArguments("read_job", { wait_ms: 0 }, 1_000.5) === null,
  "daemon-proven read_job non-delivery did not degrade a sub-headroom recovery window to one immediate checkpoint");
  const ordinaryRedeliveryArgs = { path: "." };
  assert(daemonToolRedeliveryArguments("list_dir", ordinaryRedeliveryArgs, 9_999) === ordinaryRedeliveryArgs
    && daemonToolRedeliveryArguments("list_dir", ordinaryRedeliveryArgs, 999) === null,
    "ordinary daemon redelivery was rewritten while sufficient protocol execution time remained");
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
    && remoteReadProcess?.inputSchema?.properties?.wait_ms?.default === 1_000
    && remoteReadProcess?.inputSchema?.properties?.max_bytes?.maximum === 32 * 1024
    && remoteReadProcess?.inputSchema?.properties?.max_bytes?.default === 32 * 1024,
    "remote read_process schema lost its one-second pacing or 32 KiB hosted result ceiling");
  assert(remoteReadProcessDescription.includes("paced follow-up")
    && remoteReadProcessDescription.includes("same MCP call")
    && remoteReadProcessDescription.includes("cooldown boundary")
    && remoteReadProcessDescription.includes("same assistant response")
    && remoteReadProcessDescription.includes("next_blocking_poll_after_ms")
    && remoteReadProcessDescription.includes("must not busy-loop")
    && remoteReadProcessDescription.includes("run_process/read_job")
    && remoteReadProcessDescription.includes("32768 bytes per read")
    && remoteReadProcessDescription.includes("local/stdio read capacity is unchanged")
    && !remoteReadProcessDescription.includes("poll again"),
  "remote read_process description lost server-paced same-response follow-up limits");
  const staleReadFileMaximum = staleSchemaGuidanceResult(
    { jsonrpc: "2.0", id: "stale-read-file-max", method: "tools/call", params: { name: "read_file", arguments: { path: "fixture.txt", max_bytes: 1024 * 1024 } } },
    [{ instancePath: "/max_bytes", keyword: "maximum", message: "must be <= 65536" }], {},
  );
  const staleReadProcessMaximum = staleSchemaGuidanceResult(
    { jsonrpc: "2.0", id: "stale-read-process-max", method: "tools/call", params: { name: "read_process", arguments: { session_id: "proc_fixture", max_bytes: 256 * 1024 } } },
    [{ instancePath: "/max_bytes", keyword: "maximum", message: "must be <= 32768" }], {},
  );
  assert(JSON.stringify(staleReadFileMaximum).includes("cached read_file max_bytes")
    && JSON.stringify(staleReadFileMaximum).includes("schema_refresh_recommended")
    && JSON.stringify(staleReadProcessMaximum).includes("cached read_process max_bytes")
    && JSON.stringify(staleReadProcessMaximum).includes("schema_refresh_recommended"),
  "stale max_bytes schemas did not return bounded refresh guidance");
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
    && deliveryContract.remote_managed_job_read_wait_max_ms === 60_000
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
    role: "daemon", connectedAt: "2026-08-25T12:59:59.000Z",
  }, Date.parse("2026-08-25T13:00:01.000Z")), "planned socket-close evidence was not persisted");
  assert(await recordWorkerSocketDisconnect(storage, {
    planned: false, kind: "error", role: "probing", connectedAt: "2026-08-25T13:00:01.500Z",
  }, Date.parse("2026-08-25T13:00:02.000Z")), "unplanned socket-error evidence was not persisted");
  assert(await recordWorkerClientCancellation(storage, "request_abort", Date.parse("2026-08-25T13:00:03.000Z"))
    && await recordWorkerClientCancellation(storage, "stream_cancel_control", Date.parse("2026-08-25T13:00:04.000Z")),
  "client-cancellation continuity evidence was not persisted");
  const snapshot = await readWorkerContinuityEvidence(storage);
  assert(snapshot.schema_version === 2
    && snapshot.planned_drains === 1 && snapshot.planned_drain_calls === 3
    && snapshot.socket_disconnects === 2 && snapshot.unplanned_socket_disconnects === 1
    && snapshot.ready_socket_disconnects === 1 && snapshot.unplanned_ready_socket_disconnects === 0
    && snapshot.last_socket_disconnect?.kind === "error" && snapshot.last_socket_disconnect?.planned === false
    && snapshot.last_socket_disconnect?.role === "probing" && snapshot.last_socket_disconnect?.was_ready === false
    && snapshot.last_socket_disconnect?.connected_at === "2026-08-25T13:00:01.500Z"
    && snapshot.last_ready_socket_disconnect?.kind === "close" && snapshot.last_ready_socket_disconnect?.was_ready === true
    && snapshot.last_request_abort_at === "2026-08-25T13:00:03.000Z"
    && snapshot.last_stream_cancel_control_at === "2026-08-25T13:00:04.000Z",
  "durable continuity evidence lost fixed-category incident history across reads");
  values.set("worker-continuity-evidence", {
    schema_version: 1, planned_drains: 7, planned_drain_calls: 9, last_planned_drain_at: "2026-08-28T14:20:00.000Z",
    socket_disconnects: 158, unplanned_socket_disconnects: 109,
    last_socket_disconnect: { at: "2026-08-28T14:21:56.296Z", planned: false, kind: "close", close_code: 1006, was_clean: false },
    last_request_abort_at: "2026-08-28T14:22:00.000Z",
  });
  const retired = await readWorkerContinuityEvidence(storage);
  assert(retired.schema_version === 2 && retired.planned_drains === 0 && retired.planned_drain_calls === 0
    && retired.last_planned_drain_at === null && retired.last_request_abort_at === null
    && retired.socket_disconnects === 0 && retired.unplanned_socket_disconnects === 0
    && retired.ready_socket_disconnects === 0 && retired.unplanned_ready_socket_disconnects === 0
    && retired.last_socket_disconnect === null && retired.last_ready_socket_disconnect === null,
  "retired continuity schema was still interpreted by the current runtime");
  values.set("worker-continuity-evidence", {
    schema_version: 99, planned_drains: 7, last_socket_disconnect: { at: "private", kind: "other" },
  });
  const sanitized = await readWorkerContinuityEvidence(storage);
  assert(sanitized.schema_version === 2 && sanitized.planned_drains === 0 && sanitized.last_socket_disconnect === null,
    "durable continuity evidence trusted malformed stored state instead of failing closed to bounded defaults");
}

export async function runPendingCallsScenarios() {
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
  await testWorkerTaskLifetime();
  await testRelayTimeoutContract();
  await testWorkerContinuityEvidence();
}
