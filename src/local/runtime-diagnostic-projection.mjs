import { publicSecurityAudit, runtimeActivityVisible } from "./runtime-activity-projection.mjs";

export function diagnosticInterpretation() {
  return {
    current_request_delivery: "confirmed: this diagnose_runtime request reached the local runtime; this evidence does not support a blanket current platform disable of Machine Bridge",
    tool_call_blocked_before_response: "not observable by Machine Bridge; possible causes include conversation/surface app routing state, a stale host action/tool snapshot, host tool filtering, connector gateway, client routing, or platform policy; do not attribute one without host-side evidence",
    diagnostic_reached_daemon_but_spawn_failed: "the fixed local spawn/shell probes bypass cooperative resource admission, so a true probe failure points to the local OS, endpoint security, shell configuration, or Machine Bridge policy; a child exit code or bounded stdout/stderr instead proves spawn succeeded and the nested command or remote target decided the failure",
    system_network_stack_scope: "application proxy selection only; an operating-system VPN or TUN may still intercept the relay connection",
    tunnel_default_route_detected: "the operating-system route is carried by a VPN/TUN; node selection and repair remain outside Machine Bridge",
    managed_job_accepted_then_later_tools_blocked: "job continues independently; inspect with local CLI or a later read_job call",
    relay_result_recovery_occupied: "runtime.relay_result_recovery.retained_results counts completed in-memory results still awaiting Worker acknowledgement; they consume bounded relay recovery ownership capacity but expose no result content or call identity",
    relay_automatic_redelivery_safety: "runtime.relay_result_recovery.automatic_redelivery_safe=false means at least one resumed call has lost completed-result ownership proof or bounded replay-safety evidence has escalated to global fail-closed mode; inspect unsafe_call_tombstones and global_redelivery_disabled. Per-call tombstones block transparent replay only for affected IDs, while global_redelivery_disabled=true blocks all missing-id automatic redelivery rather than risking duplicate side effects",
    resource_admission_snapshot_busy: "snapshot_available=false with reason=coordinator_busy means the bounded diagnostic could not acquire a live coordinator transaction/staging lock; retry later and do not infer corruption or a Green pressure state from that unavailable snapshot",
    resource_waiter_diagnostics: "owner-visible waiter diagnostics report bounded pre-spawn resource requests and the current admission reason; a long waiter is not a managed-job execution timeout and does not justify shortening the user task",
    managed_job_inventory_priority: "list_jobs prioritizes unreadable, active, and staged recovery state ahead of terminal history so short helper churn cannot hide a recoverable long-running job",
    security_audit_recent_activity: "owner-visible security_audit.recent_activity aggregates content-free hash-chained relay tool events that reached the daemon. Host-only schema discovery, control-plane actions, and final-response delivery do not reach this audit, so its count is not the total host event count and it does not observe ChatGPT host turn termination or final response receipt",
    system_sleep_history: "on macOS, runtime.system_sleep is a bounded fixed pmset projection of recent sleep intervals. event_loop_pause_analysis=matched_system_sleep means the runtime pause ended with a same-duration operating-system sleep interval; it is evidence of machine suspension rather than proof that JavaScript synchronously blocked the event loop",
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
