import { managedJobDependencyCount } from "./managed-job-dependency-metadata.mjs";

export function acceptedManagedJobProjection(status, plan, { idempotencyReplay = false, idempotencyAccepted = true } = {}) {
  return {
    accepted: true,
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    detached: true,
    continues_without_mcp_connection: true,
    approval: status.approval,
    plan_sha256: status.plan_sha256,
    dependency_total: managedJobDependencyCount(status.dependency_total),
    dependency_pending_count: managedJobDependencyCount(status.dependency_pending_count),
    ...(idempotencyAccepted ? { idempotency_key_accepted: true, idempotency_replay: idempotencyReplay } : {}),
    recovery: {
      tool: "read_job",
      job_id: status.job_id,
      survives_mcp_disconnect: true,
      survives_daemon_restart: true,
      same_response_followup_supported: true,
    },
    cleanup: {
      resource_copies: "best-effort",
      finally_steps: plan.finally_steps.length ? "best-effort" : "none-declared",
      restart_recovery: "best-effort-on-runner-exit-or-next-runtime-or-cli-start",
    },
  };
}
