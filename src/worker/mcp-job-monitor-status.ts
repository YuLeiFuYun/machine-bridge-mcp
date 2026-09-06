import { WorkerToolError } from "./errors.ts";

const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

export function projectManagedJobMonitorStatus(value: unknown, expectedJobId: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStatus();
  const source = value as Record<string, unknown>;
  const jobId = typeof source.job_id === "string" && JOB_ID.test(source.job_id) ? source.job_id : "";
  const status = token(source.status);
  if (!jobId || jobId !== expectedJobId || !status) throw invalidStatus();
  const projected: Record<string, unknown> = { job_id: jobId, status };
  const phase = token(source.current_phase); if (phase) projected.current_phase = phase;
  if (nonnegativeInteger(source.current_step)) projected.current_step = source.current_step;
  if (nonnegativeInteger(source.dependency_total)) projected.dependency_total = source.dependency_total;
  if (nonnegativeInteger(source.dependency_pending_count)) projected.dependency_pending_count = source.dependency_pending_count;
  if (timestamp(source.finished_at)) projected.finished_at = source.finished_at;
  const errorClass = token(source.error_class); if (errorClass) projected.error_class = errorClass;
  return projected;
}

function token(value: unknown): string { return typeof value === "string" && TOKEN.test(value) ? value : ""; }
function nonnegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function boundedString(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length <= maximum; }
function timestamp(value: unknown): value is string { return boundedString(value, 64) && Number.isFinite(Date.parse(value)); }
function invalidStatus(): WorkerToolError {
  return new WorkerToolError("execution_failed", "managed-job monitor status is unavailable", true, { side_effects_started: false });
}
