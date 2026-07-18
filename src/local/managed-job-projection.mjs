// @ts-check

/**
 * Return the review-safe job plan projection. Resource paths and values are absent by contract.
 * @param {{
 *   version?: unknown,
 *   name?: unknown,
 *   workspace?: unknown,
 *   full_env?: unknown,
 *   resources?: Record<string, {kind?: unknown, size?: unknown, mode?: unknown, allowInsecurePermissions?: unknown}>,
 *   temporary_files?: unknown[],
 *   steps?: unknown[],
 *   finally_steps?: unknown[]
 * }} plan
 */
export function reviewablePlan(plan) {
  return {
    version: plan.version,
    name: plan.name,
    workspace: plan.workspace,
    full_env: plan.full_env === true,
    resources: Object.fromEntries(Object.entries(plan.resources || {}).map(([name, value]) => [name, {
      kind: value.kind,
      size: value.size ?? null,
      mode: value.mode ?? null,
      allow_insecure_permissions: value.allowInsecurePermissions === true,
    }])),
    temporary_files: plan.temporary_files || [],
    steps: plan.steps || [],
    finally_steps: plan.finally_steps || [],
  };
}

/**
 * Return the stable public status shape without runner identity or internal paths.
 * @param {{
 *   job_id?: unknown,
 *   name?: unknown,
 *   status?: unknown,
 *   created_at?: unknown,
 *   started_at?: unknown,
 *   finished_at?: unknown,
 *   current_phase?: unknown,
 *   current_step?: unknown,
 *   approval?: unknown,
 *   plan_sha256?: unknown,
 *   cleanup_guarantee?: unknown,
 *   error_class?: unknown,
 *   recovery_attempts?: unknown
 * }} status
 */
export function publicStatus(status) {
  return {
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    created_at: status.created_at,
    started_at: status.started_at ?? null,
    finished_at: status.finished_at ?? null,
    current_phase: status.current_phase ?? null,
    current_step: status.current_step ?? null,
    approval: status.approval ?? null,
    plan_sha256: status.plan_sha256 ?? null,
    cleanup_guarantee: status.cleanup_guarantee ?? "best-effort-finally-and-recovery",
    error_class: status.error_class ?? null,
    recovery_attempts: Number(status.recovery_attempts || 0),
  };
}
