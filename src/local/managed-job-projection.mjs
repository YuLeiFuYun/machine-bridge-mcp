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
 * Project owner-only managed-job timing out of delegated result reads.
 * @param {Record<string, unknown> | null | undefined} result
 * @param {{includeResourceAdmissionTiming?: boolean}} [options]
 */
export function projectManagedJobResult(result, { includeResourceAdmissionTiming = false } = {}) {
  if (!result || includeResourceAdmissionTiming) return result;
  const projectSteps = (/** @type {unknown} */ steps) => Array.isArray(steps) ? steps.map((/** @type {unknown} */ step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const { resource_admission_ms: _resourceAdmissionMs, ...projected } = /** @type {Record<string, unknown>} */ (step);
    return projected;
  }) : steps;
  return { ...result, steps: projectSteps(result.steps), finally_steps: projectSteps(result.finally_steps) };
}

/**
 * Return the stable public status shape without runner identity or internal paths.
 * @param {{job_id?: unknown, name?: unknown, status?: unknown, created_at?: unknown, started_at?: unknown,
 * finished_at?: unknown, current_phase?: unknown, current_step?: unknown, approval?: unknown, plan_sha256?: unknown,
 * cleanup_guarantee?: unknown, error_class?: unknown, recovery_attempts?: unknown, result_persisted?: unknown,
 * terminal_record_error_class?: unknown, artifact_cleanup_pending?: unknown, artifact_cleanup_error_class?: unknown}} status
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
    result_persisted: typeof status.result_persisted === "boolean" ? status.result_persisted : null,
    terminal_record_error_class: status.terminal_record_error_class ?? null,
    artifact_cleanup_pending: status.artifact_cleanup_pending === true,
    artifact_cleanup_error_class: status.artifact_cleanup_error_class ?? null,
  };
}
