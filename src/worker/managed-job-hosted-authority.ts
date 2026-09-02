import type { AuthorizedToken } from "./access.ts";
import { WorkerToolError } from "./errors.ts";
import { isRemoteDurableProcessTool } from "./tool-timeout.ts";
import { issueManagedJobCapability, verifyManagedJobCapability } from "./managed-job-capability.ts";
import { projectManagedJobMonitorHandoff, supportsManagedJobMonitor } from "./mcp-job-monitor-ui.ts";
import { JOB_MONITOR_RENDER_TOOL } from "./mcp-job-monitor-tools.ts";
import { issueManagedJobMonitor } from "./mcp-job-monitor-claims.ts";

const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const ISSUANCE_TOOLS = new Set(["stage_job", "start_job"]);

export async function hostedManagedJobDaemonArguments(
  name: string,
  args: Record<string, unknown>,
  authorized: AuthorizedToken,
  keyMaterial: string,
): Promise<Record<string, unknown>> {
  const projected = { ...args };
  if (name === "read_job") {
    await requireCapability(projected.job_id, projected.recovery_key, "read", authorized, keyMaterial);
    delete projected.recovery_key;
    delete projected.ui_monitor_id;
  } else if (name === "cancel_job") {
    await requireCapability(projected.job_id, projected.control_key, "control", authorized, keyMaterial);
    delete projected.control_key;
  }
  if (name === "stage_job" || name === "start_job") {
    await verifyDependencies(projected, authorized, keyMaterial);
    delete projected.dependency_recovery;
  }
  return projected;
}

export async function projectHostedManagedJobResult(
  name: string,
  value: unknown,
  authorized: AuthorizedToken,
  keyMaterial: string,
  options: { clientCapabilities?: unknown; uiMonitorClaimed?: boolean; uiMonitorScope?: object } = {},
): Promise<unknown> {
  if (name === "list_jobs") return aggregateHostedManagedJobInventory(value);
  if (name === "read_job") return projectManagedJobMonitorHandoff(value, options.uiMonitorClaimed === true);
  if (!ISSUANCE_TOOLS.has(name) && !isRemoteDurableProcessTool(name)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const jobId = typeof result.job_id === "string" && JOB_ID.test(result.job_id) ? result.job_id : "";
  if (!jobId) return value;
  const [recoveryKey, controlKey] = await Promise.all([
    issueManagedJobCapability(keyMaterial, authorized, jobId, "read"),
    issueManagedJobCapability(keyMaterial, authorized, jobId, "control"),
  ]);
  const recovery = result.recovery && typeof result.recovery === "object" && !Array.isArray(result.recovery)
    ? result.recovery as Record<string, unknown>
    : { tool: "read_job", job_id: jobId };
  const projected = {
    ...result,
    recovery_key: recoveryKey,
    control_key: controlKey,
    recovery: { ...recovery, recovery_key: recoveryKey, control_key: controlKey },
  };
  if (name !== "start_job" || result.follow_up_read_required !== true || !supportsManagedJobMonitor(options.clientCapabilities)
    || !options.uiMonitorScope) return projected;
  const monitorId = issueManagedJobMonitor(options.uiMonitorScope, jobId, authorized);
  return {
    ...projected,
    ui_monitor_id: monitorId,
    ui_monitor_candidate: true,
    ui_monitor_claim_required: true,
    completion_delivery: "mcp_app_job_monitor_pending_claim",
    ui_monitor_render_tool: JOB_MONITOR_RENDER_TOOL,
  };
}

async function requireCapability(
  jobId: unknown,
  capability: unknown,
  purpose: "read" | "control",
  authorized: AuthorizedToken,
  keyMaterial: string,
): Promise<void> {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)
    || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, purpose, capability)) {
    throw new WorkerToolError("authorization_denied", "managed-job recovery authority is invalid", false, { side_effects_started: false });
  }
}

async function verifyDependencies(
  args: Record<string, unknown>,
  authorized: AuthorizedToken,
  keyMaterial: string,
): Promise<void> {
  const dependencies = Array.isArray(args.depends_on) ? args.depends_on.map(String) : [];
  if (!dependencies.length) return;
  const recovery = args.dependency_recovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    throw new WorkerToolError("invalid_request", "dependency_recovery is required for hosted managed-job dependencies", false, { side_effects_started: false });
  }
  const keys = Object.keys(recovery);
  if (keys.length !== dependencies.length || keys.some((jobId) => !dependencies.includes(jobId))) {
    throw new WorkerToolError("invalid_request", "dependency_recovery must contain exactly one recovery key for every depends_on job", false, { side_effects_started: false });
  }
  for (const jobId of dependencies) {
    await requireCapability(jobId, (recovery as Record<string, unknown>)[jobId], "read", authorized, keyMaterial);
  }
}

function aggregateHostedManagedJobInventory(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return {
    jobs: [],
    recent_process_recovery: [],
    retained: finiteInteger(source.retained),
    maximum: finiteInteger(source.maximum),
    ...(source.capacity && typeof source.capacity === "object" && !Array.isArray(source.capacity) ? { capacity: source.capacity } : {}),
    ...(source.recent_activity && typeof source.recent_activity === "object" && !Array.isArray(source.recent_activity) ? { recent_activity: source.recent_activity } : {}),
    status_polling_mode: "inventory",
    hosted_inventory_scope: "aggregate_only",
    known_job_recovery_requires_capability: true,
  };
}

function finiteInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
