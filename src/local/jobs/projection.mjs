// @ts-check
import { createHash } from "node:crypto";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { clampInteger } from "../../shared/numbers.mjs";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { ACTIVE_JOB_STATES } from "./terminal-base.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";
import { managedJobDependencyCount } from "./dependencies.mjs";
import { managedJobRecoveryAttempts, managedJobRecoveryHistory, managedJobRecoveryHistoryComplete } from "./redaction.mjs";
import { redactSensitiveProcessOutput } from "../process/settlement.mjs";

/** @param {unknown} plan @returns {string} */
export function managedJobPlanSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/**
 * @param {unknown} plan
 * @param {{ plan_sha256?: unknown }} [status]
 * @param {string} [message]
 * @returns {string}
 */
export function assertManagedJobPlanIntegrity(plan, status, message = "managed job plan integrity check failed") {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error(message);
  const expected = String(status?.plan_sha256 || "");
  const actual = managedJobPlanSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error(message);
  return actual;
}
/** @param {() => any} materialize */
export function createManagedJobResourceContext(materialize) {
  let attempted = false;
  /** @type {any} */
  let value = { paths: {}, bytes: {}, redactions: {}, temporaryPaths: {} };
  /** @type {any} */
  let error = null;
  return {
    get attempted() { return attempted; },
    get value() { return value; },
    ensure() {
      if (error) throw error;
      if (attempted) return value;
      attempted = true;
      try { value = materialize(); }
      catch (cause) { error = cause; throw cause; }
      return value;
    },
  };
}
const LOCAL_MAXIMUM_WAIT_MS = 40_000;

/** @typedef {{wait_ms?: unknown}} ManagedJobReadArgs */
/** @typedef {{authority?: {origin?: unknown} | null} | null | undefined} ManagedJobReadContext */

/** @param {ManagedJobReadArgs} [args] @param {ManagedJobReadContext} [context] */
export function managedJobReadWaitMs(args = {}, context = {}) {
  const hosted = context?.authority?.origin === "relay";
  const fallback = hosted ? relayContract.defaultManagedJobReadWaitMs : 0;
  const maximum = hosted ? relayContract.maximumManagedJobReadWaitMs : LOCAL_MAXIMUM_WAIT_MS;
  return args.wait_ms === undefined ? fallback : clampInteger(args.wait_ms, fallback, 0, maximum);
}

/** @param {ManagedJobReadArgs} [args] @param {ManagedJobReadContext} [context] */
export function managedJobReadNonterminalProgressMinimumMs(args = {}, context = {}) {
  const waitMs = managedJobReadWaitMs(args, context);
  if (context?.authority?.origin !== "relay" || waitMs <= 0) return 0;
  return Math.min(waitMs, relayContract.managedJobReadNonterminalProgressMinimumMs);
}

/** @param {Record<string, unknown>} value @param {ManagedJobReadContext} [context] */
export function managedJobReadProgressSignature(value, context = {}) {
  const currentStep = context?.authority?.origin === "relay" ? null : value?.current_step;
  return JSON.stringify([
    value?.status, value?.current_phase, currentStep, value?.finished_at,
    value?.error_class, value?.recovery_attempts, value?.result_persisted,
    value?.terminal_record_error_class, value?.artifact_cleanup_pending, value?.artifact_cleanup_error_class,
    value?.dependency_total, value?.dependency_pending_count,
  ]);
}

/** @param {Record<string, unknown>} value @param {ManagedJobReadContext} context @param {number} waitedMs @param {boolean} timedOut @param {number} progressMinimumMs */
export function withHostedManagedJobReadMetadata(value, context, waitedMs, timedOut, progressMinimumMs) {
  if (context?.authority?.origin !== "relay") return value;
  return {
    ...value,
    managed_job_read_wait_ms: waitedMs,
    managed_job_read_wait_timed_out: timedOut,
    managed_job_read_nonterminal_progress_minimum_ms: progressMinimumMs,
  };
}
/**
 * Project relay-only hosted-turn polling guidance after managed-job ownership checks.
 * @param {{status?: unknown} | null | undefined} status
 * @param {{authority?: {origin?: unknown}}} [context]
 */
export function hostedManagedJobStatus(status, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  const active = ACTIVE_JOB_STATES.has(String(status?.status || ""));
  return {
    host_turn_handoff_recommended: false,
    status_polling_mode: active ? "bounded_followup" : "terminal",
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    host_turn_deadline_observable: false,
    host_terminal_receipt_observable: false,
    same_response_followup_supported: active,
    managed_job_detached_from_mcp_response: true,
  };
}

/** @param {Array<{status?: unknown}>} _jobs @param {{authority?: {origin?: unknown}}} [context] */
export function hostedManagedJobListStatus(_jobs, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  return {
    host_turn_handoff_recommended: false,
    status_polling_mode: "inventory",
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    host_turn_deadline_observable: false,
    host_terminal_receipt_observable: false,
  };
}
/**
 * @typedef {object} ManagedJobReadWaitOptions
 * @property {Record<string, unknown>} [args]
 * @property {{authority?: {origin?: unknown} | null}} [context]
 * @property {() => Promise<Record<string, unknown>>} readCurrent
 * @property {() => Promise<Record<string, unknown>>} [readProgress]
 * @property {() => void} [throwIfCancelled]
 * @property {(ms: number) => Promise<unknown>} [sleep]
 * @property {() => number} [now]
 */

/** @param {ManagedJobReadWaitOptions} options */
export async function waitForManagedJobRead({
  args = {}, context = {}, readCurrent, readProgress = readCurrent, throwIfCancelled = () => {},
  sleep = defaultSleep, now = undefined,
}) {
  throwIfCancelled();
  const waitMs = managedJobReadWaitMs(args, context);
  const nonterminalProgressMinimumMs = managedJobReadNonterminalProgressMinimumMs(args, context);
  /** @param {Record<string, unknown>} value */
  const progressSignature = (value) => managedJobReadProgressSignature(value, context);
  if (waitMs <= 0) {
    const current = await readCurrent();
    return withHostedManagedJobReadMetadata(current, context, 0, false, nonterminalProgressMinimumMs);
  }
  const deadline = createMonotonicDeadline(waitMs, now);
  let current = await readCurrent();
  const initialSignature = progressSignature(current);
  if (!ACTIVE_JOB_STATES.has(String(current?.status || ""))) {
    return withHostedManagedJobReadMetadata(current, context, 0, false, nonterminalProgressMinimumMs);
  }
  let lastReconcileElapsedMs = deadline.elapsedMs();
  let progressChanged = false;
  while (ACTIVE_JOB_STATES.has(String(current?.status || "")) && !deadline.expired()) {
    throwIfCancelled();
    await sleep(Math.min(relayContract.managedJobReadPollIntervalMs, Math.max(1, deadline.remainingMs())));
    throwIfCancelled();
    const progress = await readProgress();
    if (!ACTIVE_JOB_STATES.has(String(progress?.status || ""))) {
      current = await readCurrent();
      break;
    }
    progressChanged = progressSignature(progress) !== initialSignature;
    current = { ...current, ...progress };
    const elapsed = deadline.elapsedMs();
    if (progressChanged && elapsed >= nonterminalProgressMinimumMs) {
      current = await readCurrent();
      break;
    }
    if (elapsed - lastReconcileElapsedMs >= relayContract.managedJobReadReconcileIntervalMs) {
      current = await readCurrent();
      lastReconcileElapsedMs = deadline.elapsedMs();
      if (!ACTIVE_JOB_STATES.has(String(current?.status || ""))) break;
      progressChanged = progressSignature(current) !== initialSignature;
      if (progressChanged && lastReconcileElapsedMs >= nonterminalProgressMinimumMs) break;
    }
  }
  const timedOut = ACTIVE_JOB_STATES.has(String(current?.status || ""))
    && !progressChanged && progressSignature(current) === initialSignature && deadline.expired();
  return withHostedManagedJobReadMetadata(current, context, Math.min(waitMs, Math.round(deadline.elapsedMs())), timedOut,
    nonterminalProgressMinimumMs);
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
/**
 * Return the review-safe job plan projection. Resource paths and values are absent by contract.
 * @param {{
 *   version?: unknown,
 *   name?: unknown,
 *   continuation_mode?: unknown,
 *   isolated_worktree?: unknown,
 *   workspace?: unknown,
 *   full_env?: unknown,
 *   depends_on?: unknown[],
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
    ...(plan.continuation_mode === "task_supervisor" ? { continuation_mode: "task_supervisor" } : {}),
    isolated_worktree: plan.isolated_worktree === true,
    workspace: plan.workspace,
    full_env: plan.full_env === true,
    depends_on: Array.isArray(plan.depends_on) ? plan.depends_on : [],
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
 * Project owner-only managed-job timing out of delegated result reads,
 * and redact sensitive secrets/payloads with SRE guidance across all step outputs.
 * @param {Record<string, unknown> | null | undefined} result
 * @param {{includeResourceAdmissionTiming?: boolean}} [options]
 */
export function projectManagedJobResult(result, { includeResourceAdmissionTiming = false } = {}) {
  if (!result || typeof result !== "object") return result;
  const projectSteps = (/** @type {unknown} */ steps) => Array.isArray(steps) ? steps.map((/** @type {unknown} */ step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const rawStep = /** @type {Record<string, any>} */ (step);
    const { resource_admission_ms: _resourceAdmissionMs, ...projected } = rawStep;
    const target = includeResourceAdmissionTiming
      ? { ...projected, ...(rawStep.resource_admission_ms !== undefined ? { resource_admission_ms: rawStep.resource_admission_ms } : {}) }
      : projected;
    if (typeof target.stdout === "string") target.stdout = redactSensitiveProcessOutput(target.stdout);
    if (typeof target.stderr === "string") target.stderr = redactSensitiveProcessOutput(target.stderr);
    return target;
  }) : steps;
  return { ...result, steps: projectSteps(result.steps), finally_steps: projectSteps(result.finally_steps) };
}

/**
 * Return the stable public status shape without runner identity or internal paths.
 * @param {{job_id?: unknown, name?: unknown, continuation_mode?: unknown, status?: unknown, created_at?: unknown, started_at?: unknown,
 * finished_at?: unknown, current_phase?: unknown, current_step?: unknown, approval?: unknown, plan_sha256?: unknown,
 * cleanup_guarantee?: unknown, error_class?: unknown, cleanup_error_class?: unknown, recovery_attempts?: unknown, recovery_history?: unknown, result_persisted?: unknown,
 * terminal_record_error_class?: unknown, artifact_cleanup_pending?: unknown, artifact_cleanup_error_class?: unknown,
 * dependency_total?: unknown, dependency_pending_count?: unknown}} status
 */
export function publicStatus(status) {
  return {
    job_id: status.job_id,
    name: status.name,
    ...(status.continuation_mode === "task_supervisor" ? { continuation_mode: "task_supervisor" } : {}),
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
    cleanup_error_class: status.cleanup_error_class ?? null,
    recovery_attempts: managedJobRecoveryAttempts(status),
    recovery_history: managedJobRecoveryHistory(status),
    recovery_history_complete: managedJobRecoveryHistoryComplete(status),
    result_persisted: typeof status.result_persisted === "boolean" ? status.result_persisted : null,
    terminal_record_error_class: status.terminal_record_error_class ?? null,
    artifact_cleanup_pending: status.artifact_cleanup_pending === true,
    artifact_cleanup_error_class: status.artifact_cleanup_error_class ?? null,
    dependency_total: managedJobDependencyCount(status.dependency_total),
    dependency_pending_count: managedJobDependencyCount(status.dependency_pending_count),
  };
}
