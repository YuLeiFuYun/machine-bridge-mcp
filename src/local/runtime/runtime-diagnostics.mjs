import { executionGuardrailsSnapshot } from "../process/execution-limits.mjs";
import { relayRecoveryRuntimeSnapshot } from "../transport/relay-recovery.mjs";
import { publicSecurityAudit, runtimeActivityVisible } from "./runtime-projections.mjs";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyOperationalError } from "../core/log.mjs";
import { readBoundedFile } from "../files/workspace-file-service.mjs";
import { systemNetworkRouteCheck } from "../transport/stdio-task-projection.mjs";
import { resourceAdmissionDiagnostic } from "../process/resource-admission-policy.mjs";
import { correlateEventLoopStallWithSystemSleep, correlateRelayOutageWithSystemSleep, systemSleepDiagnostic } from "../core/idle-sleep-assertions.mjs";
import { resolveRuntimeNodeExecutable, runtimeNodeExecutableCheck, runtimeNodeProcessCheck } from "../core/runtime-node.mjs";
import { buildExecutionRouting } from "./call-registry.mjs";
import { policyAllowsTool } from "../core/policy.mjs";
import { projectApplicationCapabilities, applicationMatchScore } from "../automation/app-macos-jxa.mjs";
import { validateDeviceSessionIdentity } from "../state/device-identity.mjs";
import { prepareDurableDirectProcess, prepareDurableRegisteredProcess, prepareDurableShellProcess, settleDurableProcessAcceptance } from "./call-helpers.mjs";
import { BridgeError } from "../core/errors.mjs";
import { AppAutomationManager } from "../automation/app-automation.mjs";
import { applicationBackgroundInputConfiguration } from "../automation/macos-background-input.mjs";

export function runtimeControlPlaneSnapshot(runtime) {
  return {
    lifecycle: runtime.lifecycle.snapshot(),
    inFlightCalls: runtime.callRegistry.snapshot(),
    relayResultRecovery: relayRecoveryRuntimeSnapshot(runtime.activeRelayCalls.values(), runtime.relayCallRecovery),
    processes: runtime.processTracker.snapshot(),
    executionGuardrails: executionGuardrailsSnapshot(),
    securityAudit: runtime.securityAudit.snapshot(),
    idleSleepGuard: runtime.remoteActivityIdleSleepGuard.snapshot(),
  };
}

export function diagnosticControlPlaneState(state = {}, relay = null) {
  return {
    observability: { in_flight_calls: state.inFlightCalls ?? null },
    runtime: {
      lifecycle: state.lifecycle ?? null,
      relay,
      relay_result_recovery: state.relayResultRecovery ?? null,
      processes: state.processes ?? null,
      execution_guardrails: state.executionGuardrails ?? null,
      managed_jobs: state.managedJobs ?? null,
      resource_admission: state.resourceAdmission ?? null,
      security_audit: state.securityAudit ?? null,
      idle_sleep_guard: state.idleSleepGuard ?? null,
      system_sleep: state.systemSleep ?? null,
      event_loop_pause_analysis: state.eventLoopPauseAnalysis ?? null,
      relay_outage_analysis: state.relayOutageAnalysis ?? null,
    },
  };
}
export function diagnosticInterpretation() {
  return {
    current_request_delivery: "confirmed: this diagnose_runtime request reached the local runtime; this evidence does not support a blanket current platform disable of Machine Bridge",
    tool_call_blocked_before_response: "not observable by Machine Bridge; possible causes include conversation/surface app routing state, a stale host action/tool snapshot, host tool filtering, connector gateway, client routing, or platform policy; do not attribute one without host-side evidence",
    runtime_node_executable: "runtime-node-executable reports only provenance class and availability booleans, never an executable path. source=original_launcher means the daemon's concrete Node executable disappeared after startup but its original absolute Node launcher remains executable; durable child Node processes use that launcher and a service restart refreshes the concrete runtime identity",
    diagnostic_reached_daemon_but_spawn_failed: "inspect runtime-node-executable first. If it is unavailable, the daemon can no longer launch child Node processes and should be restarted to refresh its runtime launcher. If that layer is available, the fixed local spawn/shell probes bypass cooperative resource admission, so a true probe failure then points to the local OS, endpoint security, shell configuration, or Machine Bridge policy; a child exit code or bounded stdout/stderr instead proves spawn succeeded and the nested command or remote target decided the failure",
    system_network_stack_scope: "application proxy selection only; an operating-system VPN or TUN may still intercept the relay connection",
    tunnel_default_route_detected: "the operating-system route is carried by a VPN/TUN; node selection and repair remain outside Machine Bridge",
    managed_job_accepted_then_later_tools_blocked: "job continues independently; inspect with local CLI or a later read_job call",
    relay_result_recovery_occupied: "runtime.relay_result_recovery.retained_results counts completed in-memory results still awaiting Worker acknowledgement; they consume bounded relay recovery ownership capacity but expose no result content or call identity",
    relay_automatic_redelivery_safety: "runtime.relay_result_recovery.automatic_redelivery_safe=false means at least one resumed call has lost completed-result ownership proof or bounded replay-safety evidence has escalated to global fail-closed mode; inspect unsafe_call_tombstones and global_redelivery_disabled. Per-call tombstones block transparent replay only for affected IDs, while global_redelivery_disabled=true blocks all missing-id automatic redelivery rather than risking duplicate side effects",
    resource_admission_snapshot_busy: "snapshot_available=false with reason=coordinator_busy means the bounded diagnostic could not acquire a live coordinator transaction/staging lock; retry later and do not infer corruption or a Green pressure state from that unavailable snapshot",
    resource_waiter_diagnostics: "owner-visible waiter diagnostics report bounded pre-spawn resource requests and the current admission reason; a long waiter is not a managed-job execution timeout and does not justify shortening the user task",
    managed_job_inventory_priority: "list_jobs prioritizes unreadable, active, and staged recovery state ahead of terminal history so short helper churn cannot hide a recoverable long-running job",
    security_audit_recent_activity: "owner-visible security_audit.recent_activity aggregates content-free hash-chained relay tool terminal events that reached the daemon. dispatch_intents_last_15m counts durable pre-dispatch intents separately so ordinary call counts are not doubled; unsettled_dispatch_intents_last_15m means a retained intent has no matching retained terminal audit event and does not prove that the handler started or whether any side effect completed. unknown_effect_settlements_last_15m and pending_effect_settlements_last_15m describe settlement state when terminal events were recorded; they are not a live queue of still-unsettled effects. For current local process termination, compare runtime.processes.terminating_processes and termination_escalations_pending. Host-only schema discovery, control-plane actions, and final-response delivery do not reach this audit, so its count is not the total host event count and it does not observe ChatGPT host turn termination or final response receipt",
    system_sleep_history: "on macOS, runtime.system_sleep is a bounded fixed pmset projection of recent sleep intervals. event_loop_pause_analysis=matched_system_sleep means the runtime pause ended with a same-duration operating-system sleep interval; it is evidence of machine suspension rather than proof that JavaScript synchronously blocked the event loop",
    relay_outage_sleep_correlation: "runtime.relay_outage_analysis compares the most recently recovered relay disconnect interval with bounded macOS sleep history. majority_system_sleep_overlap means most of the observed outage occurred while the machine was suspended. wake_boundary_system_sleep_aftermath means the socket failure was first observed just after wake and the same sleep independently matches the runtime event-loop pause in both end time and duration; either classification makes the reset transport aftermath rather than sufficient evidence of an independent network root cause",
    idle_sleep_guard_timeline: "runtime.idle_sleep_guard exposes only coarse activity/release timestamps and release reason so a later sleep can be compared with Machine Bridge power-assertion ownership without exposing tool arguments or host conversation identity",
  };
}

export function diagnosticActivityProjection(controlPlaneState = {}, resourceAdmission, managedJobs, context = {}) {
  const activityVisible = runtimeActivityVisible(context);
  return {
    activityVisible,
    state: {
      ...controlPlaneState,
      securityAudit: publicSecurityAudit(controlPlaneState.securityAudit, activityVisible),
      managedJobs,
      resourceAdmission: projectResourceAdmission(resourceAdmission, activityVisible),
    },
  };
}

function projectResourceAdmission(snapshot, activityVisible) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || activityVisible) return snapshot;
  const waiters = snapshot.waiters && typeof snapshot.waiters === "object" && !Array.isArray(snapshot.waiters)
    ? snapshot.waiters : null;
  if (!waiters) return snapshot;
  const { diagnostics: _diagnostics, ...publicWaiters } = waiters;
  return { ...snapshot, waiters: publicWaiters };
}
export const RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS = 30_000;

export async function diagnoseRuntime({
  policy,
  runtimeDir,
  workspace,
  runFixedInternal,
  probeShell,
  managedJobManager,
  runtimeNodeOptions = {},
  resourceCoordinatorSnapshot = null,
  relayStatus = () => null,
  controlPlaneState = {},
  throwIfCancelled,
}, context = {}) {
  throwIfCancelled(context);
  const checks = [{
    layer: "mcp-host-to-daemon",
    ok: true,
    detail: "This diagnostic request reached the local Machine Bridge runtime.",
  }, {
    layer: "machine-bridge-policy",
    ok: policy.execMode === "direct" || policy.execMode === "shell",
    detail: `profile=${policy.profile}; exec_mode=${policy.execMode}; unrestricted_paths=${policy.unrestrictedPaths}`,
  }];
  const runtimeNode = resolveRuntimeNodeExecutable(runtimeNodeOptions);
  checks.push(runtimeNodeExecutableCheck(runtimeNode));
  if (process.platform === "darwin") {
    checks.push(await macosNativeToolchainCheck({ runFixedInternal, context }));
  }
  const relay = typeof relayStatus === "function" ? relayStatus() : null;
  checks.push(relay ? {
    layer: "remote-relay",
    ok: relay.ready === true,
    network_route: relay.network_route || "unknown",
    network_route_scope: relay.network_route_scope || "unknown",
    outage_active: relay.outage_active === true,
    outage_count: Number(relay.outage_count) || 0,
    last_close_category: relay.last_close_category || null,
    last_close_code: Number.isFinite(Number(relay.last_close_code)) ? Number(relay.last_close_code) : null,
    last_transport_error_class: relay.last_transport_error_class || null,
    last_disconnected_at: relay.last_disconnected_at || null,
    last_ready_at: relay.last_ready_at || null, last_ready_duration_ms: Number(relay.last_ready_duration_ms) || 0,
    https_fallback_last_takeover_ms: Number(relay.https_fallback_last_takeover_ms) || 0, https_fallback_last_takeover_outage_number: Number(relay.https_fallback_last_takeover_outage_number) || 0, next_reconnect_in_ms: Number(relay.next_reconnect_in_ms) || 0,
    heartbeat: relay.heartbeat || null,
  } : {
    layer: "remote-relay", ok: false, skipped: true, transport: "stdio-or-local",
  });
  checks.push(await systemNetworkRouteCheck({ runFixedInternal, classifyError: classifyOperationalError, context }));
  const probe = join(runtimeDir, `.diagnostic-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "ok\n", { mode: 0o600, flag: "wx" });
    const { buffer } = await readBoundedFile(probe, 64, "diagnostic file");
    checks.push({ layer: "local-filesystem", ok: buffer.toString("utf8") === "ok\n", error_class: null });
  } catch (error) {
    checks.push({ layer: "local-filesystem", ok: false, error_class: classifyOperationalError(error) });
  } finally {
    await rm(probe, { force: true }).catch(() => { /* Diagnostic scratch cleanup cannot change the already-observed probe result. */ });
  }
  if (policy.execMode === "direct" || policy.execMode === "shell") {
    checks.push(await runtimeNodeProcessCheck({
      runtimeNode, runFixedInternal, timeoutMs: RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS,
      context, workspace, classifyError: classifyOperationalError,
    }));
  } else {
    checks.push({ layer: "local-process-spawn", ok: false, skipped: true, error_class: "policy_denied" });
  }
  if (policy.execMode === "shell") {
    const result = await probeShell(context, RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS)
      .catch((error) => ({ code: 127, error_class: classifyOperationalError(error) }));
    checks.push({
      layer: "local-shell",
      ok: result.code === 0,
      error_class: result.error_class || (result.code === 0 ? null : classifyOperationalError(result.stderr || result.stdout || "execution failed")),
    });
  } else {
    checks.push({ layer: "local-shell", ok: false, skipped: true, error_class: "policy_denied" });
  }
  const admissionDiagnostic = await resourceAdmissionDiagnostic(resourceCoordinatorSnapshot, classifyOperationalError);
  if (admissionDiagnostic.check) checks.push(admissionDiagnostic.check);
  const sleepDiagnostic = policy.execMode === "shell"
    ? await systemSleepDiagnostic({ runFixedInternal, context, workspace })
    : { snapshot: { supported: process.platform === "darwin", available: false, source: null, recent_sleep_intervals: [] }, check: { layer: "system-sleep-history", ok: false, skipped: true, error_class: "policy_denied" } };
  checks.push(sleepDiagnostic.check, { layer: "managed-job-storage", ...managedJobManager.diagnoseStorage() });
  const managedJobs = typeof managedJobManager.status === "function" ? managedJobManager.status(context) : null;
  const activity = diagnosticActivityProjection(controlPlaneState, admissionDiagnostic.snapshot, managedJobs, context);
  activity.state.systemSleep = sleepDiagnostic.snapshot;
  activity.state.eventLoopPauseAnalysis = correlateEventLoopStallWithSystemSleep(relay, sleepDiagnostic.snapshot); activity.state.relayOutageAnalysis = correlateRelayOutageWithSystemSleep(relay, sleepDiagnostic.snapshot);
  const resources = managedJobManager.listResources();
  checks.push({
    layer: "local-resource-registry",
    ok: resources.resources.every((resource) => resource.available),
    registered: resources.count,
    unavailable: resources.resources
      .filter((resource) => !resource.available)
      .map((resource) => ({ name: resource.name, error_class: resource.error_class })),
  });
  return {
    request_reached_local_runtime: true,
    interpretation: diagnosticInterpretation(),
    policy,
    ...diagnosticControlPlaneState(activity.state, relay),
    checks,
    ok: checks.filter((check) => !check.skipped).every((check) => check.ok),
  };
}

/**
 * The optional macOS background-input backend compiles a Swift helper on first use. Without
 * the Command Line Tools that first click fails deep inside the helper, which reads as a
 * product bug; report the prerequisite here instead.
 */
async function macosNativeToolchainCheck({ runFixedInternal, context }) {
  try {
    const result = await runFixedInternal("/usr/bin/xcrun", ["--find", "swiftc"], 5_000, true, 64 * 1024, context);
    const available = result?.code === 0 && String(result?.stdout || "").trim().length > 0;
    // The helper is optional (only the opt-in SkyLight backend needs it), so a missing
    // toolchain is reported as an unavailable capability, not a failed runtime.
    return {
      layer: "macos-native-toolchain",
      ok: true,
      available,
      detail: available
        ? "xcrun swiftc is available for the optional macOS background-input helper"
        : "xcrun swiftc is unavailable; install Xcode Command Line Tools to enable the macOS background-input helper",
    };
  } catch (error) {
    return { layer: "macos-native-toolchain", ok: true, available: false, error_class: classifyOperationalError(error) };
  }
}
const APPLICATION_TOOLS = ["list_local_applications", "open_local_application", "inspect_local_application", "operate_local_application"];

export async function sessionBootstrap({
  agentContextManager,
  appAutomationManager,
  capabilityObserver,
  policy,
  availableTools = null,
}, args = {}, context = {}) {
  const bootstrap = await agentContextManager.sessionBootstrap(args, context);
  const availableNames = availableToolSet(availableTools);
  const allows = (name) => availableNames ? availableNames.has(name) : policyAllowsTool(policy, name);
  const browserAllowed = availableNames ? availableNames.has("browser_status") : policyAllowsTool(policy, "browser_status");
  bootstrap.local_automation = {
    applications: allows("list_local_applications") ? projectApplicationCapabilities(appAutomationManager.capabilities(), allows) : null,
    browser: browserAllowed ? {
      existing_profile: true,
      extension_bridge: true,
      status_tool: "browser_status",
    } : null,
  };
  capabilityObserver.recordBootstrap(bootstrap);
  return bootstrap;
}

export async function resolveTaskCapabilities({
  agentContextManager,
  appAutomationManager,
  capabilityObserver,
  policy,
  availableTools = null,
}, args = {}, context = {}) {
  const result = await agentContextManager.resolveTaskCapabilities(args, context);
  const task = String(args.task || "");
  const availableNames = availableToolSet(availableTools);
  const allows = (name) => availableNames ? availableNames.has(name) : policyAllowsTool(policy, name);
  const browserAllowed = availableNames ? availableNames.has("browser_status") : policyAllowsTool(policy, "browser_status");
  if (allows("list_local_applications")) {
    let applications;
    try {
      applications = await appAutomationManager.listApplications({ query: "", max_results: 500 }, context);
    } catch (error) {
      applications = { applications: [], warnings: [{ error_class: classifyOperationalError(error) }], truncated: false };
    }
    result.application_discovery = {
      available: !(applications.warnings?.length),
      warning_count: applications.warnings?.length ?? 0,
      truncated: applications.truncated === true,
      ...(applications.warnings?.[0]?.error_class ? { error_class: applications.warnings[0].error_class } : {}),
    };
    const lower = task.toLowerCase();
    result.application_matches = applications.applications
      .map((application) => ({ application, score: applicationMatchScore(lower, application) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.application.name.localeCompare(right.application.name))
      .slice(0, 20)
      .map(({ application, score }) => ({ ...application, score }));
  } else {
    result.application_matches = [];
    result.application_discovery = {
      available: false, warning_count: 0, truncated: false,
      reason: availableNames ? "effective_authority" : "effective_policy",
    };
  }
  if (result.application_matches.length) {
    const applicationTools = APPLICATION_TOOLS.filter((tool) => !availableNames || availableNames.has(tool));
    result.recommended_tools = [...new Set([...result.recommended_tools, ...applicationTools])];
  }
  result.browser_backend = browserAllowed
    ? { tool: "browser_status", existing_profile: true, extension_bridge: true }
    : null;
  const routing = buildExecutionRouting(task, {
    policy,
    availableTools,
    seedTools: result.recommended_tools,
    commandRelevant: (result.command_matches?.[0]?.score || 0) >= 3,
    managedJobCommandMatch: result.command_matches?.[0]?.execution_mode === "managed_job"
      && Number(result.command_matches[0].score || 0) >= 3 ? result.command_matches[0] : null,
    skillRelevant: (result.skill_matches?.[0]?.score || 0) >= 3,
    applicationMatches: result.application_matches,
    browserAvailable: browserAllowed,
  });
  result.execution_routing = routing;
  result.recommended_tools = routing.recommended_tools;
  result.routing_observability = "Call server_info or project_overview to verify that bootstrap and task capability resolution reached the local runtime. Routing is advisory and cannot expand the effective authority; direct shell is available only when that authority exposes it.";
  capabilityObserver.recordResolution(task, result);
  return result;
}

function availableToolSet(value) { if (value === null || value === undefined) return null; if (!Array.isArray(value) && !(value instanceof Set)) throw new TypeError("availableTools must be an array or set"); return new Set([...value].map((tool) => String(tool || "")).filter(Boolean)); }
export const DEVICE_SESSION_RENEW_BEFORE_MS = 10 * 60_000;

export const DEVICE_SESSION_RETRY_MS = Object.freeze([1_000, 5_000, 30_000, 5 * 60_000]);

export class RuntimeDeviceSession {
  constructor({ identity, renew = null, onRotated = null, logger = {}, scheduler = { setTimeout, clearTimeout }, wallNow = Date.now } = {}) {
    this.renew = typeof renew === "function" ? renew : null;
    this.onRotated = typeof onRotated === "function" ? onRotated : () => {};
    this.logger = logger;
    this.scheduler = scheduler;
    this.wallNow = wallNow;
    this.identity = validateDeviceSessionIdentity(identity, this.wallNow());
    this.timer = null;
    this.started = false;
    this.generation = 1;
    this.failureCount = 0;
    this.lastRotatedAt = 0;
    this.lastErrorClass = "";
    this.renewalDueAt = 0;
  }

  current() {
    const now = this.wallNow();
    const retryDue = this.renewalDueAt || this.renewAt();
    if (this.renew && now >= this.renewAt() && now >= retryDue) this.rotate("authentication_boundary", false);
    return this.identity;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduleRenewal();
  }

  stop() {
    this.started = false;
    this.clearTimer();
  }

  snapshot() {
    const expiresAt = sessionExpiresAt(this.identity);
    return {
      renewable: Boolean(this.renew), automatic_renewal: Boolean(this.renew), session_generation: this.generation,
      expires_at: new Date(expiresAt).toISOString(),
      renewal_due_at: this.renew ? new Date(this.renewalDueAt || this.renewAt()).toISOString() : null,
      last_rotated_at: this.lastRotatedAt ? new Date(this.lastRotatedAt).toISOString() : null,
      renewal_failure_count: this.failureCount, last_renewal_error_class: this.lastErrorClass || null,
    };
  }

  rotate(reason = "scheduled", notify = true) {
    if (!this.renew) return false;
    try {
      const next = this.renew(this.wallNow());
      if (next && typeof next.then === "function") throw new TypeError("device session renewal must be synchronous");
      this.identity = validateDeviceSessionIdentity(next, this.wallNow());
      this.generation += 1;
      this.lastRotatedAt = this.wallNow();
      this.failureCount = 0;
      this.lastErrorClass = "";
      this.logger.event?.("info", "runtime.device_session.rotated", { generation: this.generation, reason }, "Runtime device session rotated");
      if (this.started) {
        this.scheduleRenewal();
        if (notify) this.onRotated({ generation: this.generation, reason });
      }
      return true;
    } catch (error) {
      this.failureCount += 1;
      this.lastErrorClass = classifyOperationalError(error);
      this.logger.event?.("warn", "runtime.device_session.renewal_failed", {
        error_class: this.lastErrorClass, failure_count: this.failureCount,
      }, "Runtime device session renewal failed");
      if (this.started) this.scheduleRetry();
      return false;
    }
  }

  renewAt() { return Math.max(0, sessionExpiresAt(this.identity) - DEVICE_SESSION_RENEW_BEFORE_MS); }

  scheduleRenewal() {
    this.clearTimer();
    if (!this.started || !this.renew) { this.renewalDueAt = 0; return; }
    this.renewalDueAt = this.renewAt();
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.rotate("scheduled"); }, Math.max(0, this.renewalDueAt - this.wallNow()));
    this.timer?.unref?.();
  }

  scheduleRetry() {
    this.clearTimer();
    if (!this.started || !this.renew) return;
    const index = Math.min(Math.max(0, this.failureCount - 1), DEVICE_SESSION_RETRY_MS.length - 1);
    const delay = DEVICE_SESSION_RETRY_MS[index];
    this.renewalDueAt = this.wallNow() + delay;
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.rotate("retry"); }, delay);
    this.timer?.unref?.();
  }

  clearTimer() {
    if (!this.timer) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

function sessionExpiresAt(identity) {
  const seconds = Number(identity?.certificate?.expires_at);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("device session expiry is invalid");
  return seconds * 1000;
}
function usesDurableProcessDelivery(args, context = {}) {
  return context.origin === "relay" || args?.idempotency_key !== undefined;
}

export async function runRuntimeDirectProcess(runtime, args, context = {}) {
  runtime.processExecutionService.policyGate.assert("run_process");
  const managedCommand = await runtime.agentContextManager.managedJobCommandForDirectInvocation(args, context);
  if (managedCommand) throw managedJobOnlyCarrierError(managedCommand);
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runDirect(args, context);
  }
  const prepared = await prepareDurableDirectProcess(runtime.processExecutionService, args, context);
  const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
  return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
}

export async function runRuntimeLocalCommand(runtime, args, context = {}) {
  runtime.processExecutionService.policyGate.assert("run_local_command");
  const managedCommand = await runtime.agentContextManager.managedJobCommandForLocalInvocation(args, context);
  if (managedCommand) throw managedJobOnlyCarrierError(managedCommand);
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runRegistered(args, context);
  }
  const prepared = await prepareDurableRegisteredProcess(runtime.processExecutionService, args, context);
  const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
  return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
}

export async function runRuntimeExecCommand(runtime, args, context = {}) {
  if (usesDurableProcessDelivery(args, context)) {
    const prepared = prepareDurableShellProcess(runtime.processExecutionService, args, context);
    const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
    return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
  }
  return runtime.processExecutionService.runShell(args.command, args.timeout_seconds, context);
}

function managedJobOnlyCarrierError(command) {
  return new BridgeError("invalid_request", `registered command '${command.name}' requires start_job; run_process and run_local_command intentionally refuse execution_mode=managed_job commands`, {
    retryable: false,
    details: { side_effects_started: false, required_tool: "start_job", registered_command: command.name, managed_job_timeout_seconds: command.managedJobTimeoutSeconds },
  });
}
export function createRuntimeAppAutomationManager(runtime, applicationAutomation, runProcess, readResourceText) {
  const { backgroundVisualBackend, backgroundInputService } = applicationBackgroundInputConfiguration(
    applicationAutomation, runProcess, runtime.runtimeDir, { stateRoot: runtime.stateRoot },
  );
  return new AppAutomationManager({
    ...applicationAutomation,
    backgroundVisualBackend,
    backgroundInputService,
    policy: runtime.policy,
    authorizeTool: (tool) => runtime.policyGate.assert(tool),
    displayPath: (value, context) => runtime.displayPath(value, context),
    projectCapabilities: (capabilities, context) => projectRuntimeApplicationCapabilities(runtime, capabilities, context),
    runProcess,
    readResourceText,
    throwIfCancelled: (context) => runtime.throwIfCancelled(context),
  });
}

function projectRuntimeApplicationCapabilities(runtime, capabilities, context) {
  const available = new Set(runtime.effectiveToolNames(context));
  return projectApplicationCapabilities(capabilities, (tool) => available.has(tool));
}
