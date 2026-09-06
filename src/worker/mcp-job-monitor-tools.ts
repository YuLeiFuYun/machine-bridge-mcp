import type { AuthorizedToken } from "./access.ts";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "./errors.ts";
import { verifyManagedJobCapability } from "./managed-job-capability.ts";
import { activateManagedJobMonitor, JOB_MONITOR_ID_PATTERN, type ManagedJobMonitorClaimStore, refreshManagedJobMonitorClaim, validManagedJobMonitorId } from "./mcp-job-monitor-claims.ts";
import { JOB_MONITOR_RESOURCE_URI } from "./mcp-job-monitor-ui.ts";
export { projectManagedJobMonitorStatus } from "./mcp-job-monitor-status.ts";

export const JOB_MONITOR_RENDER_TOOL = "render_job_monitor";
export const JOB_MONITOR_CLAIM_TOOL = "claim_job_monitor";
export const JOB_MONITOR_READ_TOOL = "read_job_monitor";
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const RECOVERY_KEY = { type: "string", pattern: "^mcp_jr_[A-Za-z0-9_-]{43}$" };
const JOB_ID_SCHEMA = { type: "string", pattern: "^job_[A-Za-z0-9_-]{24,}$" };

export function managedJobMonitorRenderToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_RENDER_TOOL,
    title: "Render managed job monitor",
    description: "Optionally render the durable-job monitor after an active start_job reports ui_monitor_candidate=true, but only when the current assistant task can deliberately transfer this job's status polling without needing its terminal result for remaining same-response work. If the current task still depends on the job result, do not render the monitor; preserve job_id plus recovery_key and continue server-paced read_job follow-up instead. When intentionally rendering, pass the exact job_id, recovery_key, and ui_monitor_id already returned by start_job. This tool verifies existing read authority, activates that pre-issued monitor ID, and mounts UI; it does not execute, cancel, mutate the job, or transfer ownership of unrelated assistant work. Do not depend on this render tool's result being visible to the planner. Immediately call read_job once with the same pre-issued ui_monitor_id to confirm whether the View claimed polling ownership. A successful claim stops duplicate model-side polling of this job only. For an ordinary job it is not by itself a reason to end the assistant response. For an explicitly persisted task_supervisor, only a later read_job that proves the current claim and reports host_turn_handoff_recommended=true permits host-turn handoff because the supervisor job already owns all remaining noninteractive task work; the monitor itself still has no execution authority.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN }, ui_monitor_claim_required: { type: "boolean" }, follow_up_read_required: { type: "boolean" } }, required: ["job_id", "ui_monitor_id", "ui_monitor_claim_required", "follow_up_read_required"], additionalProperties: true },
    _meta: {
      ui: { resourceUri: JOB_MONITOR_RESOURCE_URI, visibility: ["model"] },
      "ui/resourceUri": JOB_MONITOR_RESOURCE_URI,
      "openai/outputTemplate": JOB_MONITOR_RESOURCE_URI,
    },
  };
}

export function managedJobMonitorClaimToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_CLAIM_TOOL,
    title: "Claim managed job monitor",
    description: "App-only lifecycle handshake proving that one mounted managed-job monitor instance can call server tools. It validates the existing hosted read capability plus render-instance ID and records only a short-lived continuation claim; it does not execute or mutate the managed job.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  };
}

export function managedJobMonitorReadToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_READ_TOOL,
    title: "Read managed job monitor status",
    description: `App-only status continuation for the latest claimed durable managed-job monitor. It verifies the original principal-bound recovery capability, requires the non-authority monitor correlation ID to identify the latest claimed View, refreshes its short-lived handoff-freshness lease, and performs one fixed ${Number(relayContract.defaultManagedJobReadWaitMs) / 1000}-second server-paced read of the underlying job. Its response is a privacy-bounded status projection and never includes step output, command text, paths, or recovery/control capabilities. A still-latest View may resume after that freshness lease elapsed; issuing a replacement monitor retires the older View. The View may retry a transient failed read with the same capability; it never resubmits the managed job itself.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, status: { type: "string" }, current_phase: { type: "string" }, current_step: { type: "integer", minimum: 0 }, dependency_total: { type: "integer", minimum: 0 }, dependency_pending_count: { type: "integer", minimum: 0 }, finished_at: { type: "string" }, error_class: { type: "string" } }, required: ["job_id", "status"], additionalProperties: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  };
}

export async function renderManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  if (!jobId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!monitorId || !await activateManagedJobMonitor(store, jobId, monitorId, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor ID was not issued for this active start_job", false, { side_effects_started: false });
  }
  return {
    $mcpText: "",
    job_id: jobId,
    ui_monitor_id: monitorId,
    ui_monitor_claim_required: true,
    follow_up_read_required: true,
  };
}

export async function managedJobMonitorReadDaemonArguments(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  if (!jobId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  if (!validManagedJobMonitorId(args.ui_monitor_id)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor correlation ID is invalid", false, { side_effects_started: false });
  }
  if (!await refreshManagedJobMonitorClaim(store, jobId, args.ui_monitor_id, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor claim is not current", false, { side_effects_started: false });
  }
  return { job_id: jobId, wait_ms: Number(relayContract.defaultManagedJobReadWaitMs) };
}
