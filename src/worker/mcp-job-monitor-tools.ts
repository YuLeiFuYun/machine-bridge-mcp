import type { AuthorizedToken } from "./access.ts";
import { WorkerToolError } from "./errors.ts";
import { verifyManagedJobCapability } from "./managed-job-capability.ts";
import { activateManagedJobMonitor, JOB_MONITOR_ID_PATTERN, validManagedJobMonitorId } from "./mcp-job-monitor-claims.ts";
import { JOB_MONITOR_RESOURCE_URI } from "./mcp-job-monitor-ui.ts";

export const JOB_MONITOR_RENDER_TOOL = "render_job_monitor";
export const JOB_MONITOR_CLAIM_TOOL = "claim_job_monitor";
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const RECOVERY_KEY = { type: "string", pattern: "^mcp_jr_[A-Za-z0-9_-]{43}$" };
const JOB_ID_SCHEMA = { type: "string", pattern: "^job_[A-Za-z0-9_-]{24,}$" };

export function managedJobMonitorRenderToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_RENDER_TOOL,
    title: "Render managed job monitor",
    description: "Render the durable-job monitor after an active start_job reports ui_monitor_candidate=true. Pass the exact job_id, recovery_key, and ui_monitor_id already returned by that start_job. This tool verifies existing read authority, activates that pre-issued monitor ID, and mounts UI; it does not execute, cancel, or mutate the job. Do not depend on this render tool's result being visible to the planner. Immediately call read_job once with the same pre-issued ui_monitor_id. Stop model-side reads only if that read reports ui_monitor_claimed=true and host_turn_handoff_recommended=true.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN }, ui_monitor_claim_required: { type: "boolean" }, follow_up_read_required: { type: "boolean" } }, required: ["job_id", "ui_monitor_id", "ui_monitor_claim_required", "follow_up_read_required"], additionalProperties: true },
    _meta: {
      ui: { resourceUri: JOB_MONITOR_RESOURCE_URI, visibility: ["model"] },
      "ui/resourceUri": JOB_MONITOR_RESOURCE_URI,
      "openai/outputTemplate": JOB_MONITOR_RESOURCE_URI,
      "openai/toolInvocation/invoking": "Opening durable job monitor…",
      "openai/toolInvocation/invoked": "Durable job monitor opened.",
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

export async function renderManagedJobMonitor(
  scope: object, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  if (!jobId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!monitorId || !activateManagedJobMonitor(scope, jobId, monitorId, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor ID was not issued for this active start_job", false, { side_effects_started: false });
  }
  return {
    $mcpText: "Durable job monitor mounted. Use the same ui_monitor_id already returned by start_job on the next read_job to confirm whether the View claimed continuation. The monitor ID is correlation only; the recovery_key remains the read authority.",
    job_id: jobId,
    ui_monitor_id: monitorId,
    ui_monitor_claim_required: true,
    follow_up_read_required: true,
  };
}
