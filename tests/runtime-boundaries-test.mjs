import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectOverview, buildRuntimeInfo } from "../src/local/runtime-reporting.mjs";
import { runtimeActivityVisible } from "../src/local/runtime-activity-projection.mjs";
import { projectOverviewDetail, projectProjectOverview } from "../src/shared/project-overview-projection.mjs";
import { GitService } from "../src/local/git-service.mjs";
import { diagnoseRuntime, RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS } from "../src/local/runtime-diagnostics.mjs";
import { DOCTOR_RUNTIME_SCOPE, doctorRuntimeCheckProjection } from "../src/local/doctor-reporting.mjs";
import { classifySystemRouteInterface, inspectSystemNetworkRoute, systemNetworkRouteCheck } from "../src/local/system-network-route.mjs";
import { resolveTaskCapabilities, sessionBootstrap } from "../src/local/runtime-capabilities.mjs";
import { projectApplicationCapabilities } from "../src/local/application-capability-projection.mjs";
import { policyProfile } from "../src/local/policy.mjs";
import { openDirectoryIfExists, pathEntryIfExists } from "../src/local/path-inspection.mjs";
import { RuntimeResourceService } from "../src/local/runtime-resource-service.mjs";
import { ProcessSessionManager } from "../src/local/process-sessions.mjs";
import { settleDurableProcessAcceptance } from "../src/local/durable-process-initial-settlement.mjs";
import { correlateEventLoopStallWithSystemSleep, correlateRelayOutageWithSystemSleep, parseSystemSleepIntervals } from "../src/local/system-sleep-diagnostics.mjs";

await testRuntimeReporting();
testProcessSessionStatusAuthority();
await testDurableProcessInitialSettlement();
testSystemSleepDiagnostics();
await testRuntimeDiagnostics();
testDoctorReportingScope();
await testGitServiceDiscoveryBoundary();
await testRuntimeCapabilities();
await testRuntimeResourceService();
await testPathInspectionFailures();
console.log("runtime boundary services test ok");

function testSystemSleepDiagnostics() {
  const intervals = parseSystemSleepIntervals([
    "2026-08-25 00:32:48 +0800 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using Batt (Charge:77%) 927 secs",
    "2026-08-25 00:48:15 +0800 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to rtc/SleepService Using BATT (Charge:77%) 2 secs",
    "2026-08-25 00:48:17 +0800 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:77%) 954 secs",
  ].join("\n"));
  assert(intervals.length === 2 && intervals[0].reason === "idle_sleep"
    && intervals[1].reason === "sleep_service_back_to_sleep"
    && intervals[1].ended_at === "2026-08-24T17:04:11.000Z"
    && intervals[1].duration_ms === 954_000,
  "macOS sleep diagnostic did not reduce pmset history to bounded sleep intervals");
  const matched = correlateEventLoopStallWithSystemSleep({ heartbeat: {
    last_event_loop_stall_at: "2026-08-24T17:04:10.810Z",
    last_event_loop_stall_lag_ms: 947_954,
  } }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(matched.classification === "matched_system_sleep"
    && matched.matched_sleep?.reason === "sleep_service_back_to_sleep",
  "runtime pause was not correlated with a same-duration macOS sleep interval");
  const unmatched = correlateEventLoopStallWithSystemSleep({ heartbeat: {
    last_event_loop_stall_at: "2026-08-24T18:04:10.810Z",
    last_event_loop_stall_lag_ms: 120_000,
  } }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(unmatched.classification === "no_matching_recent_system_sleep" && unmatched.matched_sleep === null,
    "non-sleep runtime pause was overclassified as system suspension");
  const sleepDominatedOutage = correlateRelayOutageWithSystemSleep({
    outage_active: false,
    last_disconnected_at: "2026-08-24T16:48:10.000Z",
    last_ready_at: "2026-08-24T17:04:12.000Z",
  }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(sleepDominatedOutage.classification === "majority_system_sleep_overlap"
    && sleepDominatedOutage.outage_duration_ms === 962_000
    && sleepDominatedOutage.sleep_overlap_ms === 959_000
    && sleepDominatedOutage.sleep_overlap_ratio > 0.99
    && sleepDominatedOutage.matched_sleep_count === 2,
  "relay outage dominated by macOS sleep was still represented as independent network-only evidence");
  const wakeBoundaryAftermath = correlateRelayOutageWithSystemSleep({
    outage_active: false,
    last_disconnected_at: "2026-08-24T17:04:11.250Z",
    last_ready_at: "2026-08-24T17:04:15.250Z",
    heartbeat: {
      last_event_loop_stall_at: "2026-08-24T17:04:10.810Z",
      last_event_loop_stall_lag_ms: 947_954,
    },
  }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(wakeBoundaryAftermath.classification === "wake_boundary_system_sleep_aftermath"
    && wakeBoundaryAftermath.outage_duration_ms === 4_000
    && wakeBoundaryAftermath.sleep_overlap_ms === 0
    && wakeBoundaryAftermath.sleep_overlap_ratio === 0
    && wakeBoundaryAftermath.matched_sleep_count === 1,
  "relay close first observed at wake was misrepresented as an independent awake reset despite matching runtime suspension evidence");
  const coincidentalWakeBoundary = correlateRelayOutageWithSystemSleep({
    outage_active: false,
    last_disconnected_at: "2026-08-24T17:04:11.250Z",
    last_ready_at: "2026-08-24T17:04:15.250Z",
    heartbeat: {
      last_event_loop_stall_at: "2026-08-24T18:04:10.810Z",
      last_event_loop_stall_lag_ms: 120_000,
    },
  }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(coincidentalWakeBoundary.classification === "no_matching_recent_system_sleep",
    "relay reset near a wake boundary was attributed to sleep without same-sleep event-loop suspension evidence");
  const awakeOutage = correlateRelayOutageWithSystemSleep({
    outage_active: false,
    last_disconnected_at: "2026-08-24T18:00:00.000Z",
    last_ready_at: "2026-08-24T18:00:09.000Z",
  }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(awakeOutage.classification === "no_matching_recent_system_sleep"
    && awakeOutage.sleep_overlap_ms === 0 && awakeOutage.sleep_overlap_ratio === 0,
  "awake relay reset was incorrectly attributed to system sleep");
  const activeOutage = correlateRelayOutageWithSystemSleep({
    outage_active: true, last_disconnected_at: "2026-08-24T18:00:00.000Z", last_ready_at: "2026-08-24T17:59:59.000Z",
  }, { supported: true, available: true, recent_sleep_intervals: intervals });
  assert(activeOutage.classification === "relay_outage_active" && activeOutage.outage_ended_at === null,
    "active relay outage was misrepresented as a completed sleep correlation");
}

async function testDurableProcessInitialSettlement() {
  const jobId = `job_${"A".repeat(24)}`;
  const accepted = {
    job_id: jobId, status: "queued", recovery: { tool: "read_job", job_id: jobId }, cleanup: { finally_steps: "none-declared" },
    execution_mode: "durable_job", source_tool: "exec_command", execution_timeout_seconds: 60, retry_safety: "same key",
  };
  const manager = {
    async readHosted() { return { job_id: jobId, status: "succeeded", current_phase: null, current_step: null, result: { status: "succeeded" } }; },
    readProgress() { throw new Error("terminal initial read should not poll progress"); },
  };
  const settled = await settleDurableProcessAcceptance(manager, accepted, { origin: "relay", authority: { origin: "relay" } });
  assert(settled.status === "succeeded" && settled.initial_settlement_terminal === true
    && settled.follow_up_read_required === false && settled.result?.status === "succeeded"
    && settled.recovery === accepted.recovery,
  "short durable process did not settle inside its original hosted tool response");
  const local = await settleDurableProcessAcceptance(manager, accepted, { origin: "stdio" });
  assert(local === accepted, "local durable process delivery gained an unnecessary initial settlement wait");
  const unavailable = await settleDurableProcessAcceptance({
    async readHosted() { throw new Error("synthetic read failure"); }, readProgress() { return {}; },
  }, accepted, { origin: "relay", authority: { origin: "relay" } });
  assert(unavailable.status === "queued" && unavailable.initial_settlement_unavailable === true
    && unavailable.follow_up_read_required === true && unavailable.recovery === accepted.recovery,
  "optional initial settlement failure replaced the durable acceptance recovery envelope");
}

async function testRuntimeReporting() {
  const full = policyProfile("full");
  const info = buildRuntimeInfo({
    workspace: "/workspace/project",
    displayPath: (value) => value,
    policy: full,
    toolNames: ["read_file"],
    capabilityObserver: { snapshot: () => ({ bootstrap_count: 1 }) },
    observability: { snapshot: () => ({ calls: { started: 2 } }) },
    callRegistry: { snapshot: () => ({ active: 0 }) },
    lifecycle: { snapshot: () => ({ state: "running" }) },
    relayStatus: () => ({ ready: true }),
    runtimeDir: "/private/runtime",
    processTracker: { snapshot: () => ({ active_processes: 0 }) },
    processSessionManager: { status: () => ({ active: 0 }) },
    managedJobManager: {
      status: () => ({ active: 0 }),
      resourceInfo: () => ({ count: 0 }),
    },
  });
  assert(info.workspace_name === "project", "runtime info lost the exposed workspace name");
  assert(info.runtime.runtime_dir === "/private/runtime", "full policy runtime path was unexpectedly redacted");
  assert(info.policy_contract.named_profile_is_canonical === true, "canonical policy was not recognized");
  assert(info.observability.relay_readiness === "end-to-end-relay-probe-verified", "runtime observability describes stale hello-only readiness");
  const oneShot = info.runtime.execution_guardrails.one_shot_processes;
  assert(oneShot.output_max_bytes_per_stream === oneShot.inline_output_max_bytes_per_stream
    && oneShot.continuation_tool === "read_process"
    && oneShot.continuation_retention.includes("best-effort"),
  "runtime info lost the compatible one-shot output limit or continuation semantics");
  assert(oneShot.process_tree_termination === "sigterm-then-sigkill", "runtime info omitted process-tree supervision");
  assert(info.runtime.execution_guardrails.operating_system_enforcement.cpu_quota === "not-enforced"
    && info.runtime.execution_guardrails.operating_system_enforcement.memory_quota === "not-enforced"
    && info.runtime.execution_guardrails.operating_system_enforcement.network_isolation === "not-enforced",
  "runtime info falsely advertised OS resource or network isolation");

  const review = policyProfile("review");
  const redacted = buildRuntimeInfo({
    workspace: "/workspace/project",
    displayPath: () => ".",
    policy: review,
    toolNames: [],
    capabilityObserver: { snapshot: () => ({}) },
    observability: { snapshot: () => ({}) },
    callRegistry: { snapshot: () => ({}) },
    lifecycle: { snapshot: () => ({}) },
    relayStatus: () => null,
    runtimeDir: "/private/runtime",
    processTracker: { snapshot: () => ({}) },
    processSessionManager: { status: () => ({}) },
    managedJobManager: { status: () => ({}), resourceInfo: () => ({}) },
  });
  assert(redacted.workspace_name === "workspace" && redacted.runtime.runtime_dir === "<private-runtime-dir>", "review policy leaked private paths");

  const editorContext = { authority: { owner: false, principal: { kind: "account", role: "editor" } } };
  assert(runtimeActivityVisible({}) === true
    && runtimeActivityVisible({ authority: { owner: true, principal: { kind: "account", role: "owner" } } }) === true
    && runtimeActivityVisible(editorContext) === false
    && runtimeActivityVisible({ origin: "relay", authority: { principal: { kind: "account", role: "editor" } } }) === false,
  "runtime activity projection failed open for a malformed relay/account authority context");
  const nonOwner = buildRuntimeInfo({
    workspace: "/workspace/project", displayPath: () => ".", policy: review, toolNames: ["read_file"],
    capabilityObserver: { snapshot: () => ({ last_task_resolution: { selected_skill: "private-skill" } }) },
    observability: { snapshot: () => ({ tools: { exec_command: { started: 9 } }, calls: { started: 9 } }) },
    callRegistry: { snapshot: () => ({ active: 5, maximum: 16, ordinary_capacity: 14, reserved_capacity: 2, oldest_ms: 9999, by_origin: { relay: 5 } }) },
    lifecycle: { snapshot: () => ({ state: "running" }) }, relayStatus: () => ({ ready: true }), runtimeDir: "/private/runtime",
    processTracker: { snapshot: () => ({ active_processes: 4, draining_processes: 2 }) },
    processSessionManager: { status: (context) => ({ active: context === editorContext ? 1 : 99, retained: 1, maximum: 8 }) },
    managedJobManager: {
      status: (context) => ({ active: 0, retained: context === editorContext ? 1 : 99, maximum: 50 }),
      resourceInfo: (context) => ({ count: context === editorContext ? null : 99, names: [], inventory_hidden_by_authority: true }),
    },
    securityAudit: { enabled: true, healthy: true, chain_verified: true, persistence: "atomic", worker_ready: true, retained: 400, last_event_at: "private", queue_depth: 3 },
    deviceRootStatus: { provider: "secure", root_storage: "Secure Enclave", key_id: "private-stable-key" },
    context: editorContext,
  });
  assert(nonOwner.observability.capability_routing.activity_hidden_by_authority === true
    && nonOwner.observability.tool_calls.activity_hidden_by_authority === true
    && nonOwner.observability.in_flight_calls.activity_hidden_by_authority === true
    && nonOwner.observability.in_flight_calls.maximum === 16
    && !("active" in nonOwner.observability.in_flight_calls) && !("oldest_ms" in nonOwner.observability.in_flight_calls),
  "non-owner runtime info leaked global task/tool/in-flight activity or hid static call capacity");
  assert(nonOwner.runtime.processes.activity_hidden_by_authority === true
    && nonOwner.runtime.process_sessions.active === 1 && nonOwner.runtime.managed_jobs.retained === 1
    && nonOwner.runtime.local_resources.inventory_hidden_by_authority === true,
  "non-owner runtime info leaked global process activity or lost principal-bound session/job state");
  assert(nonOwner.security_audit.activity_hidden_by_authority === true && !("last_event_at" in nonOwner.security_audit)
    && !("retained" in nonOwner.security_audit) && !("queue_depth" in nonOwner.security_audit)
    && nonOwner.trust.device_root.key_id_hidden_by_authority === true && !("key_id" in nonOwner.trust.device_root),
  "non-owner runtime info leaked audit activity or the stable device-root key id");

  const overview = await buildProjectOverview({
    workspace: "/workspace/project",
    displayPath: (value) => value,
    policy: full,
    toolNames: ["read_file"],
    capabilityObserver: { snapshot: () => ({ resolutions: 1 }) },
    listTopLevel: async () => ({ entries: [{ name: "README.md" }] }),
    resolveGitRoot: async () => "/workspace/project",
    safeErrorMessage: (error) => String(error?.message || error),
    throwIfCancelled() {},
  });
  assert(overview.gitRoot === "/workspace/project" && overview.topLevel.length === 1, "project overview lost repository metadata");
  assert(overview.topLevelTotal === 1 && overview.topLevelTruncated === false, "project overview misreported its bounded inventory metadata");
  assert(overview.daemonPolicy.profile === "full" && overview.daemonTools.includes("read_file"), "project overview omitted the explicit daemon ceiling");
  const nonOwnerOverview = await buildProjectOverview({
    workspace: "/workspace/project", displayPath: (value) => value, policy: review, toolNames: ["read_file"],
    daemonPolicy: full, daemonToolNames: ["read_file", "exec_command"],
    capabilityObserver: { snapshot: () => ({ last_task_resolution: { selected_skill: "private-skill" } }) },
    listTopLevel: async () => ({ entries: [] }), resolveGitRoot: async () => "/workspace/project",
    safeErrorMessage: () => "safe", throwIfCancelled() {},
  }, editorContext);
  assert(nonOwnerOverview.capabilityRouting.activity_hidden_by_authority === true
    && nonOwnerOverview.daemonTools.includes("exec_command"),
  "non-owner project overview leaked cross-principal capability activity or lost the explicitly labeled daemon ceiling");

  const starts = [];
  let releaseTopLevel;
  const topLevelGate = new Promise((resolvePromise) => { releaseTopLevel = resolvePromise; });
  const concurrentOverview = buildProjectOverview({
    workspace: "/workspace/project",
    displayPath: (value) => value,
    policy: full,
    toolNames: [],
    capabilityObserver: { snapshot: () => ({}) },
    listTopLevel: async () => {
      starts.push("top-level");
      await topLevelGate;
      return { entries: Array.from({ length: 55 }, (_value, index) => ({ name: `entry-${index}` })) };
    },
    resolveGitRoot: async () => {
      starts.push("git");
      return "/workspace/project";
    },
    safeErrorMessage: () => "safe",
    throwIfCancelled() {},
  });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert(starts.includes("top-level") && starts.includes("git"), "project overview serialized independent inventory and Git probes");
  releaseTopLevel();
  const boundedOverview = await concurrentOverview;
  assert(boundedOverview.topLevel.length === 40 && boundedOverview.topLevelTotal === 55 && boundedOverview.topLevelTruncated === true,
    "project overview did not bound oversized top-level inventories");

  const degraded = await buildProjectOverview({
    workspace: "/workspace/project",
    displayPath: () => ".",
    policy: review,
    toolNames: [],
    capabilityObserver: { snapshot: () => ({}) },
    listTopLevel: async () => { throw new Error("unreadable"); },
    resolveGitRoot: async () => "",
    safeErrorMessage: () => "safe",
    throwIfCancelled() {},
  });
  assert(degraded.gitRoot === "" && degraded.topLevel.length === 0, "project overview did not degrade safely");

  assert(projectOverviewDetail({}) === "full"
    && projectOverviewDetail({ detail: "summary" }) === "summary"
    && projectOverviewDetail({ detail: "unknown" }) === "full",
  "project overview detail selection lost backward-compatible full fallback");
  const syntheticTools = Array.from({ length: 500 }, (_value, index) => `synthetic_tool_${index}`);
  const syntheticOverview = {
    workspace: "/workspace/project", workspaceName: "project", gitRoot: "/workspace/project",
    policy: full, tools: syntheticTools, daemonPolicy: full, daemonTools: [...syntheticTools, "daemon_only"],
    capabilityRouting: {
      bootstrap_observed: true, bootstrap_count: 12, task_resolution_observed: true, task_resolution_count: 9,
      last_task_resolution: {
        observed_at: "2026-08-08T00:00:00.000Z", task_fingerprint: "private-task-fingerprint", refresh_fingerprint: "private-refresh",
        selected_skill: "skill", matched_skills: 3, matched_commands: 4, matched_applications: 5,
        recommended_tools: syntheticTools, primary_route: "files", routing_ambiguity: "low", routing_score_gap: 7,
      },
      enforcement_boundary: "cold path explanation",
    },
    topLevel: Array.from({ length: 40 }, (_value, index) => ({
      name: `entry-${index}`, path: `/workspace/project/${"private/".repeat(12)}entry-${index}`, type: index % 2 ? "file" : "directory", size: 1000 + index,
    })),
    topLevelTotal: 4000, topLevelTruncated: true,
    authorization: {
      account: { account_id: "acct_private", role: "owner", version: 3 }, effective_policy: full, effective_tools: syntheticTools,
      effective_tool_count: syntheticTools.length, account_role_is_owner: true, effective_profile_is_full: true,
      execution_model: { within_effective_authority: "automatic_without_per_operation_prompt", owner_ambient_authority: "daemon_os_user", generic_control_plane_paths: "denied_even_for_owner" },
    },
    policyScope: "authenticated_account_effective_authority", toolsScope: "authenticated_account_effective_tools_before_host_filtering",
  };
  const compactOverview = projectProjectOverview(syntheticOverview, "summary");
  const compactOverviewJson = JSON.stringify(compactOverview);
  assert(compactOverview.detail === "summary"
    && compactOverview.effectiveToolCount === 500 && compactOverview.daemonToolCount === 501
    && compactOverview.authorization?.account?.role === "owner" && !("account_id" in compactOverview.authorization.account)
    && compactOverview.topLevel.length === 40 && !("path" in compactOverview.topLevel[0]) && !("size" in compactOverview.topLevel[0])
    && !("tools" in compactOverview) && !("daemonTools" in compactOverview)
    && !compactOverviewJson.includes("synthetic_tool_")
    && !compactOverviewJson.includes("private-task-fingerprint")
    && !compactOverviewJson.includes("private-refresh")
    && !compactOverviewJson.includes("private/private"),
  "compact project overview leaked scale-dependent tool/path/fingerprint data or lost authority counts");
  assert(compactOverviewJson.length <= 5200,
    `compact project overview exceeded its 40-entry scale budget: ${compactOverviewJson.length} chars`);
  const hiddenCompactOverview = projectProjectOverview({ ...syntheticOverview, capabilityRouting: { activity_hidden_by_authority: true } }, "summary");
  assert(hiddenCompactOverview.capabilityRouting.activity_hidden_by_authority === true
    && !("task_resolution_count" in hiddenCompactOverview.capabilityRouting),
  "compact project overview converted hidden capability activity into false zero-valued evidence");
  assert(projectProjectOverview(syntheticOverview, "full") === syntheticOverview
    && projectProjectOverview("scalar", "summary") === "scalar",
  "project overview projection changed full/non-record compatibility results");
  const sparseCompactOverview = projectProjectOverview({
    workspace: null, workspaceName: null, gitRoot: null,
    tools: [], daemonTools: null, capabilityRouting: null, topLevel: "invalid",
    topLevelTotal: "invalid", topLevelTruncated: false, authorization: {
      effective_tool_count: "invalid", account_role_is_owner: false, effective_profile_is_full: false,
      execution_model: null,
    },
  }, "summary");
  assert(sparseCompactOverview.detail === "summary"
    && sparseCompactOverview.effectiveToolCount === 0
    && sparseCompactOverview.daemonToolCount === 0
    && sparseCompactOverview.topLevel.length === 0
    && sparseCompactOverview.topLevelTotal === 0
    && sparseCompactOverview.capabilityRouting.last_task_resolution === null
    && sparseCompactOverview.authorization.account === null
    && sparseCompactOverview.authorization.execution_model === null
    && !("policyScope" in sparseCompactOverview) && !("toolsScope" in sparseCompactOverview),
  "project overview sparse compact projection lost bounded fallback semantics");
  const oddTopLevel = projectProjectOverview({
    tools: ["one"], daemonTools: ["one"],
    capabilityRouting: { last_task_resolution: { recommended_tools: null, matched_skills: "bad", routing_score_gap: "bad" } },
    topLevel: [null, { name: "ok" }], topLevelTotal: 2,
  }, "summary");
  assert(oddTopLevel.topLevel[0].name === "" && oddTopLevel.topLevel[0].type === "other"
    && oddTopLevel.topLevel[1].name === "ok" && oddTopLevel.topLevel[1].type === "other"
    && oddTopLevel.capabilityRouting.last_task_resolution.recommended_tool_count === 0
    && oddTopLevel.capabilityRouting.last_task_resolution.matched_skills === 0
    && oddTopLevel.capabilityRouting.last_task_resolution.routing_score_gap === 0,
  "project overview compact projection lost malformed-optional-field fallbacks");
}

function testProcessSessionStatusAuthority() {
  const manager = Object.create(ProcessSessionManager.prototype);
  const owner = (accountId, closedAt = null) => ({
    closedAt,
    owner_kind: "account",
    owner_account_id: accountId,
    owner_account_version: 1,
    owner_client_id: "client-a",
    owner_family_id: "family-a",
  });
  manager.sessions = new Map([
    ["mine-live", owner("acct-editor")],
    ["mine-closed", owner("acct-editor", Date.now())],
    ["other-live", owner("acct-owner")],
  ]);
  const editorContext = { authority: { owner: false, principal: {
    kind: "account", role: "editor", accountId: "acct-editor", accountVersion: 1, clientId: "client-a", familyId: "family-a",
  } } };
  const editor = manager.status(editorContext);
  const localOwner = manager.status({});
  assert(editor.active === 1 && editor.retained === 2 && editor.maximum === 8,
    "process-session status leaked another principal's retained or active session");
  assert(localOwner.active === 2 && localOwner.retained === 3,
    "local owner process-session status lost the full machine-user view");
}

async function testRuntimeDiagnostics() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "mbm-runtime-diagnostics-"));
  try {
    const managedJobManager = {
      diagnoseStorage: () => ({ ok: true }),
      listResources: () => ({ count: 2, resources: [
        { name: "ok", available: true },
        { name: "missing", available: false, error_class: "not_found" },
      ] }),
    };
    let diagnosticProcessTimeoutMs = 0;
    let diagnosticShellTimeoutMs = 0;
    const shell = await diagnoseRuntime({
      policy: policyProfile("full"),
      runtimeDir,
      workspace: runtimeDir,
      runFixedInternal: async (command, _args, timeoutMs) => {
        if (command === process.execPath) {
          diagnosticProcessTimeoutMs = timeoutMs;
          return { code: 0, stdout: "ok", stderr: "" };
        }
        return { code: 0, stdout: "   interface: utun4\n", stderr: "" };
      },
      probeShell: async (_context, timeoutMs) => {
        diagnosticShellTimeoutMs = timeoutMs;
        return { code: 0, stdout: "", stderr: "" };
      },
      managedJobManager,
      relayStatus: () => ({
        ready: true, network_route: "system-network-stack", network_route_scope: "application-proxy-selection-only",
        outage_active: false, outage_count: 2, last_close_category: "relay_transport_error", last_close_code: 1006,
        last_transport_error_class: "network_error", last_ready_duration_ms: 5000, next_reconnect_in_ms: 0,
      }),
      controlPlaneState: {
        lifecycle: { state: "running", operational: true },
        inFlightCalls: { active: 14, ordinary_capacity: 14, reserved_capacity: 2 },
        processes: { active_processes: 1, draining_calls: 1 },
        executionGuardrails: { tool_calls: { maximum_concurrent: 16 } },
        securityAudit: { healthy: true, worker_ready: true, queue_depth: 0 },
      },
      throwIfCancelled() {},
    });
    assert(shell.request_reached_local_runtime === true, "runtime diagnostic lost local reachability evidence");
    assert(shell.interpretation?.current_request_delivery?.includes("blanket current platform disable")
      && shell.interpretation?.tool_call_blocked_before_response?.includes("not observable by Machine Bridge")
      && shell.interpretation?.tool_call_blocked_before_response?.includes("conversation/surface app routing state")
      && shell.interpretation?.tool_call_blocked_before_response?.includes("stale host action/tool snapshot")
      && shell.interpretation?.tool_call_blocked_before_response?.includes("host-side evidence")
      && shell.interpretation?.diagnostic_reached_daemon_but_spawn_failed?.includes("child exit code")
      && shell.interpretation?.diagnostic_reached_daemon_but_spawn_failed?.includes("remote target decided the failure"),
    "runtime diagnostic overclaimed an unobservable host/platform refusal");
    assert(shell.runtime.lifecycle.state === "running"
      && shell.runtime.processes.draining_calls === 1
      && shell.runtime.execution_guardrails.tool_calls.maximum_concurrent === 16
      && shell.runtime.security_audit.worker_ready === true
      && shell.runtime.relay_outage_analysis.classification === "no_recorded_relay_outage"
      && shell.observability.in_flight_calls.reserved_capacity === 2,
    "runtime diagnostic omitted privacy-safe control-plane state");
    assert(shell.checks.some((check) => check.layer === "local-shell" && check.ok), "shell diagnostic was not executed");
    assert(diagnosticProcessTimeoutMs === RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS
      && diagnosticShellTimeoutMs === RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS,
    "runtime diagnostic probes did not use the scheduler-tolerant bounded timeout");
    const relayCheck = shell.checks.find((check) => check.layer === "remote-relay");
    assert(relayCheck?.ok === true && relayCheck.outage_count === 2 && relayCheck.network_route === "system-network-stack", "relay diagnostic history was omitted");
    const routeCheck = shell.checks.find((check) => check.layer === "system-network-route");
    if (process.platform === "darwin") {
      assert(routeCheck?.ok === true && routeCheck.route_class === "tunnel-or-vpn"
        && routeCheck.operating_system_interception === true,
      "runtime diagnostics did not identify a system VPN/TUN default route");
    } else {
      assert(routeCheck?.skipped === true && routeCheck.error_class === "unsupported_platform",
        "non-macOS runtime diagnostics did not skip the macOS-only default-route probe");
    }
    assert(shell.ok === false, "unavailable local resource was hidden from diagnostic result");

    const review = await diagnoseRuntime({
      policy: policyProfile("review"),
      runtimeDir,
      workspace: runtimeDir,
      runFixedInternal: async () => { throw new Error("must not run"); },
      probeShell: async () => { throw new Error("must not run"); },
      managedJobManager: {
        diagnoseStorage: () => ({ ok: true }),
        listResources: () => ({ count: 0, resources: [] }),
      },
      throwIfCancelled() {},
    });
    assert(review.checks.filter((check) => ["local-process-spawn", "local-shell"].includes(check.layer) && check.skipped).length === 2, "review diagnostics executed forbidden process probes");
    assert(review.checks.some((check) => check.layer === "remote-relay" && check.skipped), "stdio/local diagnostics misreported a remote relay");
    assert(review.ok === false, "policy denial was not reflected in diagnostic status");

    const failed = await diagnoseRuntime({
      policy: policyProfile("agent"),
      runtimeDir,
      workspace: runtimeDir,
      runFixedInternal: async (command) => {
        if (command === process.execPath) throw new Error("spawn failed");
        return { code: 1, stdout: "", stderr: "unavailable" };
      },
      probeShell: async () => ({ code: 1, stdout: "", stderr: "" }),
      managedJobManager: {
        diagnoseStorage: () => ({ ok: false, error_class: "permission_denied" }),
        listResources: () => ({ count: 0, resources: [] }),
      },
      relayStatus: () => ({
        ready: false, network_route: "", network_route_scope: "", outage_active: true, outage_count: 0,
        last_close_category: "", last_close_code: "not-a-number", last_transport_error_class: "",
        last_disconnected_at: "", last_ready_at: "", last_ready_duration_ms: 0, next_reconnect_in_ms: 12,
      }),
      throwIfCancelled() {},
    });
    assert(failed.checks.some((check) => check.layer === "local-process-spawn" && !check.ok), "process failure was not classified");
    const failedRelay = failed.checks.find((check) => check.layer === "remote-relay");
    assert(failedRelay?.outage_active === true && failedRelay.network_route === "unknown"
      && failedRelay.last_close_code === null && failedRelay.next_reconnect_in_ms === 12,
    "degraded relay diagnostics did not normalize missing or invalid fields");
    assert(classifySystemRouteInterface("en0") === "physical-or-other"
      && classifySystemRouteInterface("utun12") === "tunnel-or-vpn"
      && classifySystemRouteInterface("lo0") === "loopback",
    "system route interface classification drifted");
    const unsupportedRoute = await inspectSystemNetworkRoute({ platform: "win32" });
    assert(unsupportedRoute.supported === false, "unsupported route inspection did not degrade safely");
    const unsupportedRouteCheck = await systemNetworkRouteCheck({ platform: "linux" });
    assert(unsupportedRouteCheck.skipped === true && unsupportedRouteCheck.error_class === "unsupported_platform",
      "unsupported platform route diagnostics did not expose a bounded skipped result");
    const missingRunner = await inspectSystemNetworkRoute({ platform: "darwin" });
    assert(missingRunner.supported === false, "missing fixed-command boundary did not disable route inspection");
    const unavailableRoute = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
    });
    assert(unavailableRoute.skipped === true && unavailableRoute.error_class === "unavailable",
      "failed default-route lookup was not represented as an unavailable diagnostic");
    const malformedRoute = await inspectSystemNetworkRoute({
      platform: "darwin",
      runFixedInternal: async () => ({ code: 0, stdout: "route without interface", stderr: "" }),
    });
    assert(malformedRoute.supported === true && malformedRoute.available === false,
      "default-route output without an interface was treated as usable");
    const physicalRoute = await inspectSystemNetworkRoute({
      platform: "darwin",
      runFixedInternal: async (...args) => {
        assert(args[5]?.request === "diagnostic", "route inspection dropped the request cancellation context");
        return { code: 0, stdout: " interface: en0\n", stderr: "" };
      },
      context: { request: "diagnostic" },
    });
    assert(physicalRoute.route_class === "physical-or-other" && physicalRoute.operating_system_interception === false,
      "physical route was classified as operating-system tunnel interception");
    const failedRoute = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      classifyError: () => "permission_denied",
    });
    assert(failedRoute.skipped === true && failedRoute.error_class === "permission_denied",
      "system route diagnostic leaked or misclassified a fixed-command failure");
    const defaultClassifiedFailure = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => { throw new Error("unknown"); },
    });
    assert(defaultClassifiedFailure.error_class === "unavailable",
      "system route diagnostic default error classification drifted");
    assert(classifySystemRouteInterface("") === "unknown"
      && classifySystemRouteInterface("bridge0") === "other",
    "unknown and non-standard route interfaces were not bounded to coarse classes");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function testDoctorReportingScope() {
  const skipped = doctorRuntimeCheckProjection({ layer: "remote-relay", skipped: true, error_class: "not applicable" });
  assert(skipped.ok === true && skipped.applicable === false
    && skipped.detail.includes("not inspected")
    && skipped.detail.includes("server_info.daemon.relay_transport"),
  "doctor reporting still presents the running relay as an inspected healthy check");
  assert(DOCTOR_RUNTIME_SCOPE.running_service_process_inspected === false
    && DOCTOR_RUNTIME_SCOPE.remote_relay_inspected === false,
  "doctor reporting scope falsely claims service relay inspection");
}

async function testGitServiceDiscoveryBoundary() {
  const root = await mkdtemp(join(tmpdir(), "mbm-git-discovery-boundary-"));
  try {
    let processCalls = 0;
    const service = new GitService({
      resolveExistingPath: async (value) => {
        if (value !== root) throw Object.assign(new Error("outside"), { code: "path_boundary" });
        return value;
      },
      displayPath: (value) => value,
      runInternalProcess: async () => {
        processCalls += 1;
        return { code: 128, stdout: "", stderr: "unexpected Git process" };
      },
      gitExecutable: () => "/usr/bin/git",
      maximumBytes: 1024 * 1024,
    });
    const result = await service.context(root);
    assert(result.ok === false, "Git discovery fixture unexpectedly found a repository");
    assert(processCalls === 0, "Git repository discovery executed Git before establishing the local metadata boundary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRuntimeCapabilities() {
  const rawApplicationCapabilities = {
    discovery: true,
    open: true,
    accessibility_inspection: true,
    structured_accessibility_actions: true,
    window_screenshot: true,
    background_visual_point: { available: true, backend: "synthetic" },
  };
  const discoveryOnly = projectApplicationCapabilities(rawApplicationCapabilities, (tool) => tool === "list_local_applications");
  assert(discoveryOnly.discovery === true
    && discoveryOnly.open === false
    && discoveryOnly.accessibility_inspection === false
    && discoveryOnly.structured_accessibility_actions === false
    && discoveryOnly.window_screenshot === false
    && discoveryOnly.background_visual_point.available === false,
  "application capability projection widened read-only discovery into UI authority");
  const fullProjection = projectApplicationCapabilities(rawApplicationCapabilities, () => true);
  assert(fullProjection.discovery === true
    && fullProjection.open === true
    && fullProjection.accessibility_inspection === true
    && fullProjection.structured_accessibility_actions === true
    && fullProjection.window_screenshot === true
    && fullProjection.background_visual_point.available === true,
  "application capability projection lost authorized full capabilities");

  const bootstrapObserver = [];
  const bootstrap = await sessionBootstrap({
    agentContextManager: { sessionBootstrap: async () => ({ instructions: "rules" }) },
    appAutomationManager: { capabilities: () => ({ structured: true }) },
    capabilityObserver: { recordBootstrap: (value) => bootstrapObserver.push(value) },
    policy: policyProfile("full"),
  }, { path: "." }, {});
  assert(bootstrap.local_automation.browser.existing_profile === true, "full bootstrap omitted browser capability");
  assert(bootstrapObserver.length === 1, "bootstrap routing observation was not recorded");

  const reviewBootstrap = await sessionBootstrap({
    agentContextManager: { sessionBootstrap: async () => ({ instructions: "rules" }) },
    appAutomationManager: { capabilities: () => ({ discovery: true, open: true, accessibility_inspection: true, structured_accessibility_actions: true, window_screenshot: true, background_visual_point: { available: true } }) },
    capabilityObserver: { recordBootstrap() {} },
    policy: policyProfile("review"),
  });
  assert(reviewBootstrap.local_automation.browser === null
    && reviewBootstrap.local_automation.applications?.discovery === true
    && reviewBootstrap.local_automation.applications?.open === false
    && reviewBootstrap.local_automation.applications?.accessibility_inspection === false
    && reviewBootstrap.local_automation.applications?.structured_accessibility_actions === false
    && reviewBootstrap.local_automation.applications?.window_screenshot === false
    && reviewBootstrap.local_automation.applications?.background_visual_point?.available === false,
  "review bootstrap did not separate read-only application discovery from mutation/inspection authority");

  const resolutions = [];
  const full = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: ["agent_context"] }) },
    appAutomationManager: { listApplications: async () => ({ applications: [
      { name: "Google Chrome", id: "com.google.Chrome" },
      { name: "Notes", id: "com.example.Notes" },
    ] }) },
    capabilityObserver: { recordResolution: (task, value) => resolutions.push({ task, value }) },
    policy: policyProfile("full"),
  }, { task: "Open Google Chrome and fill a browser form" }, {});
  assert(full.application_matches[0].name === "Google Chrome", "application ranking lost an exact task match");
  assert(full.application_discovery.available === true && full.application_discovery.warning_count === 0,
    "successful application discovery was not represented in capability routing");
  assert(full.recommended_tools.includes("operate_local_application"), "application match did not add structured tools");
  assert(full.browser_backend?.existing_profile === true, "full capability resolution omitted existing-profile browser backend");
  assert(full.execution_routing?.primary_route?.id === "application" || full.execution_routing?.primary_route?.id === "browser",
    "set-level capability routing did not recognize the application/browser task");
  assert(full.execution_routing?.routes?.some((route) => route.id === "shell"),
    "capability routing removed the direct shell escape hatch");
  assert(resolutions.length === 1, "capability routing observation was not recorded");

  const degradedFull = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: [] }) },
    appAutomationManager: { listApplications: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    capabilityObserver: { recordResolution() {} },
    policy: policyProfile("full"),
  }, { task: "open app" });
  assert(degradedFull.application_matches.length === 0
    && degradedFull.application_discovery.available === false
    && degradedFull.application_discovery.error_class === "permission_denied",
  "application discovery failure was silently converted to an empty successful result");

  const review = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: [] }) },
    appAutomationManager: { listApplications: async () => ({ applications: [{ name: "Notes", id: "com.example.Notes" }] }) },
    capabilityObserver: { recordResolution() {} },
    policy: policyProfile("review"),
  }, { task: "open app" });
  assert(review.application_matches.length === 0 && review.browser_backend === null, "review capability resolution expanded automation authority");
  assert(review.application_discovery.available === true && !review.application_discovery.reason,
    "read-only application discovery remained blocked under review authority");
  assert(review.execution_routing.routes.some((route) => route.id === "application-discovery")
    && !review.execution_routing.routes.some((route) => ["application", "browser", "shell"].includes(route.id)),
  "review capability routing did not isolate application inventory from unavailable mutation/browser/shell surfaces");
}

async function testRuntimeResourceService() {
  const root = await mkdtemp(join(tmpdir(), "mbm-runtime-resources-"));
  try {
    const textPath = join(root, "text-resource");
    const binaryPath = join(root, "binary-resource");
    await writeFile(textPath, "resource-text", { mode: 0o600 });
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    const authorized = [];
    const resources = {
      text: { path: textPath },
      binary: { path: binaryPath },
    };
    const service = new RuntimeResourceService({
      workspace: root,
      currentResources: () => resources,
      authorizeTool: (tool) => authorized.push(tool),
    });
    assert(service.readText("text") === "resource-text", "runtime resource service lost UTF-8 text content");
    assert(service.readBinary("text").size === Buffer.byteLength("resource-text"), "runtime resource service lost binary metadata");
    expectThrow(() => service.readText("binary"), "not valid UTF-8");
    expectThrow(() => service.readBinary("missing"), "unknown local resource");
    await expectReject(() => service.generateSshKey({ name: "generated" }), "resource state is unavailable");
    assert(authorized.join(",") === "generate_ssh_key_resource", "runtime resource service bypassed tool authorization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testPathInspectionFailures() {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert(await pathEntryIfExists("ignored", async () => { throw missing; }) === null,
    "missing path was not represented as absence");
  assert(await openDirectoryIfExists("ignored", async () => { throw missing; }) === null,
    "missing directory was not represented as absence");

  for (const inspect of [pathEntryIfExists, openDirectoryIfExists]) {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    let observed;
    try { await inspect("ignored", async () => { throw denied; }); } catch (error) { observed = error; }
    assert(observed === denied, "filesystem permission failure was misclassified as a missing path");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(operation, expected) {
  try { operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected throw containing ${expected}`);
}

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected rejection containing ${expected}`);
}
