import nodeAssert from "node:assert/strict";
import { handleOuterWorkerFetch } from "../../../src/worker/worker-entry.ts";
import { DaemonHttpChannel } from "../../../src/worker/daemon-http-channel.ts";
import { normalizeDaemonHttpExchange } from "../../../src/worker/daemon-http-protocol.ts";
import { queueDaemonHttpRevocations } from "../../../src/worker/authority-revocations.ts";
import { PendingCallRegistry } from "../../../src/worker/pending-calls.ts";
import { pendingCallReconnectSettlement } from "../../../src/worker/pending-call-reconnect-settlement.ts";
import {
  MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT,
  pendingCapacityProjection,
} from "../../../src/worker/pending-call-capacity.ts";
import { DaemonSocketRegistry } from "../../../src/worker/daemon-sockets.ts";
import { DaemonRegistry } from "../../../src/worker/daemon-registry.ts";
import { settleDaemonProvenMissingCalls } from "../../../src/worker/daemon-ready-messages.ts";
import { cancelReadyDaemonAuthority, notifyReadyDaemon, readyDaemonWaiterSnapshot, waitForReadyDaemon } from "../../../src/worker/daemon-ready-waiters.ts";
import { immediateReadyDaemonForDispatch, readyDaemonForDispatch } from "../../../src/worker/daemon-ready-dispatch.ts";
import { daemonReconnectExpiry, daemonToolTimeoutBudgetAfterDelay } from "../../../src/worker/daemon-recovery-budget.ts";
import { relayDiagnosticsAfterReady, sanitizeDaemonRelayDiagnostics } from "../../../src/worker/daemon-relay-diagnostics.ts";
import { processRuntimeAlarm, scheduleRuntimeAlarm } from "../../../src/worker/runtime-alarm.ts";
import { respondWithoutDurableObject } from "../../../src/worker/worker-static-routes.ts";
import { createThrottledEdgeLogger } from "../../../src/worker/worker-edge-log.ts";
import {
  admitGlobalStatefulRequest, admitStatefulRequest, durableObjectQuotaResponse, isDurableObjectQuotaError,
  outerWorkerErrorClass, statefulRateLimitKey, statefulRouteClass, workerGatewayErrorResponse,
} from "../../../src/worker/worker-edge-guard.ts";
import { daemonToolTimeoutBudget, isRemoteDurableProcessTool, remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds, REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS, REMOTE_FOREGROUND_TIMEOUT_SECONDS } from "../../../src/worker/tool-timeout.ts";
import { managedJobReadArgumentsWithinExecutionBudget, managedJobReadExecutionBudgetHasHeadroom } from "../../../src/worker/managed-job-read-timeout.ts";
import { daemonToolRedeliveryArguments } from "../../../src/worker/daemon-tool-redelivery.ts";
import { issueManagedJobCapability, verifyManagedJobCapability } from "../../../src/worker/managed-job-capability.ts";
import { hostedManagedJobDaemonArguments, projectHostedManagedJobResult } from "../../../src/worker/managed-job-hosted-authority.ts";
import { jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool, validateWorkerToolArguments, workerToolParameterHeaders, workerToolSchemaGeneration, workspaceTools } from "../../../src/worker/tool-catalog.ts";
import { staleSchemaGuidanceResult } from "../../../src/worker/mcp-stale-schema-guidance.ts";
import { workerAuthorityContext, workerToolsForRole } from "../../../src/worker/worker-tool-authority.ts";
import { daemonToolRecovery } from "../../../src/worker/tool-call-recovery.ts";
import relayContract from "../../../src/shared/relay-contract.json" with { type: "json" };
import {
  daemonCallNotReceivedAfterReconnectError, daemonToolError, dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError,
  dispatchedDaemonPlannedDrainError, dispatchedDaemonTimeoutError, publicWorkerToolError, revokedDaemonAuthorityError, WorkerToolError,
} from "../../../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../../../src/worker/policy.ts";
import { WorkerObservability } from "../../../src/worker/observability.ts";
import {
  readWorkerContinuityEvidence, recordWorkerClientCancellation, recordWorkerPlannedDrain, recordWorkerSocketDisconnect,
} from "../../../src/worker/worker-continuity-evidence.ts";
import { daemonStatusSnapshot } from "../../../src/worker/daemon-status.ts";
import { DaemonLastObservation } from "../../../src/worker/daemon-last-observation.ts";
import { buildServerInfoResult, serverInfoDetail } from "../../../src/worker/server-info.ts";
import { remoteToolDeliveryContract } from "../../../src/worker/server-info-tool-delivery.ts";
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../../../src/worker/mcp-subscription-contract.ts";
import {
  JOB_MONITOR_RESOURCE_URI, MCP_APP_MIME_TYPE, MCP_UI_EXTENSION_ID,
  managedJobMonitorResource, managedJobMonitorResources, supportsManagedJobMonitor,
} from "../../../src/worker/mcp-job-monitor-ui.ts";
import {
  ManagedJobMonitorClaimStore, cancelManagedJobMonitorClaimsIfAvailable, claimManagedJobMonitor,
  hasManagedJobMonitorClaim, hasManagedJobMonitorClaimIfAvailable, issueManagedJobMonitorIfAvailable,
} from "../../../src/worker/mcp-job-monitor-claims.ts";
import {
  JOB_MONITOR_CLAIM_TOOL, JOB_MONITOR_READ_TOOL, JOB_MONITOR_RENDER_TOOL,
  managedJobMonitorReadDaemonArguments, renderManagedJobMonitor,
} from "../../../src/worker/mcp-job-monitor-tools.ts";
import { projectManagedJobMonitorStatus } from "../../../src/worker/mcp-job-monitor-status.ts";
import { workerBodyLimitBytes } from "../../../src/worker/worker-runtime-config.ts";
import { retainWorkerTask } from "../../../src/worker/worker-task-lifetime.ts";
import { applyCors, corsPreflight, searchParamsObject, workerErrorClass } from "../../../src/worker/http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  textToolResult,
} from "../../../src/worker/mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, daemonErrorCloseCode, daemonResumeMissingCallIds, isObjectRecord, rejectDaemonMessage,
  sendWebSocketQuietly, trySendWebSocket,
} from "../../../src/worker/websocket-protocol.ts";
import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
  isLiveDaemonAttachment,
  withDaemonLastSeenAt,
} from "../../../src/worker/daemon-liveness.ts";

const SYNTHETIC_REFRESH_TOKEN = `mcp_rt_${"r".repeat(43)}`;
const SYNTHETIC_ACCOUNT_ID = `acct_${"a".repeat(43)}`;
const SYNTHETIC_CLIENT_ID = `mcp_client_${"c".repeat(43)}`;
const SYNTHETIC_FAMILY_ID = `mcp_family_${"f".repeat(43)}`;

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

export {
  nodeAssert, handleOuterWorkerFetch, DaemonHttpChannel, normalizeDaemonHttpExchange,
  queueDaemonHttpRevocations, PendingCallRegistry, pendingCallReconnectSettlement,
  MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, pendingCapacityProjection, DaemonSocketRegistry,
  DaemonRegistry, settleDaemonProvenMissingCalls, cancelReadyDaemonAuthority, notifyReadyDaemon,
  readyDaemonWaiterSnapshot, waitForReadyDaemon, immediateReadyDaemonForDispatch,
  readyDaemonForDispatch, daemonReconnectExpiry, daemonToolTimeoutBudgetAfterDelay,
  relayDiagnosticsAfterReady, sanitizeDaemonRelayDiagnostics, processRuntimeAlarm,
  scheduleRuntimeAlarm, respondWithoutDurableObject, createThrottledEdgeLogger,
  admitGlobalStatefulRequest, admitStatefulRequest, durableObjectQuotaResponse,
  isDurableObjectQuotaError, outerWorkerErrorClass, statefulRateLimitKey, statefulRouteClass,
  workerGatewayErrorResponse, daemonToolTimeoutBudget, isRemoteDurableProcessTool,
  remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds,
  REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS, managedJobReadArgumentsWithinExecutionBudget,
  managedJobReadExecutionBudgetHasHeadroom, daemonToolRedeliveryArguments, issueManagedJobCapability,
  verifyManagedJobCapability, hostedManagedJobDaemonArguments, projectHostedManagedJobResult,
  jobMonitorClaimTool, jobMonitorReadTool, jobMonitorRenderTool, serverInfoTool,
  validateWorkerToolArguments, workerToolParameterHeaders, workerToolSchemaGeneration, workspaceTools,
  staleSchemaGuidanceResult, workerAuthorityContext, workerToolsForRole, daemonToolRecovery,
  relayContract, daemonCallNotReceivedAfterReconnectError, daemonToolError,
  dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError,
  dispatchedDaemonPlannedDrainError, dispatchedDaemonTimeoutError, publicWorkerToolError,
  revokedDaemonAuthorityError, WorkerToolError, policyAllowsAvailability, sanitizeDaemonPolicy,
  sanitizeDaemonTools, WorkerObservability, readWorkerContinuityEvidence, recordWorkerClientCancellation,
  recordWorkerPlannedDrain, recordWorkerSocketDisconnect, daemonStatusSnapshot, DaemonLastObservation,
  buildServerInfoResult, serverInfoDetail, remoteToolDeliveryContract,
  MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS, JOB_MONITOR_RESOURCE_URI, MCP_APP_MIME_TYPE,
  MCP_UI_EXTENSION_ID, managedJobMonitorResource, managedJobMonitorResources,
  supportsManagedJobMonitor, ManagedJobMonitorClaimStore, cancelManagedJobMonitorClaimsIfAvailable,
  claimManagedJobMonitor, hasManagedJobMonitorClaim, hasManagedJobMonitorClaimIfAvailable,
  issueManagedJobMonitorIfAvailable, JOB_MONITOR_CLAIM_TOOL, JOB_MONITOR_READ_TOOL,
  JOB_MONITOR_RENDER_TOOL, managedJobMonitorReadDaemonArguments, renderManagedJobMonitor,
  projectManagedJobMonitorStatus, workerBodyLimitBytes, retainWorkerTask, applyCors, corsPreflight,
  searchParamsObject, workerErrorClass, asObject, isJsonRpcRequest, isJsonRpcResponse,
  requiredString, rpcError, rpcResult, textToolResult, closeWebSocketQuietly, daemonErrorCloseCode,
  daemonResumeMissingCallIds, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly,
  trySendWebSocket, DAEMON_LIVENESS_TIMEOUT_MS, daemonLivenessDeadlineMs, isFreshDaemonCandidate,
  isLiveDaemonAttachment, withDaemonLastSeenAt,
  SYNTHETIC_REFRESH_TOKEN, SYNTHETIC_ACCOUNT_ID, SYNTHETIC_CLIENT_ID, SYNTHETIC_FAMILY_ID,
  TestWebSocket
};

function testDurableStorage() {
  const values = new Map();
  const storage = {
    async get(key) { const value = values.get(key); return value === undefined ? undefined : structuredClone(value); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async transaction(callback) { return callback(storage); },
  };
  return storage;
}
export { testDurableStorage };

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

export { expectRegistrationError, expectReject, assert, expectThrow };
