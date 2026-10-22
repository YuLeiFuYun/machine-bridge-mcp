import * as common from "./common.mjs";
const {
  nodeAssert, normalizeDaemonHttpExchange,
  relayDiagnosticsAfterReady, sanitizeDaemonRelayDiagnostics, createThrottledEdgeLogger, workerAuthorityContext, workerToolsForRole, daemonCallNotReceivedAfterReconnectError, daemonToolError,
  dispatchedDaemonCancellationError, dispatchedDaemonDisconnectError, dispatchedDaemonTimeoutError, publicWorkerToolError,
  revokedDaemonAuthorityError, WorkerToolError, policyAllowsAvailability, sanitizeDaemonPolicy,
  sanitizeDaemonTools, WorkerObservability, daemonStatusSnapshot, DaemonLastObservation,
  buildServerInfoResult, serverInfoDetail, workerBodyLimitBytes,
  searchParamsObject, workerErrorClass, asObject, isJsonRpcRequest, isJsonRpcResponse,
  requiredString, rpcError, rpcResult, textToolResult, closeWebSocketQuietly, daemonErrorCloseCode,
  daemonResumeMissingCallIds, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly,
  trySendWebSocket, DAEMON_LIVENESS_TIMEOUT_MS, daemonLivenessDeadlineMs, isFreshDaemonCandidate,
  isLiveDaemonAttachment, withDaemonLastSeenAt,
  SYNTHETIC_REFRESH_TOKEN, SYNTHETIC_ACCOUNT_ID, SYNTHETIC_CLIENT_ID, SYNTHETIC_FAMILY_ID, assert, expectThrow
} = common;

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

function testDaemonHttpExchangeTypes() {
  const value = {
    protocol: 1,
    session_id: `relay_http_${"s".repeat(43)}`,
    instance_id: `daemon_${"d".repeat(16)}`,
    ack_worker_seq: 1,
    takeover_websocket: false,
    owned_call_ids: [],
    messages: [],
    tools: [],
    policy: {},
    relay_diagnostics: {},
  };
  nodeAssert(normalizeDaemonHttpExchange(value)?.ackWorkerSeq === 1,
    "valid daemon HTTP acknowledgement was rejected");
  for (const ack of ["1", false, [1]]) {
    nodeAssert.equal(normalizeDaemonHttpExchange({ ...value, ack_worker_seq: ack }), null,
      "daemon HTTP protocol coerced a non-number acknowledgement sequence");
  }
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
    probe_dispatch_pending_at_start: true,
    probe_dispatch_age_ms_at_start: 23,
    probe_outstanding_at_start: false,
    probe_age_ms_at_start: 0,
    transport_confirmation_pending_at_start: true,
    application_inbound_silence_ms_at_start: 4800,
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
    last_disconnected_at: "2026-08-04T11:36:27.000Z",
    last_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 17, tcp_connected: 29, tls_established: 51, private_stage: 7 },
    last_failed_connect_stage: "tls_established",
    last_failed_connect_duration_ms: 61,
    last_failed_connect_milestones_ms: { socket_constructing: 0, dns_resolved: 16, tcp_connected: 28, tls_established: 61, private_stage: 8 },
    last_failed_connect_http_status: 503,
    previous_ready_duration_ms: 123456,
    previous_ready_inbound_silence_ms: 15000,
    https_fallback_last_takeover_ms: 1350,
    https_fallback_last_takeover_outage_number: 8,
    recent_outages: [{
      outage_number: 7,
      disconnected_at: "2026-08-04T11:30:00.000Z",
      last_disconnect_at: "2026-08-04T11:30:01.000Z",
      ready_at: "2026-08-04T11:30:02.000Z",
      duration_ms: 2000,
      https_fallback_taken_over: true,
      https_fallback_takeover_ms: 700,
      attempts: 1,
      close_category: "connection_interrupted",
      close_code: 1006,
      network_route: "system-network-stack",
      last_transport_error_class: null,
      last_transport_error_reason: "unknown",
      previous_ready_duration_ms: 10000,
      previous_ready_inbound_silence_ms: 5000,
      probe_dispatch_pending_at_start: false,
      probe_dispatch_age_ms_at_start: 0,
      probe_outstanding_at_start: true,
      probe_age_ms_at_start: 7000,
      transport_confirmation_pending_at_start: false,
      application_inbound_silence_ms_at_start: 5000,
      last_connect_stage: "websocket_open",
      last_connect_duration_ms: 80,
      last_connect_milestones_ms: { dns_resolved: 15, websocket_open: 80, private_stage: 9 },
      private_value: "must-not-survive",
    }],
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
    && diagnostics.last_disconnected_at === "2026-08-04T11:36:27.000Z"
    && diagnostics.previous_ready_inbound_silence_ms === 15000
    && diagnostics.probe_dispatch_pending_at_start === true
    && diagnostics.probe_dispatch_age_ms_at_start === 23
    && diagnostics.probe_outstanding_at_start === false
    && diagnostics.transport_confirmation_pending_at_start === true
    && diagnostics.application_inbound_silence_ms_at_start === 4800
    && diagnostics.recent_outages.length === 1
    && diagnostics.recent_outages[0].outage_number === 7
    && diagnostics.recent_outages[0].last_disconnect_at === "2026-08-04T11:30:01.000Z"
    && diagnostics.recent_outages[0].probe_outstanding_at_start === true
    && diagnostics.recent_outages[0].probe_age_ms_at_start === 7000
    && diagnostics.recent_outages[0].last_connect_milestones_ms.private_stage === undefined
    && diagnostics.recent_outages[0].private_value === undefined
    && diagnostics.recent_outages[0].https_fallback_taken_over === true
    && diagnostics.recent_outages[0].https_fallback_takeover_ms === 700
    && diagnostics.https_fallback_last_takeover_ms === 1350
    && diagnostics.https_fallback_last_takeover_outage_number === 8,
  "Worker relay diagnostics sanitizer lost valid bounded evidence");
  const readyDiagnostics = relayDiagnosticsAfterReady(diagnostics, "2026-08-04T11:36:29.000Z");
  assert(readyDiagnostics?.outage_active === false && readyDiagnostics.outage_duration_ms === 9000
    && readyDiagnostics.recent_outages.length === 2
    && readyDiagnostics.recent_outages[0].outage_number === 8
    && readyDiagnostics.recent_outages[0].disconnected_at === "2026-08-04T11:36:20.000Z"
    && readyDiagnostics.recent_outages[0].last_disconnect_at === "2026-08-04T11:36:27.000Z"
    && readyDiagnostics.recent_outages[0].ready_at === "2026-08-04T11:36:29.000Z"
    && readyDiagnostics.recent_outages[0].duration_ms === 9000
    && readyDiagnostics.recent_outages[0].https_fallback_taken_over === true
    && readyDiagnostics.recent_outages[0].https_fallback_takeover_ms === 1350
    && readyDiagnostics.recent_outages[0].probe_dispatch_pending_at_start === true
    && readyDiagnostics.recent_outages[0].probe_dispatch_age_ms_at_start === 23
    && readyDiagnostics.recent_outages[0].transport_confirmation_pending_at_start === true
    && readyDiagnostics.recent_outages[0].application_inbound_silence_ms_at_start === 4800
    && readyDiagnostics.recent_outages[1].outage_number === 7
    && readyDiagnostics.recent_outages[1].https_fallback_taken_over === true
    && readyDiagnostics.recent_outages[1].https_fallback_takeover_ms === 700,
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
    https_fallback_last_takeover_outage_number: Number.POSITIVE_INFINITY,
    last_close_category: "private-category", last_close_code: 99999, last_transport_error_class: "x".repeat(200),
    last_transport_error_reason: "private-network-detail",
    last_probe_buffered_bytes: Number.POSITIVE_INFINITY, last_probe_dispatch_ms: -1,
    last_transport_error_ready: "yes", last_transport_error_authenticated: 1,
    recent_outages: Array.from({ length: 10 }, (_, index) => ({
      outage_number: index + 1, close_category: "private-category", last_transport_error_reason: "private-network-detail",
      last_connect_milestones_ms: { private_stage: 7 }, private_value: "must-not-survive",
    })),
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
    && bounded.recent_outages.length === 8
    && bounded.recent_outages[0].close_category === null
    && bounded.recent_outages[0].last_transport_error_reason === "unknown"
    && Object.keys(bounded.recent_outages[0].last_connect_milestones_ms).length === 0
    && bounded.recent_outages[0].private_value === undefined
    && bounded.https_fallback_last_takeover_ms === 0
    && bounded.https_fallback_last_takeover_outage_number === 0
    && bounded.last_close_category === null
    && bounded.last_close_code === null
    && bounded.last_transport_error_class === null,
  "Worker relay diagnostics sanitizer did not reject untrusted daemon metadata");
}

function testWorkerRuntimeConfig() {
  assert(workerBodyLimitBytes(undefined) === 8 * 1024 * 1024, "missing Worker body limit did not use the safe default");
  assert(workerBodyLimitBytes("0") === 8 * 1024 * 1024, "zero Worker body limit bypassed the safe default");
  assert(workerBodyLimitBytes("1048576") === 1024 * 1024, "valid Worker body limit was not preserved");
  assert(workerBodyLimitBytes(String(32 * 1024 * 1024)) === 16 * 1024 * 1024, "Worker body limit exceeded the hard maximum");
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
      schema_version: 2, planned_drains: 2, planned_drain_calls: 3,
      last_planned_drain_at: "2026-08-10T00:00:05.000Z", socket_disconnects: 4,
      unplanned_socket_disconnects: 1, ready_socket_disconnects: 3, unplanned_ready_socket_disconnects: 1,
      last_socket_disconnect: {
        at: "2026-08-10T00:00:06.000Z", planned: true, kind: "close", close_code: 1001, was_clean: true,
        role: "daemon", was_ready: true, connected_at: "2026-08-10T00:00:00.000Z",
      },
      last_ready_socket_disconnect: {
        at: "2026-08-10T00:00:06.000Z", planned: true, kind: "close", close_code: 1001, was_clean: true,
        role: "daemon", was_ready: true, connected_at: "2026-08-10T00:00:00.000Z",
      },
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
    && ownerFull.worker.continuity_evidence.ready_socket_disconnects === 3
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

function testWorkerObservability() {
  for (const name of ["operator@example.com", SYNTHETIC_REFRESH_TOKEN, `oauth_store_persist_oauth_${SYNTHETIC_REFRESH_TOKEN}`, "oauth_store_persist_oauth_error\nprivate"]) {
    const error = new Error("private cause retained internally");
    error.name = name;
    nodeAssert.equal(workerErrorClass(error), "error", "unexpected exception name entered the public error class");
  }
  nodeAssert.equal(workerErrorClass(new TypeError("private")), "type_error");
  nodeAssert.equal(workerErrorClass(new RangeError("private")), "range_error");
  nodeAssert.equal(workerErrorClass(null), "unknown_error");
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
      account_id: SYNTHETIC_ACCOUNT_ID,
      client_id: SYNTHETIC_CLIENT_ID,
      owner_family_id: SYNTHETIC_FAMILY_ID,
      path: "/mcp",
      detail: `Bearer abcdefghijklmnopqrstuvwxyz refresh=${SYNTHETIC_REFRESH_TOKEN} account=${SYNTHETIC_ACCOUNT_ID} client=${SYNTHETIC_CLIENT_ID} family=${SYNTHETIC_FAMILY_ID} for operator@example.com under /Users/example/private`,
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
  assert(event.account_id === "<redacted>" && event.client_id === "<redacted>" && event.owner_family_id === "<redacted>",
  "Worker structured event exposed stable authorization identity fields");
  assert(event.monkey === "safe-animal", "Worker sensitive-key matching over-redacted an unrelated field name");
  assert(event.path === "/mcp", "Worker structured event removed a safe route field");
  assert(!lines[0].includes("abcdefghijklmnopqrstuvwxyz") && !lines[0].includes("operator@example.com") && !lines[0].includes("/Users/example")
    && !lines[0].includes(SYNTHETIC_REFRESH_TOKEN) && !lines[0].includes(SYNTHETIC_ACCOUNT_ID)
    && !lines[0].includes(SYNTHETIC_CLIENT_ID) && !lines[0].includes(SYNTHETIC_FAMILY_ID),
  "Worker structured event leaked a sensitive value or stable authorization identity embedded in a non-sensitive field");
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
  assert(!isFreshDaemonCandidate([new Date(now - 1_000).toISOString()], now),
    "coercible candidate timestamp was accepted as liveness evidence");
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 1_000).toISOString(),
    lastSeenAt: [new Date(now - 1_000).toISOString()],
  }, now), "coercible lastSeenAt value was accepted as liveness evidence");
  assert(Number.isNaN(daemonLivenessDeadlineMs({
    role: "daemon",
    connectedAt: new Date(now - 1_000).toISOString(),
    lastSeenAt: "2026-07-17T12:00:00Z",
  })), "non-canonical daemon liveness timestamp was accepted");
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
    detail: `Bearer abcdefghijklmnopqrstuvwxyz refresh=${SYNTHETIC_REFRESH_TOKEN} account=${SYNTHETIC_ACCOUNT_ID} client=${SYNTHETIC_CLIENT_ID} family=${SYNTHETIC_FAMILY_ID} for operator@example.com under /Users/example/private\nline`,
    access_token: "must-not-leak",
    apiKey: "opaque-api-value",
    proof: "opaque-proof-value",
    account_id: SYNTHETIC_ACCOUNT_ID,
    client_id: SYNTHETIC_CLIENT_ID,
    owner_family_id: SYNTHETIC_FAMILY_ID,
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
    && lines[0].value.account_id === "<redacted>" && lines[0].value.client_id === "<redacted>"
    && lines[0].value.owner_family_id === "<redacted>"
    && lines[0].value.apikey === "<redacted>" && lines[0].value.proof === "<redacted>" && lines[0].value.monkey === "safe-animal"
    && !JSON.stringify(lines[0]).includes("must-not-leak") && !JSON.stringify(lines[0]).includes("opaque-api-value")
    && !JSON.stringify(lines[0]).includes("opaque-proof-value") && !JSON.stringify(lines[0]).includes("abcdefghijklmnopqrstuvwxyz")
    && !JSON.stringify(lines[0]).includes("operator@example.com") && !JSON.stringify(lines[0]).includes("/Users/example")
    && !JSON.stringify(lines[0]).includes(SYNTHETIC_REFRESH_TOKEN) && !JSON.stringify(lines[0]).includes(SYNTHETIC_ACCOUNT_ID)
    && !JSON.stringify(lines[0]).includes(SYNTHETIC_CLIENT_ID) && !JSON.stringify(lines[0]).includes(SYNTHETIC_FAMILY_ID),
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

export async function runProtocolAndPolicyScenarios() {
  testWorkerToolAuthorityProjection();
  testDaemonHttpExchangeTypes();
  testDaemonRelayDiagnostics();
  testWorkerRuntimeConfig();
  testWorkerPolicyParity();
  testWorkerErrors();
  testDaemonAndServerInfoProjection();
  testWorkerObservability();
  testPrototypeSafeFormFields();
  testMcpJsonRpcProtocol();
  testWebSocketProtocol();
  testDaemonLiveness();
  testThrottledEdgeLogger();
}
