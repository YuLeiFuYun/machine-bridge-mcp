import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { runFixtureChild } from "../child-fixture.mjs";
import { relayDelegatedContext, relayOwnerContext } from "../authority-context.mjs";
import { createHash } from "node:crypto";

import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeManagedJobs, ManagedJobManager } from "../../../src/local/managed-jobs.mjs";
import { hostedManagedJobListStatus, hostedManagedJobStatus } from "../../../src/local/managed-job-hosted-status.mjs";
import {
  managedJobReadNonterminalProgressMinimumMs, managedJobReadWaitMs, waitForManagedJobRead,
} from "../../../src/local/managed-job-read-wait.mjs";
import {
  DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS, managedJobDependencySucceeded, readManagedJobDependencyStatus,
  waitForManagedJobDependencies,
} from "../../../src/local/managed-job-dependencies.mjs";
import { managedJobDependencyCount, managedJobDependencyLabel } from "../../../src/local/managed-job-dependency-metadata.mjs";
import {
  managedJobActiveChildRecoveryReady, publishManagedJobActiveChild, terminateManagedJobActiveChild,
} from "../../../src/local/managed-job-active-child.mjs";
import { MAX_JOBS, MAX_LISTED_JOBS } from "../../../src/local/managed-job-capacity.mjs";
import {
  TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS, TRANSIENT_PROCESS_RECOVERY_GRACE_MS, TRANSIENT_PROCESS_RECOVERY_SLOTS,
  transientProcessUndeliveredRecoveryProtected, transientProcessWithinRecoveryGrace,
} from "../../../src/local/managed-job-retention-policy.mjs";
import { clearTransientProcessRecoveryPending } from "../../../src/local/managed-job-transient-recovery.mjs";
import { NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS } from "../../../src/local/managed-job-transient-recovery-capacity.mjs";
import { managedJobIdempotencyDigest } from "../../../src/local/managed-job-idempotency.mjs";
import { readJson as readManagedJobJson, resourceErrorClass } from "../../../src/local/managed-job-storage.mjs";
import { validatePlan } from "../../../src/local/managed-job-plan.mjs";
import { publicStatus, reviewablePlan } from "../../../src/local/managed-job-projection.mjs";
import { runnerProcessIsCurrent, runnerProcessIsCurrentAsync } from "../../../src/local/managed-job-runner.mjs";
import { confirmRunnerClaim, publishProvisionalRunnerClaim, readManagedJobRunnerClaim } from "../../../src/local/managed-job-runner-claim.mjs";
import { createManagedJobRunnerExitRecovery } from "../../../src/local/managed-job-runner-exit-recovery.mjs";
import { ACTIVE_JOB_STATES, managedJobFinalStatus, persistManagedJobTerminal } from "../../../src/local/managed-job-terminal.mjs";
import { acquireJobCapacityLock, acquireJobTransitionLock } from "../../../src/local/managed-job-lock.mjs";
import { managedJobTransitionConflict } from "../../../src/local/managed-job-state-validation.mjs";

import "../../../src/shared/server-metadata.json" with { type: "json" };
import {
  assert, expectThrow, expectReject, delay, exists, waitForJob, isSettledTerminalJob, waitForPidExit,
  spawnManagedJobTestRunner, pendingDependencyFixture, settleDependencyFixture,
  RUNNER_EXIT_RECOVERY_TEST_WAIT_MS, MANAGED_JOB_TEST_WAIT_MS,
  MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS, TOOL_SCHEMA_GENERATION, runnerEntry,
} from "./common.mjs";

const transitionConflict = managedJobTransitionConflict();
assert(transitionConflict.code === "conflict" && transitionConflict.retryable === true
  && transitionConflict.details?.job_transition_pending === true,
"managed-job transition contention lost its typed retryable conflict contract");

export async function runManagedJobPolicyScenarios(context = {}) {
  const root = context.root || await mkdtemp(join(tmpdir(), "mbm-managed-job-policy-"));
  const workspace = context.workspace || join(root, "workspace");
  const jobRoot = context.jobRoot || join(root, "jobs");
  await mkdir(workspace, { recursive: true });
  await mkdir(jobRoot, { recursive: true });

  function testManagedJobRetentionGraceBoundaries() {
  const now = Date.parse("2026-08-26T00:30:00.000Z");
  const transient = { retention_class: "transient_process", finished_at: new Date(now - TRANSIENT_PROCESS_RECOVERY_GRACE_MS).toISOString() };
  assert(transientProcessWithinRecoveryGrace(transient, 0, now),
    "transient recovery grace excluded its exact documented boundary");
  transient.finished_at = new Date(now - TRANSIENT_PROCESS_RECOVERY_GRACE_MS - 1).toISOString();
  assert(!transientProcessWithinRecoveryGrace(transient, 0, now),
    "transient recovery grace retained an expired helper result");
  transient.finished_at = new Date(now + 1).toISOString();
  assert(!transientProcessWithinRecoveryGrace(transient, 0, now),
    "transient recovery grace trusted a future terminal timestamp");
  assert(!transientProcessWithinRecoveryGrace({ finished_at: new Date(now).toISOString() }, now, now),
    "ordinary managed-job history entered the transient recovery grace");
  const pending = { retention_class: "transient_process", transient_recovery_pending: true, finished_at: new Date(now - TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS).toISOString() };
  assert(transientProcessWithinRecoveryGrace(pending, 0, now),
    "pending transient recovery grace excluded its exact 24-hour boundary");
  assert(transientProcessUndeliveredRecoveryProtected(pending, 0, now),
    "pending transient recovery was not hard-protected at the exact 24-hour boundary");
  pending.finished_at = new Date(now - TRANSIENT_PROCESS_RECOVERY_GRACE_MS - 1).toISOString();
  assert(transientProcessWithinRecoveryGrace(pending, 0, now),
    "pending transient recovery was incorrectly reduced to the post-delivery thirty-minute reserve");
  pending.finished_at = new Date(now - TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS - 1).toISOString();
  assert(!transientProcessWithinRecoveryGrace(pending, 0, now),
    "pending transient recovery retained an expired 24-hour result");
  assert(!transientProcessUndeliveredRecoveryProtected(pending, 0, now),
    "expired pending transient recovery remained hard-protected after 24 hours");
  const delivered = { retention_class: "transient_process", finished_at: new Date(now - 1).toISOString() };
  assert(transientProcessWithinRecoveryGrace(delivered, 0, now)
    && !transientProcessUndeliveredRecoveryProtected(delivered, 0, now),
    "terminal-delivered transient recovery incorrectly entered hard undelivered protection");
}

function testManagedJobContinuationProjection() {
  const ordinaryPlan = reviewablePlan({ version: 1, name: "ordinary", workspace: process.cwd(), steps: [] });
  const supervisorPlan = reviewablePlan({ version: 1, name: "supervisor", continuation_mode: "task_supervisor", workspace: process.cwd(), steps: [] });
  assert(!Object.hasOwn(ordinaryPlan, "continuation_mode") && supervisorPlan.continuation_mode === "task_supervisor",
    "reviewable managed-job plan projection lost the finite task-supervisor authority boundary");
  const ordinaryStatus = publicStatus({ job_id: "job-ordinary", name: "ordinary", status: "running" });
  const supervisorStatus = publicStatus({ job_id: "job-supervisor", name: "supervisor", continuation_mode: "task_supervisor", status: "running" });
  assert(!Object.hasOwn(ordinaryStatus, "continuation_mode") && supervisorStatus.continuation_mode === "task_supervisor",
    "public managed-job status projection lost the finite task-supervisor authority boundary");
  assert(ordinaryStatus.recovery_attempts === 0 && Array.isArray(ordinaryStatus.recovery_history)
    && ordinaryStatus.recovery_history.length === 0 && ordinaryStatus.recovery_history_complete === true,
    "managed-job status did not expose an explicit empty recovery attribution record");
  const priorVersionStatus = publicStatus({ job_id: "job-prior", name: "prior", status: "interrupted", recovery_attempts: 1 });
  assert(priorVersionStatus.recovery_history.length === 0 && priorVersionStatus.recovery_history_complete === false,
    "managed-job status fabricated missing prior-version recovery attribution");
  const suffixStatus = publicStatus({
    job_id: "job-suffix", name: "suffix", status: "interrupted", recovery_attempts: 3,
    recovery_history: [
      { attempt: 2, at: new Date().toISOString(), reason: "runner_interrupted" },
      { attempt: 3, at: new Date().toISOString(), reason: "dependency_wait_runner_interrupted" },
    ],
  });
  assert(suffixStatus.recovery_history_complete === false && suffixStatus.recovery_history.map((entry) => entry.attempt).join(",") === "2,3",
    "managed-job status did not preserve a valid attributable recovery-history suffix");
  let gappedRecovery = null;
  try {
    publicStatus({
      job_id: "bad-gap", status: "interrupted", recovery_attempts: 3,
      recovery_history: [
        { attempt: 1, at: new Date().toISOString(), reason: "runner_interrupted" },
        { attempt: 3, at: new Date().toISOString(), reason: "runner_interrupted" },
      ],
    });
  } catch (error) { gappedRecovery = error; }
  assert(gappedRecovery?.code === "integrity_error", "managed-job status accepted a gapped recovery-history suffix");
  let invalidRecovery = null;
  try { publicStatus({ job_id: "bad", status: "running", recovery_attempts: "1" }); }
  catch (error) { invalidRecovery = error; }
  assert(invalidRecovery?.code === "integrity_error", "managed-job status coerced a string recovery attempt count");
}

function testManagedJobContinuationModeValidation() {
  const context = { workspace: process.cwd(), fullEnv: false, unrestrictedPaths: true, resources: {} };
  const ordinary = validatePlan({ name: "ordinary", steps: [{ argv: [process.execPath, "-e", ""] }] }, context);
  assert(!Object.hasOwn(ordinary, "continuation_mode"),
    "ordinary managed-job plan gained task-supervisor authority by default");
  const supervisor = validatePlan({ name: "supervisor", continuation_mode: "task_supervisor", steps: [{ argv: [process.execPath, "-e", ""] }] }, context);
  assert(supervisor.continuation_mode === "task_supervisor",
    "task-supervisor continuation authority did not survive managed-job plan validation");
  let invalid = null;
  try { validatePlan({ name: "invalid", continuation_mode: "job_monitor", steps: [{ argv: [process.execPath, "-e", ""] }] }, context); }
  catch (error) { invalid = error; }
  assert(String(invalid?.message || "").includes("continuation_mode must be task_supervisor"),
    "managed-job plan accepted a continuation mode outside the finite supervisor authority set");
}

async function testTransientRecoveryMarkerBoundaries() {
  const root = await mkdtemp(join(tmpdir(), "mbm-transient-recovery-marker-"));
  const jobId = `job_${"R".repeat(24)}`;
  const dir = join(root, jobId);
  const statusFile = join(dir, "status.json");
  await mkdir(dir, { recursive: true });
  const writeStatus = async (status) => writeFile(statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  try {
    await writeStatus({ job_id: jobId, status: "succeeded", retention_class: "managed", transient_recovery_pending: true });
    assert(clearTransientProcessRecoveryPending(dir) === false,
      "ordinary managed-job terminal state entered transient recovery-marker clearing");

    await writeStatus({ job_id: jobId, status: "running", retention_class: "transient_process", transient_recovery_pending: true });
    assert(clearTransientProcessRecoveryPending(dir) === false,
      "active transient process lost its follow-up recovery marker before terminal settlement");

    await writeStatus({ job_id: `${jobId}x`, status: "succeeded", retention_class: "transient_process", transient_recovery_pending: true });
    let identityFailure = null;
    try { clearTransientProcessRecoveryPending(dir); } catch (error) { identityFailure = error; }
    assert(String(identityFailure?.message || "").includes("directory identity is invalid"),
      "transient recovery-marker mutation trusted mismatched managed-job directory identity");

    await writeStatus({ job_id: jobId, status: "succeeded", retention_class: "transient_process", transient_recovery_pending: true });
    const held = acquireJobTransitionLock(dir);
    assert(held, "transient recovery-marker fixture could not acquire its transition lock");
    try {
      assert(clearTransientProcessRecoveryPending(dir) === false,
        "transient recovery-marker mutation ignored an existing state transition owner");
    } finally { held.release(); }
    assert(clearTransientProcessRecoveryPending(dir) === true,
      "terminal transient process did not clear its delivered follow-up recovery marker");
    const cleared = JSON.parse(await readFile(statusFile, "utf8"));
    assert(!Object.hasOwn(cleared, "transient_recovery_pending"),
      "terminal transient process persisted its cleared private recovery marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const warningRoot = await mkdtemp(join(tmpdir(), "mbm-transient-recovery-warning-"));
  const warnings = [];
  try {
    const manager = createManagedJobTestManager({
      jobRoot: warningRoot, workspace: process.cwd(),
      policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false,
      logger: { warn(message, fields) { warnings.push({ message, fields }); } },
    });
    const staged = manager.createJob({
      name: "transient recovery warning",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: false, retentionClass: "transient_process" }, relayOwnerContext());
    manager.cancel({ job_id: staged.job_id });
    const originalRead = manager.read.bind(manager);
    manager.read = (...args) => {
      const value = originalRead(...args);
      writeFileSync(join(warningRoot, staged.job_id, "status.json"), "{invalid-json\n", { mode: 0o600 });
      return value;
    };
    const delivered = await manager.readHosted({ job_id: staged.job_id });
    assert(delivered.status === "cancelled_before_start"
      && warnings.some((entry) => entry.message === "managed job delivered-result recovery marker could not be downgraded"
        && entry.fields?.error_class === "resource_unavailable"),
    "delivered transient recovery-marker storage failure was not recorded without replacing the successful read result");
  } finally {
    await rm(warningRoot, { recursive: true, force: true });
  }
}

function testManagedStateIdentityRetry() {
  let attempts = 0;
  const recovered = readManagedJobJson("synthetic-status.json", 1024, "job status", {
    readFile() {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("synthetic generation change"), { code: "MBM_IDENTITY_CHANGED" });
      return Buffer.from('{"status":"running"}');
    },
  });
  assert(attempts === 4 && recovered.status === "running",
    "managed job state did not recover from bounded atomic-generation churn");
  let failure = null;
  attempts = 0;
  try {
    readManagedJobJson("synthetic-status.json", 1024, "job status", {
      readFile() {
        attempts += 1;
        throw Object.assign(new Error("synthetic persistent generation churn"), { code: "MBM_IDENTITY_CHANGED" });
      },
    });
  } catch (error) { failure = error; }
  assert(attempts === 4 && String(failure?.message || "").includes("identity_changed")
    && resourceErrorClass(failure) === "identity_changed",
  "managed job state identity retry became unbounded or lost its stable error classification");
  assert(resourceErrorClass(Object.assign(new Error("corrupt terminal state"), { code: "integrity_error" })) === "integrity_error",
    "managed-job diagnostics collapsed an integrity failure into generic resource unavailability");
}

async function testRunnerExitRecoveryRetryPolicy() {
  let transientCalls = 0;
  const transientWarnings = [];
  const transientRecovery = createManagedJobRunnerExitRecovery({
    delayMs: 1,
    retryDelayMs: 1,
    maxAttempts: 3,
    reconcileStatus() {
      transientCalls += 1;
      if (transientCalls === 1) throw Object.assign(new Error("synthetic Windows sharing violation"), { code: "EPERM" });
    },
    logger: { warn(message, fields) { transientWarnings.push({ message, fields }); } },
  });
  transientRecovery.observe("synthetic-transient-job");
  await delay(50);
  transientRecovery.stop();
  assert(transientCalls === 2 && transientWarnings.length === 1
    && transientWarnings[0].fields?.error_class === "permission_denied"
    && transientWarnings[0].fields?.retry_scheduled === true,
  "runner-exit recovery did not retry a bounded transient Windows reconciliation failure");

  let fatalCalls = 0;
  const fatalWarnings = [];
  const fatalRecovery = createManagedJobRunnerExitRecovery({
    delayMs: 1,
    retryDelayMs: 1,
    maxAttempts: 3,
    reconcileStatus() {
      fatalCalls += 1;
      throw Object.assign(new Error("synthetic invalid recovery state"), { code: "EINVAL" });
    },
    logger: { warn(message, fields) { fatalWarnings.push({ message, fields }); } },
  });
  fatalRecovery.observe("synthetic-fatal-job");
  await delay(50);
  fatalRecovery.stop();
  assert(fatalCalls === 1 && fatalWarnings.length === 1 && fatalWarnings[0].fields?.retry_scheduled === false,
    "runner-exit recovery retried a non-transient reconciliation failure");
}

async function testManagedJobDependencyReadRecoveryPolicy() {
  const jobId = `job_${"r".repeat(24)}`;
  const witness = { job_id: jobId, plan_sha256: "a".repeat(64), created_at: "2026-08-27T00:00:00.000Z" };
  const succeeded = { ...witness, status: "succeeded", result_persisted: true };
  assert(managedJobDependencySucceeded({ ...succeeded, status: ["succeeded"] }) === false,
    "dependency success coerced a non-string persisted status");
  let malformedWitnessFailure = null;
  try {
    await waitForManagedJobDependencies({
      jobRoot: "synthetic",
      dependencyIds: [jobId],
      witnesses: [{ ...witness, job_id: [jobId] }],
      readStatus: async () => succeeded,
      sleep: async () => {},
      now: () => 0,
    });
  } catch (error) { malformedWitnessFailure = error; }
  assert(malformedWitnessFailure?.errorClass === "dependency_state_invalid",
    "dependency witness coerced a non-string persisted job id");
  let malformedStatusFailure = null;
  try {
    await waitForManagedJobDependencies({
      jobRoot: "synthetic",
      dependencyIds: [jobId],
      witnesses: [witness],
      readStatus: async () => ({ ...succeeded, status: ["succeeded"] }),
      sleep: async () => {},
      now: () => 0,
    });
  } catch (error) { malformedStatusFailure = error; }
  assert(malformedStatusFailure?.errorClass === "dependency_state_invalid",
    "dependency gate coerced a non-string persisted status into executable state");
  let clockMs = 0;
  let attempts = 0;
  const recovered = await waitForManagedJobDependencies({
    jobRoot: "synthetic",
    dependencyIds: [jobId],
    witnesses: [witness],
    readStatus() {
      attempts += 1;
      if (attempts === 1) throw new Error("dependency job status is unavailable (permission_denied)", {
        cause: Object.assign(new Error("synthetic Windows sharing violation"), { code: "EPERM" }),
      });
      return succeeded;
    },
    sleep: async (ms) => { clockMs += ms; },
    now: () => clockMs,
  });
  assert(attempts === 2 && recovered.pending === 0 && recovered.completed === 1,
    "dependency wait did not recover from one transient Windows state-read failure");

  clockMs = 0;
  attempts = 0;
  let persistentFailure = null;
  try {
    await waitForManagedJobDependencies({
      jobRoot: "synthetic",
      dependencyIds: [jobId],
      witnesses: [witness],
      readStatus() {
        attempts += 1;
        throw new Error("dependency job status is unavailable (permission_denied)", {
          cause: Object.assign(new Error("synthetic persistent Windows sharing violation"), { code: "EPERM" }),
        });
      },
      sleep: async (ms) => { clockMs += ms; },
      now: () => clockMs,
    });
  } catch (error) { persistentFailure = error; }
  assert(persistentFailure?.errorClass === "dependency_unavailable"
    && persistentFailure?.details?.cause_class === "permission_denied"
    && clockMs >= DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS
    && clockMs <= DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS + 1_000,
  "dependency wait did not fail closed after the bounded transient state-read recovery grace");
}

function testHostedManagedJobStatusProjection() {
  const relayContext = relayOwnerContext();
  for (const status of ["queued", "running", "cleaning", "interrupted"]) {
    const projected = hostedManagedJobStatus({ status }, relayContext);
    assert(projected.host_turn_handoff_recommended === false && projected.status_polling_mode === "bounded_followup"
      && projected.tool_schema_generation === TOOL_SCHEMA_GENERATION && projected.host_turn_deadline_observable === false
      && projected.host_terminal_receipt_observable === false && projected.same_response_followup_supported === true
      && projected.managed_job_detached_from_mcp_response === true,
      `active managed-job state ${status} did not preserve bounded same-turn follow-up`);
  }
  const terminal = hostedManagedJobStatus({ status: "succeeded" }, relayContext);
  assert(terminal.host_turn_handoff_recommended === false && terminal.status_polling_mode === "terminal"
    && terminal.tool_schema_generation === TOOL_SCHEMA_GENERATION && terminal.host_turn_deadline_observable === false
    && terminal.host_terminal_receipt_observable === false && terminal.same_response_followup_supported === false,
    "terminal managed-job status retained active polling semantics");
  assert(Object.keys(hostedManagedJobStatus({ status: "running" }, {})).length === 0,
    "local managed-job status gained relay-only hosted-turn metadata");
  const activeListing = hostedManagedJobListStatus([{ status: "succeeded" }, { status: "cleaning" }], relayContext);
  assert(activeListing.host_turn_handoff_recommended === false && activeListing.status_polling_mode === "inventory"
    && activeListing.tool_schema_generation === TOOL_SCHEMA_GENERATION && activeListing.host_turn_deadline_observable === false
    && activeListing.host_terminal_receipt_observable === false,
    "remote list_jobs did not remain an inventory surface");
  const terminalListing = hostedManagedJobListStatus([{ status: "succeeded" }], relayContext);
  assert(terminalListing.host_turn_handoff_recommended === false && terminalListing.status_polling_mode === "inventory",
    "terminal-only remote list_jobs did not remain an inventory surface");
  assert(Object.keys(hostedManagedJobListStatus([{ status: "running" }], {})).length === 0,
    "local list_jobs gained relay-only hosted-turn metadata");
}

async function testManagedJobReadWaitPacing() {
  const relayContext = relayOwnerContext();
  assert(managedJobReadWaitMs({}, relayContext) === 40_000, "hosted read_job did not default to the host-safe server-side long-poll interval");
  assert(Math.ceil((100 * 60 * 1000) / managedJobReadWaitMs({}, relayContext)) <= 150,
    "the default hosted wait interval regained the prior high-density read_job amplification; this arithmetic is a density guard, not aggregate host-lifetime evidence");
  assert(managedJobReadNonterminalProgressMinimumMs({}, relayContext) === 30_000
    && Math.ceil((100 * 60 * 1000) / managedJobReadNonterminalProgressMinimumMs({}, relayContext)) <= 200,
  "active hosted read_job progress lost its bounded nonterminal coalescing interval");
  assert(managedJobReadWaitMs({ wait_ms: 0 }, relayContext) === 0, "hosted read_job lost its explicit immediate-checkpoint override");
  assert(managedJobReadNonterminalProgressMinimumMs({ wait_ms: 0 }, relayContext) === 0,
    "explicit immediate read_job checkpoint unexpectedly gained a coalescing delay");
  assert(managedJobReadWaitMs({ wait_ms: 60_000 }, relayContext) === 60_000, "hosted read_job rejected its advertised maximum wait");
  assert(managedJobReadWaitMs({ wait_ms: 180_000 }, relayContext) === 60_000, "hosted read_job policy did not clamp an interruption-prone overlong wait to the public maximum");
  assert(managedJobReadWaitMs({}, {}) === 0 && managedJobReadWaitMs({ wait_ms: 40_000 }, {}) === 40_000,
    "local read_job wait defaults or maximum drifted from the local contract");

  let clock = 0;
  let fullReads = 0;
  let progressReads = 0;
  const stable = () => ({ status: "running", current_phase: "steps", current_step: 0 });
  const timeoutResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => { fullReads += 1; return stable(); },
    readProgress: () => { progressReads += 1; return stable(); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(timeoutResult.status === "running" && timeoutResult.managed_job_read_wait_ms === 40_000
    && timeoutResult.managed_job_read_wait_timed_out === true,
  "unchanged hosted read_job did not hold one MCP call for the complete bounded long-poll interval");
  assert(progressReads === 8, "hosted read_job lightweight progress probing escaped its five-second pacing bound");
  assert(fullReads === 2, "hosted read_job repeatedly performed full runner reconciliation during one long-poll");

  clock = 0;
  let dependencyPending = 2;
  const dependencyProgress = () => ({
    status: "queued", current_phase: "dependency_wait", current_step: null,
    dependency_total: 2, dependency_pending_count: dependencyPending,
  });
  const dependencyProgressResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => dependencyProgress(),
    readProgress: () => { dependencyPending = 1; return dependencyProgress(); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(dependencyProgressResult.dependency_pending_count === 1
    && dependencyProgressResult.managed_job_read_wait_ms === 30_000
    && dependencyProgressResult.managed_job_read_nonterminal_progress_minimum_ms === 30_000
    && dependencyProgressResult.managed_job_read_wait_timed_out === false,
  "dependency progress was not coalesced into a bounded same-call hosted update");

  clock = 0;
  const hostedMetadataResult = await waitForManagedJobRead({
    context: relayContext, args: { wait_ms: 5_000 },
    readCurrent: () => ({
      ...stable(),
      host_turn_handoff_recommended: false,
      status_polling_mode: "bounded_followup",
      tool_schema_generation: TOOL_SCHEMA_GENERATION,
      host_turn_deadline_observable: false,
      managed_job_detached_from_mcp_response: true,
    }),
    readProgress: () => stable(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(hostedMetadataResult.managed_job_read_wait_timed_out === true
    && hostedMetadataResult.managed_job_read_nonterminal_progress_minimum_ms === 5_000
    && hostedMetadataResult.host_turn_handoff_recommended === false
    && hostedMetadataResult.status_polling_mode === "bounded_followup"
    && hostedMetadataResult.tool_schema_generation === TOOL_SCHEMA_GENERATION
    && hostedMetadataResult.host_turn_deadline_observable === false
    && hostedMetadataResult.managed_job_detached_from_mcp_response === true,
  "unchanged hosted read_job lost full-read continuity metadata after a lightweight progress probe");

  clock = 0;
  fullReads = 0;
  progressReads = 0;
  const expensiveInitialResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => { fullReads += 1; clock += 12_000; return stable(); },
    readProgress: () => { progressReads += 1; return stable(); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(expensiveInitialResult.managed_job_read_wait_ms === 40_000
    && expensiveInitialResult.managed_job_read_wait_timed_out === true
    && clock === 40_000 && fullReads === 1 && progressReads === 6,
  "hosted read_job excluded initial reconciliation from its advertised wait or added a heavy post-deadline reconcile");

  clock = 0;
  fullReads = 0;
  progressReads = 0;
  let currentStep = 0;
  const stepOnlyProgressResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => { fullReads += 1; return { status: "running", current_phase: "steps", current_step: currentStep }; },
    readProgress: () => {
      progressReads += 1;
      if (progressReads >= 2) currentStep = 1;
      return { status: "running", current_phase: "steps", current_step: currentStep };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(stepOnlyProgressResult.current_step === 1 && stepOnlyProgressResult.managed_job_read_wait_timed_out === true
    && stepOnlyProgressResult.managed_job_read_wait_ms === 40_000 && fullReads === 2 && progressReads === 8,
  "current_step-only churn still woke hosted read_job and amplified one multi-step job into rapid host events");

  clock = 0;
  currentStep = 0;
  const localStepProgressResult = await waitForManagedJobRead({
    args: { wait_ms: 40_000 },
    context: {},
    readCurrent: () => ({ status: "running", current_phase: "steps", current_step: currentStep }),
    readProgress: () => {
      currentStep = 1;
      return { status: "running", current_phase: "steps", current_step: currentStep };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(localStepProgressResult.current_step === 1 && clock === 5_000,
    "host-only current_step coalescing accidentally changed the local explicit-wait progress contract");

  clock = 0;
  fullReads = 0;
  progressReads = 0;
  let currentPhase = "steps";
  const phaseProgressResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => { fullReads += 1; return { status: "running", current_phase: currentPhase, current_step: 0 }; },
    readProgress: () => {
      progressReads += 1;
      if (progressReads >= 2) currentPhase = "finally_steps";
      return { status: "running", current_phase: currentPhase, current_step: 0 };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(phaseProgressResult.current_phase === "finally_steps" && phaseProgressResult.managed_job_read_wait_timed_out === false
    && phaseProgressResult.managed_job_read_wait_ms === 30_000
    && phaseProgressResult.managed_job_read_nonterminal_progress_minimum_ms === 30_000
    && fullReads === 2 && progressReads === 6,
  "nonterminal phase progress escaped the hosted coalescing window or lost its authoritative full read");

  clock = 0;
  progressReads = 0;
  let transientPhase = "steps";
  const transientProgressResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => ({ status: "running", current_phase: transientPhase, current_step: 0 }),
    readProgress: () => {
      progressReads += 1;
      transientPhase = progressReads === 1 ? "finally_steps" : "steps";
      return { status: "running", current_phase: transientPhase, current_step: 0 };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(transientProgressResult.current_phase === "steps"
    && transientProgressResult.managed_job_read_wait_ms === 40_000
    && transientProgressResult.managed_job_read_wait_timed_out === true,
  "transient nonterminal progress that returned to the initial state still emitted a host-visible progress event");

  clock = 0;
  progressReads = 0;
  let terminalStatus = "running";
  const coalescedTerminalResult = await waitForManagedJobRead({
    context: relayContext,
    readCurrent: () => ({ status: terminalStatus, current_phase: terminalStatus === "running" ? "steps" : null, current_step: null }),
    readProgress: () => {
      progressReads += 1;
      if (progressReads >= 2) terminalStatus = "succeeded";
      return { status: terminalStatus, current_phase: terminalStatus === "running" ? "steps" : null, current_step: null };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert(coalescedTerminalResult.status === "succeeded" && coalescedTerminalResult.managed_job_read_wait_ms === 10_000
    && coalescedTerminalResult.managed_job_read_wait_timed_out === false,
  "terminal managed-job settlement was delayed until the nonterminal progress coalescing floor");

  const terminalResult = await waitForManagedJobRead({
    context: relayContext, args: { wait_ms: 0 },
    readCurrent: () => ({ status: "succeeded", current_phase: null, current_step: null }),
    sleep: async () => { throw new Error("terminal read_job unexpectedly slept"); },
  });
  assert(terminalResult.status === "succeeded" && terminalResult.managed_job_read_wait_ms === 0
    && terminalResult.managed_job_read_wait_timed_out === false,
  "terminal or explicit-zero read_job did not remain an immediate checkpoint");

  clock = 0;
  let cancellation = null;
  let slept = false;
  try {
    await waitForManagedJobRead({
      context: relayContext,
      readCurrent: () => ({ status: "running", current_phase: "steps", current_step: 0 }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; slept = true; },
      throwIfCancelled: () => { if (slept) throw new Error("synthetic cancellation"); },
    });
  } catch (error) { cancellation = error; }
  assert(String(cancellation?.message || "") === "synthetic cancellation" && clock === 5_000,
    "hosted read_job long-poll did not observe cancellation between internal waits");
}

async function testRunnerClaimBoundary() {
  const processStartedAt = new Date(Date.now() - 1000).toISOString();
  let publicationReads = 0;
  const publicationClaim = readManagedJobRunnerClaim("synthetic-runner-claim", "synthetic runner claim is unreadable", {
    readBytes: () => {
      publicationReads += 1;
      if (publicationReads === 1) {
        throw Object.assign(new Error("runner claim identity changed while opening"), { code: "MBM_IDENTITY_CHANGED" });
      }
      return Buffer.from(`${JSON.stringify({ pid: process.pid, startedAt: processStartedAt })}\n`);
    },
  });
  assert(publicationReads === 2 && publicationClaim.pid === process.pid,
    "runner claim reader did not retry one concurrent atomic publication identity change");

  const directDir = join(root, "claim-direct");
  await mkdir(directDir, { recursive: true });
  const directFile = join(directDir, "runner.pid");
  await confirmRunnerClaim({ file: directFile, pid: process.pid, processStartedAt, launchToken: "" });
  const direct = JSON.parse(await readFile(directFile, "utf8"));
  assert(direct.pid === process.pid && direct.processStartedAt === processStartedAt && !("launchToken" in direct),
    "token-free runner claim did not persist exact identity");

  const token = "a".repeat(32);
  const provisionalDir = join(root, "claim-provisional");
  await mkdir(provisionalDir, { recursive: true });
  publishProvisionalRunnerClaim(provisionalDir, process.pid, token);
  publishProvisionalRunnerClaim(provisionalDir, process.pid, token);
  const provisionalFile = join(provisionalDir, "runner.pid");
  const provisional = JSON.parse(await readFile(provisionalFile, "utf8"));
  const originalStartedAt = provisional.startedAt;
  assert(provisional.committed === true, "parent-side runner claim became executable before publication was fully committed");
  await confirmRunnerClaim({ file: provisionalFile, pid: process.pid, processStartedAt, launchToken: token });
  const exact = JSON.parse(await readFile(provisionalFile, "utf8"));
  assert(exact.startedAt === originalStartedAt && exact.processStartedAt === processStartedAt && !("launchToken" in exact),
    "provisional runner claim was not atomically upgraded");

  const delayedDir = join(root, "claim-delayed");
  await mkdir(delayedDir, { recursive: true });
  const delayedFile = join(delayedDir, "runner.pid");
  const delayedToken = "b".repeat(32);
  setTimeout(() => publishProvisionalRunnerClaim(delayedDir, process.pid, delayedToken), 20);
  await confirmRunnerClaim({ file: delayedFile, pid: process.pid, processStartedAt, launchToken: delayedToken });

  const uncommittedDir = join(root, "claim-uncommitted");
  await mkdir(uncommittedDir, { recursive: true });
  const uncommittedFile = join(uncommittedDir, "runner.pid");
  const uncommittedToken = "e".repeat(32);
  const uncommittedClaim = `${JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), launchToken: uncommittedToken, committed: false,
  })}\n`;
  await writeFile(uncommittedFile, uncommittedClaim, { mode: 0o600 });
  await expectReject(confirmRunnerClaim({
    file: uncommittedFile, pid: process.pid, processStartedAt, launchToken: uncommittedToken, waitMs: 25,
  }), "runner ownership claim was not published before startup deadline");
  assert(await readFile(uncommittedFile, "utf8") === uncommittedClaim,
    "runner accepted or rewrote an uncommitted parent-side ownership claim");

  await expectReject(confirmRunnerClaim({ file: join(root, "invalid-token.pid"), pid: process.pid, processStartedAt, launchToken: "invalid" }), "runner launch token is invalid");
  const invalidPublishDir = join(root, "claim-invalid-publish-token");
  await mkdir(invalidPublishDir, { recursive: true });
  expectThrow(() => publishProvisionalRunnerClaim(invalidPublishDir, process.pid, "invalid"), "runner launch token is invalid");
  assert(!(await exists(join(invalidPublishDir, "runner.pid"))), "invalid launch token created a provisional runner claim");

  const reusedPidDir = join(root, "claim-reused-pid");
  await mkdir(reusedPidDir, { recursive: true });
  const reusedPidFile = join(reusedPidDir, "runner.pid");
  const staleToken = "c".repeat(32);
  const freshToken = "d".repeat(32);
  const staleClaim = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), launchToken: staleToken })}\n`;
  await writeFile(reusedPidFile, staleClaim, { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(reusedPidDir, process.pid, freshToken), "owned by another process or launch");
  assert(await readFile(reusedPidFile, "utf8") === staleClaim,
    "PID-reused runner claim accepted a different launch token or mutated the existing owner");

  const conflictDir = join(root, "claim-conflict");
  await mkdir(conflictDir, { recursive: true });
  await writeFile(join(conflictDir, "runner.pid"), `${JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString(), launchToken: token })}\n`, { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(conflictDir, process.pid, token), "owned by another process");
  await expectReject(confirmRunnerClaim({ file: join(conflictDir, "runner.pid"), pid: process.pid, processStartedAt, launchToken: token }), "does not match the spawned process");

  const unreadableDir = join(root, "claim-unreadable");
  await mkdir(unreadableDir, { recursive: true });
  await writeFile(join(unreadableDir, "runner.pid"), "not-json\n", { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(unreadableDir, process.pid, token), "already exists but is unreadable");
  await expectReject(confirmRunnerClaim({ file: join(unreadableDir, "runner.pid"), pid: process.pid, processStartedAt, launchToken: token }), "ownership claim is unreadable");

  if (process.platform !== "win32") {
    const hardClaimDir = join(root, "runner-owner-hardlink");
    const hardClaimFile = join(hardClaimDir, "runner.pid");
    const hardClaimAlias = join(hardClaimDir, "runner.pid.alias");
    await mkdir(hardClaimDir, { recursive: true });
    await writeFile(hardClaimFile, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), launchToken: token })}
`, { mode: 0o600 });
    await link(hardClaimFile, hardClaimAlias);
    let hardClaimFailure = null;
    try { publishProvisionalRunnerClaim(hardClaimDir, process.pid, token); } catch (error) { hardClaimFailure = error; }
    assert(hardClaimFailure?.cause?.code === "MBM_MULTIPLE_HARD_LINKS"
      && await readFile(hardClaimFile, "utf8") === await readFile(hardClaimAlias, "utf8"),
    "managed-job runner claim accepted or modified multiply-linked ownership evidence");
    let livenessHardClaimFailure = null;
    try {
      runnerProcessIsCurrent({ runner_pid: process.pid, runner_process_started_at: processStartedAt }, hardClaimDir);
    } catch (error) { livenessHardClaimFailure = error; }
    assert(livenessHardClaimFailure?.cause?.code === "MBM_MULTIPLE_HARD_LINKS",
      "managed-job runner liveness bypassed the secure multiply-linked claim reader");
  }

  const oversizedRunnerDir = join(root, "runner-owner-oversized");
  await mkdir(oversizedRunnerDir, { recursive: true });
  await writeFile(join(oversizedRunnerDir, "runner.pid"), "x".repeat(1025), { mode: 0o600 });
  let oversizedRunnerFailure = null;
  try {
    runnerProcessIsCurrent({ runner_pid: 2_147_483_647, runner_process_started_at: processStartedAt }, oversizedRunnerDir);
  } catch (error) { oversizedRunnerFailure = error; }
  assert(String(oversizedRunnerFailure?.message || "").includes("runner claim is invalid")
    && String(oversizedRunnerFailure?.cause?.message || "").includes("file exceeds 1024 bytes"),
  "managed-job runner liveness stopped bounding the secure ownership-claim read");
  expectThrow(() => runnerProcessIsCurrent({ runner_pid: process.pid, runner_process_started_at: processStartedAt }, unreadableDir),
    "runner claim is invalid");

  for (const [name, claim] of [
    ["string-pid", { pid: String(process.pid), startedAt: new Date().toISOString(), processStartedAt }],
    ["array-started-at", { pid: process.pid, startedAt: [new Date().toISOString()], processStartedAt }],
    ["invalid-started-at", { pid: process.pid, startedAt: "not-a-time", processStartedAt }],
    ["invalid-process-start", { pid: process.pid, startedAt: new Date().toISOString(), processStartedAt: "not-a-time" }],
    ["invalid-launch-token", { pid: process.pid, startedAt: new Date().toISOString(), launchToken: "not-a-token", committed: true }],
    ["array-launch-token", { pid: process.pid, startedAt: new Date().toISOString(), launchToken: [token], committed: true }],
    ["invalid-commit-marker", { pid: process.pid, startedAt: new Date().toISOString(), launchToken: token, committed: "yes" }],
  ]) {
    const invalidClaimDir = join(root, `runner-owner-${name}`);
    await mkdir(invalidClaimDir, { recursive: true });
    await writeFile(join(invalidClaimDir, "runner.pid"), `${JSON.stringify(claim)}\n`, { mode: 0o600 });
    expectThrow(
      () => runnerProcessIsCurrent({ runner_pid: process.pid, runner_process_started_at: processStartedAt }, invalidClaimDir),
      "runner claim is invalid",
    );
  }

  const missingRunnerClaimDir = join(root, "runner-owner-missing-claim");
  await mkdir(missingRunnerClaimDir, { recursive: true });
  const statusStartedAt = new Date().toISOString();
  assert(runnerProcessIsCurrent({
    runner_pid: String(process.pid),
    runner_process_started_at: processStartedAt,
    started_at: statusStartedAt,
  }, missingRunnerClaimDir) === false, "managed-job liveness coerced a string fallback PID from status state");
  assert(runnerProcessIsCurrent({
    runner_pid: process.pid,
    runner_process_started_at: [processStartedAt],
    started_at: statusStartedAt,
  }, missingRunnerClaimDir) === false, "managed-job liveness coerced an array fallback process timestamp from status state");
  assert(runnerProcessIsCurrent({
    runner_pid: process.pid,
    runner_process_started_at: processStartedAt,
    started_at: [statusStartedAt],
  }, missingRunnerClaimDir) === false, "managed-job liveness coerced an array fallback ownership timestamp from status state");
  assert(runnerProcessIsCurrent({
    runner_pid: process.pid,
    runner_process_started_at: processStartedAt,
    started_at: statusStartedAt,
  }, missingRunnerClaimDir) === true, "managed-job liveness rejected a valid exact fallback owner after strict field validation");

  const asyncRunnerDir = join(root, "runner-owner-async");
  await mkdir(asyncRunnerDir, { recursive: true });
  const asyncStartedAt = new Date().toISOString();
  await writeFile(join(asyncRunnerDir, "runner.pid"), `${JSON.stringify({
    pid: process.pid, startedAt: asyncStartedAt, processStartedAt,
  })}\n`, { mode: 0o600 });
  let releaseAsyncIdentity;
  let asyncIdentityStarted = false;
  const asyncIdentity = runnerProcessIsCurrentAsync({
    runner_pid: process.pid, runner_process_started_at: processStartedAt, started_at: asyncStartedAt,
  }, asyncRunnerDir, {
    isAlive: () => true,
    getProcessStartTimeAsync: async () => {
      asyncIdentityStarted = true;
      await new Promise((resolvePromise) => { releaseAsyncIdentity = resolvePromise; });
      return Date.parse(processStartedAt);
    },
  });
  await Promise.resolve();
  assert(asyncIdentityStarted === true, "managed-job async runner identity probe did not start");
  let eventLoopResponsive = false;
  await new Promise((resolvePromise) => { setTimeout(() => { eventLoopResponsive = true; resolvePromise(); }, 5); });
  assert(eventLoopResponsive === true, "managed-job async runner identity probe blocked the Node event loop");
  releaseAsyncIdentity();
  assert(await asyncIdentity === true, "managed-job async runner identity lost current-process semantics");
}

async function testRecoveryClaimFailurePreservesRetryState() {
  const jobId = `job_${"H".repeat(24)}`;
  const dir = join(root, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const plan = { name: "recovery claim handshake failure", steps: [], finally_steps: [], resources: {}, temporary_files: [], full_env: false };
  const now = new Date().toISOString();
  const status = {
    job_id: jobId, name: plan.name, status: "interrupted", approval: "mcp",
    plan_sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    created_at: now, updated_at: now, finished_at: now, recovery_attempts: 1,
    owner_kind: "local", owner_account_id: null, owner_account_version: null, owner_client_id: null, owner_family_id: null,
  };
  await writeFile(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await mkdir(join(dir, "recovery.lock"), { mode: 0o700 });
  const recoveryToken = "e".repeat(32);
  const launchToken = "f".repeat(32);
  const child = spawn(process.execPath, [runnerEntry, "--job-dir", dir, "--recover"], {
    env: { ...process.env, MBM_RECOVERY_LOCK_TOKEN: recoveryToken, MBM_RUNNER_LAUNCH_TOKEN: launchToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const { code, stderr } = await runFixtureChild(child, {
    label: "recovery claim handshake",
    prepare: () => publishProvisionalRunnerClaim(dir, child.pid, launchToken),
  });
  const after = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert(code !== 0, "recovery runner unexpectedly accepted a wrong-type recovery-lock claim");
  assert(after.status === "interrupted" && await exists(join(dir, "plan.json")) && !(await exists(join(dir, "result.json"))),
    `recovery-lock handshake failure destroyed retry state: status=${after.status}`);
  assert(stderr.includes("managed job fatal terminal record skipped: reason=runner_claim_unconfirmed"),
    "recovery-lock handshake failure was not classified as pre-terminal runner bootstrap failure");
}

function isolateStepCoverage(plan) {
  const isolate = (step) => ({
    ...step,
    env: { ...(step.env || {}), NODE_V8_COVERAGE: "" },
  });
  return {
    ...plan,
    steps: Array.isArray(plan.steps) ? plan.steps.map(isolate) : plan.steps,
    finally_steps: Array.isArray(plan.finally_steps) ? plan.finally_steps.map(isolate) : plan.finally_steps,
  };
}

function createManagedJobTestManager(options) {
  const manager = new ManagedJobManager({
    ...options,
    runnerSpawnProcess: options.runnerSpawnProcess ?? spawnManagedJobTestRunner,
  });
  const isolateFullEnvStepCoverage = options?.policy?.minimalEnv === false;
  for (const method of ["start", "stage"]) {
    const original = manager[method].bind(manager);
    manager[method] = (plan, ...rest) => original(isolateFullEnvStepCoverage ? isolateStepCoverage(plan) : plan, ...rest);
  }
  return manager;
}

function relayRecoveryQuotaContext({ accountChar = "q", accountVersion = 1, clientChar = "a", familyChar = clientChar, role = "operator" } = {}) {
  return {
    origin: "relay",
    authority: {
      origin: "relay",
      owner: role === "owner",
      principal: {
        kind: "account",
        accountId: `acct_${accountChar.repeat(32)}`,
        accountVersion,
        clientId: `mcp_client_${clientChar.repeat(43)}`,
        familyId: `mcp_family_${familyChar.repeat(43)}`,
        role,
      },
    },
  };
}

async function testManagedJobAccountRecoveryCapacity() {
  assert(NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS === TRANSIENT_PROCESS_RECOVERY_SLOTS,
    "non-owner pending-recovery quota drifted from the bounded transient recovery slot contract");
  const quotaRoot = join(root, "account-pending-recovery-quota-jobs");
  let runnerLaunches = 0;
  const quotaManager = createManagedJobTestManager({
    jobRoot: quotaRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {}, recover: false,
    runnerSpawnProcess: (...args) => { runnerLaunches += 1; return spawnManagedJobTestRunner(...args); },
  });
  const initialPruneAt = quotaManager.lastPruneAt;
  const inventoryBeforeWork = quotaManager.list({ limit: 1 });
  assert(quotaManager.lastPruneAt === initialPruneAt,
    "routine empty/terminal-only inventory repeated full retention maintenance inside the throttle interval");
  assert(!Object.hasOwn(inventoryBeforeWork, "maintenanceRequired"),
    "internal managed-job maintenance decision leaked into the public inventory result");
  const underCapacityJob = quotaManager.createJob({
    name: "under-capacity creation skips retention scan",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false });
  assert(quotaManager.lastPruneAt === initialPruneAt,
    "managed-job creation repeated full retention maintenance while retained state was below capacity");
  quotaManager.list({ limit: 1 });
  assert(quotaManager.lastPruneAt === initialPruneAt,
    "routine inventory repeated full retention maintenance while an under-capacity staged job existed");
  quotaManager.cancel({ job_id: underCapacityJob.job_id });
  const accountA = relayRecoveryQuotaContext();
  const accountASecondClient = relayRecoveryQuotaContext({ clientChar: "b", familyChar: "c" });
  const accountAThirdClient = relayRecoveryQuotaContext({ clientChar: "d", familyChar: "e" });
  const accountB = relayRecoveryQuotaContext({ accountChar: "r", clientChar: "f", familyChar: "g" });
  const accountAOwner = relayRecoveryQuotaContext({ clientChar: "h", familyChar: "i", role: "owner" });
  const pendingIds = [];
  for (let index = 0; index < NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS - 1; index += 1) {
    const context = index % 2 === 0 ? accountA : accountASecondClient;
    const pending = quotaManager.createJob({
      name: `account recovery quota ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: false, retentionClass: "transient_process" }, context);
    quotaManager.cancel({ job_id: pending.job_id });
    pendingIds.push(pending.job_id);
  }
  const replayPlan = {
    idempotency_key: "account-recovery-quota-replay",
    name: "account recovery quota persisted replay",
    steps: [{ argv: [process.execPath, "--version"] }],
  };
  const persisted = quotaManager.createJob(replayPlan,
    { launch: true, retentionClass: "transient_process" }, accountAThirdClient);
  await waitForJob(quotaManager, persisted.job_id);
  pendingIds.push(persisted.job_id);
  assert(runnerLaunches === 1, "account quota persisted replay fixture did not launch exactly one original runner");
  const replay = quotaManager.createJob(replayPlan,
    { launch: true, retentionClass: "transient_process" }, accountAThirdClient);
  assert(replay.job_id === persisted.job_id && replay.idempotency_replay === true && runnerLaunches === 1,
    "full account pending-recovery quota blocked or relaunched a genuine persisted same-key replay");

  const beforeOverflowEntries = (await readdir(quotaRoot)).filter((name) => /^job_/.test(name)).sort();
  let overflowError = null;
  try {
    quotaManager.createJob({
      idempotency_key: "account-recovery-quota-overflow",
      name: "account recovery quota overflow",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: true, retentionClass: "transient_process" }, accountASecondClient);
  } catch (error) { overflowError = error; }
  const afterOverflowEntries = (await readdir(quotaRoot)).filter((name) => /^job_/.test(name)).sort();
  const privateNeedles = [
    accountA.authority.principal.accountId,
    accountASecondClient.authority.principal.clientId,
    accountASecondClient.authority.principal.familyId,
    quotaRoot,
  ];
  assert(overflowError?.code === "limit_exceeded" && overflowError?.retryable === true
    && overflowError?.details?.maximum === NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS
    && overflowError?.details?.capacity_scope === "account_pending_transient_recovery"
    && beforeOverflowEntries.join("\0") === afterOverflowEntries.join("\0") && runnerLaunches === 1,
  "seventeenth same-account pending recovery was not rejected before durable state publication or process launch");
  assert(privateNeedles.every((needle) => !`${overflowError?.message || ""}${JSON.stringify(overflowError?.details || {})}`.includes(needle)),
    "account pending-recovery quota error leaked principal, path, or client/family identity");

  const otherAccount = quotaManager.createJob({
    name: "other account recovery quota",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, accountB);
  const ownerRelay = quotaManager.createJob({
    name: "owner relay recovery quota exemption",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, accountAOwner);
  const local = quotaManager.createJob({
    name: "local recovery quota exemption",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" });
  assert(otherAccount.status === "staged" && ownerRelay.status === "staged" && local.status === "staged",
    "account-version pending-recovery quota spilled into another account, relay owner, or local owner authority");

  assert(clearTransientProcessRecoveryPending(join(quotaRoot, pendingIds[0])) === true,
    "delivery downgrade fixture could not release one account pending-recovery reservation");
  const deliveredReplacement = quotaManager.createJob({
    name: "account quota delivery released replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, accountASecondClient);
  assert(deliveredReplacement.status === "staged", "terminal delivery marker clearing did not release the account pending-recovery quota");

  const expiryId = pendingIds[1];
  const expiryStatusFile = join(quotaRoot, expiryId, "status.json");
  const expiryResultFile = join(quotaRoot, expiryId, "result.json");
  const expiryStatus = JSON.parse(await readFile(expiryStatusFile, "utf8"));
  const expiryResult = JSON.parse(await readFile(expiryResultFile, "utf8"));
  const expiredFinishedAt = new Date(Date.now() - TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS - 1).toISOString();
  expiryStatus.finished_at = expiredFinishedAt;
  expiryResult.finished_at = expiredFinishedAt;
  await writeFile(expiryStatusFile, `${JSON.stringify(expiryStatus, null, 2)}\n`, { mode: 0o600 });
  await writeFile(expiryResultFile, `${JSON.stringify(expiryResult, null, 2)}\n`, { mode: 0o600 });
  const expiredReplacement = quotaManager.createJob({
    name: "account quota expired replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, accountA);
  assert(expiredReplacement.status === "staged", "24-hour pending terminal expiry did not release the account pending-recovery quota");

  const partialRoot = join(root, "account-pending-recovery-partial-jobs");
  const partialManager = createManagedJobTestManager({
    jobRoot: partialRoot, workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false,
  });
  for (let index = 0; index < NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS - 1; index += 1) {
    const pending = partialManager.createJob({ name: `partial quota ${index}`, steps: [{ argv: [process.execPath, "-e", ""] }] },
      { launch: false, retentionClass: "transient_process" }, accountA);
    partialManager.cancel({ job_id: pending.job_id });
  }
  const partialKey = "account-recovery-partial-publication";
  const partialId = `job_${managedJobIdempotencyDigest(partialKey, accountA)}`;
  await mkdir(join(partialRoot, partialId), { mode: 0o700 });
  const filler = partialManager.createJob({ name: "partial quota filler", steps: [{ argv: [process.execPath, "-e", ""] }] },
    { launch: false, retentionClass: "transient_process" }, accountASecondClient);
  partialManager.cancel({ job_id: filler.job_id });
  let partialError = null;
  try {
    partialManager.createJob({
      idempotency_key: partialKey,
      name: "partial quota retry",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: true, retentionClass: "transient_process" }, accountA);
  } catch (error) { partialError = error; }
  assert(partialError?.code === "limit_exceeded" && !(await exists(join(partialRoot, partialId, "status.json"))),
    "statusless deterministic directory was mistaken for an already-counted persisted replay at full account quota");

  const integrityRoot = join(root, "account-pending-recovery-integrity-jobs");
  const integrityManager = createManagedJobTestManager({
    jobRoot: integrityRoot, workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false,
  });
  const malformedId = `job_${"I".repeat(24)}`;
  await mkdir(join(integrityRoot, malformedId), { mode: 0o700 });
  await writeFile(join(integrityRoot, malformedId, "status.json"), "{not-json\n", { mode: 0o600 });
  let integrityError = null;
  try {
    integrityManager.createJob({ name: "quota integrity probe", steps: [{ argv: [process.execPath, "-e", ""] }] },
      { launch: false, retentionClass: "transient_process" }, accountA);
  } catch (error) { integrityError = error; }
  assert(integrityError?.code === "integrity_error" && integrityError?.retryable === false
    && !String(integrityError?.message || "").includes(integrityRoot)
    && !String(integrityError?.message || "").includes(accountA.authority.principal.accountId),
  "unclassifiable retained state did not fail account recovery quota closed with a privacy-safe integrity error");
  await rm(join(integrityRoot, malformedId), { recursive: true, force: true });
  const coercedBindingId = `job_${"B".repeat(24)}`;
  await mkdir(join(integrityRoot, coercedBindingId), { mode: 0o700 });
  await writeFile(join(integrityRoot, coercedBindingId, "status.json"), `${JSON.stringify({
    job_id: coercedBindingId, name: "coerced account binding", status: "staged",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    retention_class: "transient_process", transient_recovery_pending: true,
    owner_kind: "account", owner_account_id: [accountA.authority.principal.accountId],
    owner_account_version: accountA.authority.principal.accountVersion,
    owner_client_id: accountA.authority.principal.clientId,
    owner_family_id: accountA.authority.principal.familyId,
    owner_role: accountA.authority.principal.role,
  })}\n`, { mode: 0o600 });
  let coercedBindingError = null;
  try {
    integrityManager.createJob({ name: "coerced quota binding probe", steps: [{ argv: [process.execPath, "-e", ""] }] },
      { launch: false, retentionClass: "transient_process" }, accountA);
  } catch (error) { coercedBindingError = error; }
  assert(coercedBindingError?.code === "integrity_error" && coercedBindingError?.retryable === false,
    "coerced persisted account binding was ignored instead of failing pending-recovery attribution closed");

  const concurrentRoot = join(root, "account-pending-recovery-concurrent-jobs");
  const concurrentManager = createManagedJobTestManager({
    jobRoot: concurrentRoot, workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false,
  });
  for (let index = 0; index < NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS - 1; index += 1) {
    concurrentManager.createJob({ name: `concurrent quota ${index}`, steps: [{ argv: [process.execPath, "-e", ""] }] },
      { launch: false, retentionClass: "transient_process" }, accountA);
  }
  const moduleUrl = new URL("../../../src/local/managed-jobs.mjs", import.meta.url).href;
  const childSource = `
    import { ManagedJobManager } from ${JSON.stringify(moduleUrl)};
    const [jobRoot, workspace, clientChar] = process.argv.slice(1);
    const context = { origin: "relay", authority: { origin: "relay", owner: false, principal: {
      kind: "account", accountId: "acct_${"q".repeat(32)}", accountVersion: 1,
      clientId: "mcp_client_" + clientChar.repeat(43), familyId: "mcp_family_" + clientChar.repeat(43), role: "operator",
    } } };
    try {
      const manager = new ManagedJobManager({ jobRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false });
      const result = manager.createJob({ name: "concurrent account quota", steps: [{ argv: [process.execPath, "-e", ""] }] },
        { launch: false, retentionClass: "transient_process" }, context);
      process.stdout.write(JSON.stringify({ accepted: true, job_id: result.job_id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ accepted: false, code: error?.code || null, retryable: error?.retryable === true }));
    }
  `;
  const runConcurrentChild = async (char) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, concurrentRoot, workspace, char], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_V8_COVERAGE: "" },
    });
    const { code, stdout } = await runFixtureChild(child, { timeoutMs: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS * 1000, label: "account quota" });
    if (code !== 0) throw new Error(`account quota fixture child failed (${code})`);
    return JSON.parse(stdout);
  };
  const settledChildren = await Promise.allSettled([runConcurrentChild("x"), runConcurrentChild("y")]);
  const childFailures = settledChildren.filter(result => result.status === "rejected").map(result => result.reason);
  if (childFailures.length) throw new AggregateError(childFailures, "concurrent quota fixtures failed");
  const concurrentResults = settledChildren.map(result => result.value);
  const acceptedConcurrent = concurrentResults.filter((result) => result.accepted).length;
  assert(acceptedConcurrent === 1
    && concurrentResults.every((result) => result.accepted || ["conflict", "limit_exceeded"].includes(result.code)),
  `concurrent account pending-recovery submissions did not serialize to one remaining slot: ${JSON.stringify(concurrentResults)}`);
  let concurrentPending = 0;
  for (const entry of await readdir(concurrentRoot)) {
    if (!/^job_/.test(entry)) continue;
    const status = await readManagedJobJson(join(concurrentRoot, entry, "status.json"), 256 * 1024, "job status");
    if (status?.transient_recovery_pending === true && status.owner_account_id === accountA.authority.principal.accountId
        && status.owner_account_version === accountA.authority.principal.accountVersion) concurrentPending += 1;
  }
  assert(concurrentPending === NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS,
    "concurrent account recovery admissions oversubscribed or lost the final bounded pending-recovery slot");
}

async function testManagedJobCapacityBoundary() {
  const terminalRoot = join(root, "capacity-terminal-jobs");
  const terminalManager = createManagedJobTestManager({
    jobRoot: terminalRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
  });
  const heldCapacity = acquireJobCapacityLock(terminalRoot);
  assert(heldCapacity, "capacity boundary fixture could not acquire the root transaction lock");
  let capacityCommitError = null;
  try {
    terminalManager.stage({ name: "blocked capacity commit", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { capacityCommitError = error; }
  heldCapacity.release();
  assert(capacityCommitError?.code === "conflict" && capacityCommitError?.retryable === true
    && capacityCommitError?.details?.capacity_commit_pending === true,
  "concurrent managed-job capacity commit did not fail with a structured retryable conflict");
  const terminalIds = [];
  for (let index = 0; index < MAX_JOBS; index += 1) {
    const staged = terminalManager.stage({
      name: `terminal capacity ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
    terminalIds.push(staged.job_id);
    terminalManager.cancel({ job_id: staged.job_id });
  }
  assert(terminalManager.list({ limit: MAX_LISTED_JOBS }).retained === MAX_JOBS,
    "terminal capacity fixture did not fill the retained-job limit");
  if (process.platform !== "win32") {
    const invalidKey = "capacity-presence-fail-closed";
    const invalidDigest = createHash("sha256")
      .update("machine-bridge-managed-job-idempotency-v1\0").update("local").update("\0").update(invalidKey).digest("hex");
    const invalidDir = join(terminalRoot, `job_${invalidDigest}`);
    await symlink(join(root, "missing-capacity-target"), invalidDir);
    expectThrow(() => terminalManager.start({
      idempotency_key: invalidKey,
      name: "invalid deterministic capacity target",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }), "managed job directory is not a real directory");
    assert(terminalManager.list({ limit: MAX_LISTED_JOBS }).retained === MAX_JOBS,
      "failed deterministic target inspection evicted retained terminal history before admission failed");
    await rm(invalidDir, { force: true });
  }
  const replacement = terminalManager.stage({
    name: "terminal capacity replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const survivingTerminal = (await Promise.all(terminalIds.map((id) => exists(join(terminalRoot, id))))).filter(Boolean).length;
  assert(survivingTerminal === MAX_JOBS - 1
    && terminalManager.list({ limit: MAX_LISTED_JOBS }).retained === MAX_JOBS,
    "full retained-job capacity did not evict exactly one safely removable terminal record for a new job");
  assert(terminalManager.read({ job_id: replacement.job_id }).status === "staged",
    "capacity reservation removed or failed to create the replacement staged job");
  terminalManager.cancel({ job_id: replacement.job_id });
  let missingJobError = null;
  try { terminalManager.read({ job_id: `job_${"Z".repeat(24)}` }); }
  catch (error) { missingJobError = error; }
  assert(missingJobError?.code === "not_found" && missingJobError?.retryable === false
    && !String(missingJobError?.message || "").includes(terminalRoot),
  "missing managed-job recovery state did not return a privacy-safe typed not_found error");

  const recentTransientIds = [];
  for (let index = 0; index < TRANSIENT_PROCESS_RECOVERY_SLOTS; index += 1) {
    const transient = terminalManager.createJob({
      name: `recent transient recovery result ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: false, retentionClass: "transient_process" }, relayOwnerContext());
    terminalManager.cancel({ job_id: transient.job_id });
    if (index !== 0) clearTransientProcessRecoveryPending(join(terminalRoot, transient.job_id));
    recentTransientIds.push(transient.job_id);
  }
  const recentRecoveryCapacity = terminalManager.list({ limit: MAX_LISTED_JOBS }).capacity;
  assert(recentRecoveryCapacity?.transient_terminal === TRANSIENT_PROCESS_RECOVERY_SLOTS
    && recentRecoveryCapacity?.durable_terminal === MAX_JOBS - TRANSIENT_PROCESS_RECOVERY_SLOTS
    && (await Promise.all(recentTransientIds.map((id) => exists(join(terminalRoot, id))))).every(Boolean),
  "saturated managed-job retention did not preserve the bounded recent transient recovery reserve");
  const recentRecoveryList = terminalManager.list({ limit: MAX_LISTED_JOBS });
  assert(recentRecoveryList.jobs.every((job) => !recentTransientIds.includes(job.job_id))
    && recentRecoveryList.recent_process_recovery.length === TRANSIENT_PROCESS_RECOVERY_SLOTS
    && recentRecoveryList.recent_process_recovery.every((job) => recentTransientIds.includes(job.job_id))
    && recentRecoveryList.recent_process_recovery.every((job) => !Object.hasOwn(job, "retention_class")),
  "saturated managed-job inventory did not surface retained recent process recovery handles outside the durable-first primary window");
  const overflowTransient = terminalManager.createJob({
    name: "recent transient recovery overflow",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, relayOwnerContext());
  terminalManager.cancel({ job_id: overflowTransient.job_id });
  const overflowRecoveryCapacity = terminalManager.list({ limit: MAX_LISTED_JOBS }).capacity;
  assert((await Promise.all(recentTransientIds.map((id) => exists(join(terminalRoot, id))))).every(Boolean)
    && await exists(join(terminalRoot, overflowTransient.job_id))
    && overflowRecoveryCapacity?.transient_terminal === TRANSIENT_PROCESS_RECOVERY_SLOTS + 1
    && overflowRecoveryCapacity?.durable_terminal === MAX_JOBS - TRANSIENT_PROCESS_RECOVERY_SLOTS - 1,
  "follow-up-required transient recovery did not outrank ordinary durable terminal history at saturation");
  clearTransientProcessRecoveryPending(join(terminalRoot, overflowTransient.job_id));
  const secondOverflow = terminalManager.createJob({
    name: "recent transient delivery reserve overflow",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" }, relayOwnerContext());
  terminalManager.cancel({ job_id: secondOverflow.job_id });
  clearTransientProcessRecoveryPending(join(terminalRoot, secondOverflow.job_id));
  const secondRecoveryList = terminalManager.list({ limit: MAX_LISTED_JOBS });
  assert(await exists(join(terminalRoot, recentTransientIds[0]))
    && !(await exists(join(terminalRoot, recentTransientIds[1])))
    && secondRecoveryList.recent_process_recovery.some((job) => job.job_id === recentTransientIds[0])
    && secondRecoveryList.recent_process_recovery.length === TRANSIENT_PROCESS_RECOVERY_SLOTS,
  "follow-up-required transient recovery was displaced by newer terminal-delivered helper churn");

  const hardPendingEntries = (await readdir(terminalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^job_/.test(entry.name));
  assert(hardPendingEntries.length === MAX_JOBS,
    "undelivered transient saturation fixture did not begin at the hard retained-state limit");
  const hardPendingIds = hardPendingEntries.map((entry) => entry.name);
  for (const jobId of hardPendingIds) {
    const statusFile = join(terminalRoot, jobId, "status.json");
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    assert(ACTIVE_JOB_STATES.has(status.status) === false,
      "undelivered transient saturation fixture unexpectedly contained active state");
    status.retention_class = "transient_process";
    status.transient_recovery_pending = true;
    await writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  }
  let undeliveredCapacityError = null;
  try {
    terminalManager.stage({
      name: "undelivered transient capacity overflow",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
  } catch (error) { undeliveredCapacityError = error; }
  assert(undeliveredCapacityError?.code === "limit_exceeded" && undeliveredCapacityError?.retryable === true
    && undeliveredCapacityError?.details?.retained_state === MAX_JOBS,
    "undelivered transient saturation did not return retryable capacity backpressure");
  assert((await Promise.all(hardPendingIds.map((id) => exists(join(terminalRoot, id))))).every(Boolean),
    "undelivered transient saturation evicted promised recovery state");

  const deliveredEvictionId = hardPendingIds[0];
  assert(clearTransientProcessRecoveryPending(join(terminalRoot, deliveredEvictionId)) === true,
    "delivery downgrade fixture could not clear the pending recovery marker");
  const deliveredReplacement = terminalManager.stage({
    name: "delivery-downgraded capacity replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  assert(!(await exists(join(terminalRoot, deliveredEvictionId)))
    && terminalManager.read({ job_id: deliveredReplacement.job_id }).status === "staged",
    "delivered transient recovery did not become evictable under saturated capacity");
  terminalManager.cancel({ job_id: deliveredReplacement.job_id });
  const deliveredReplacementStatusFile = join(terminalRoot, deliveredReplacement.job_id, "status.json");
  const deliveredReplacementStatus = JSON.parse(await readFile(deliveredReplacementStatusFile, "utf8"));
  deliveredReplacementStatus.retention_class = "transient_process";
  deliveredReplacementStatus.transient_recovery_pending = true;
  await writeFile(deliveredReplacementStatusFile, `${JSON.stringify(deliveredReplacementStatus, null, 2)}\n`, { mode: 0o600 });

  const expiryEvictionId = hardPendingIds[1];
  const expiryStatusFile = join(terminalRoot, expiryEvictionId, "status.json");
  const expiryResultFile = join(terminalRoot, expiryEvictionId, "result.json");
  const expiryStatus = JSON.parse(await readFile(expiryStatusFile, "utf8"));
  const expiryResult = JSON.parse(await readFile(expiryResultFile, "utf8"));
  const expiredFinishedAt = new Date(Date.now() - TRANSIENT_PROCESS_PENDING_RECOVERY_GRACE_MS - 1).toISOString();
  expiryStatus.finished_at = expiredFinishedAt;
  expiryResult.finished_at = expiredFinishedAt;
  await writeFile(expiryStatusFile, `${JSON.stringify(expiryStatus, null, 2)}\n`, { mode: 0o600 });
  await writeFile(expiryResultFile, `${JSON.stringify(expiryResult, null, 2)}\n`, { mode: 0o600 });
  const expiredReplacement = terminalManager.stage({
    name: "expired-undelivered capacity replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  assert(!(await exists(join(terminalRoot, expiryEvictionId)))
    && terminalManager.read({ job_id: expiredReplacement.job_id }).status === "staged",
    "expired undelivered transient recovery did not become evictable after 24 hours");
  terminalManager.cancel({ job_id: expiredReplacement.job_id });

  const durableHelperRoot = join(root, "durable-helper-retention-jobs");
  const durableHelperManager = createManagedJobTestManager({
    jobRoot: durableHelperRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
  });
  const durableHelper = durableHelperManager.startDurableProcess({
    sourceTool: "run_process",
    name: "retention class wiring",
    argv: [process.execPath, "-e", ""],
    cwd: workspace,
    timeoutSeconds: 30,
  }, relayOwnerContext());
  await waitForJob(durableHelperManager, durableHelper.job_id);
  const durableHelperPrivateStatus = JSON.parse(await readFile(join(durableHelperRoot, durableHelper.job_id, "status.json"), "utf8"));
  assert(durableHelperPrivateStatus.retention_class === "transient_process"
    && durableHelperPrivateStatus.transient_recovery_pending === true,
  "durable one-step process carrier did not persist its private follow-up recovery state through terminal settlement");
  const durableHelperPublic = await durableHelperManager.readHosted({ job_id: durableHelper.job_id });
  const durableHelperDeliveredStatus = JSON.parse(await readFile(join(durableHelperRoot, durableHelper.job_id, "status.json"), "utf8"));
  assert(!Object.hasOwn(durableHelperPublic, "retention_class")
    && !Object.hasOwn(durableHelperPublic, "transient_recovery_pending")
    && !Object.hasOwn(durableHelperDeliveredStatus, "transient_recovery_pending")
    && !durableHelperManager.list({ limit: 10 }).jobs.some((job) => Object.hasOwn(job, "retention_class") || Object.hasOwn(job, "transient_recovery_pending")),
  "hosted terminal read did not downgrade private follow-up recovery state or leaked it through public projections");

  const hostedBudgetContext = { origin: "relay", authority: { origin: "relay", owner: true, principal: {
    kind: "account", accountId: `acct_${"h".repeat(32)}`, accountVersion: 1,
    clientId: `mcp_client_${"h".repeat(43)}`, familyId: `mcp_family_${"h".repeat(43)}`, role: "owner",
  } } };
  const hostedBudgetHelper = durableHelperManager.startDurableProcess({
    sourceTool: "run_process", name: "hosted aggregate output budget",
    argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(60000))"], cwd: workspace, timeoutSeconds: 30,
  }, hostedBudgetContext);
  const hostedBudgetResult = await waitForJob(durableHelperManager, hostedBudgetHelper.job_id, null, MANAGED_JOB_TEST_WAIT_MS, hostedBudgetContext);
  const hostedBudgetStep = hostedBudgetResult.result.steps[0];
  assert(hostedBudgetResult.result.capture_limit_bytes === 32 * 1024
    && Buffer.byteLength(hostedBudgetStep.stdout) <= 32 * 1024 && hostedBudgetStep.stdout_truncated_bytes > 0,
  "hosted account transient durable helper did not enforce or disclose the 32 KiB aggregate capture budget");

  const localDurableHelper = durableHelperManager.startDurableProcess({
    sourceTool: "run_process",
    name: "local retention class wiring",
    argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(60000))"],
    cwd: workspace,
    timeoutSeconds: 30,
    idempotencyKey: "local-retention-class-wiring",
  });
  const localDurableResult = await waitForJob(durableHelperManager, localDurableHelper.job_id);
  const localDurableHelperStatus = JSON.parse(await readFile(join(durableHelperRoot, localDurableHelper.job_id, "status.json"), "utf8"));
  assert(localDurableHelperStatus.retention_class === "transient_process"
    && !Object.hasOwn(localDurableHelperStatus, "transient_recovery_pending")
    && localDurableResult.result.capture_limit_bytes === 256 * 1024
    && Buffer.byteLength(localDurableResult.result.steps[0].stdout) === 60000
    && localDurableResult.result.steps[0].stdout_truncated_bytes === 0,
  "local idempotent durable helper lost its existing 256 KiB capture capacity or retained hosted follow-up priority");

  const recoveryVisibilityRoot = join(root, "recovery-visibility-jobs");
  const recoveryVisibilityManager = createManagedJobTestManager({
    jobRoot: recoveryVisibilityRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {}, recover: false,
  });
  const olderActive = recoveryVisibilityManager.createJob({
    name: "older active recovery job",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false });
  const olderActiveDir = join(recoveryVisibilityRoot, olderActive.job_id);
  const olderActiveStatusFile = join(olderActiveDir, "status.json");
  const olderActiveStatus = JSON.parse(await readFile(olderActiveStatusFile, "utf8"));
  const olderActiveStartedAt = new Date().toISOString();
  Object.assign(olderActiveStatus, {
    status: "running",
    approval: "mcp",
    runner_pid: process.pid,
    current_phase: "steps",
    current_step: 0,
    started_at: olderActiveStartedAt,
    updated_at: olderActiveStartedAt,
    cleanup_guarantee: "best-effort-finally-and-recovery",
  });
  await writeFile(olderActiveStatusFile, `${JSON.stringify(olderActiveStatus, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(olderActiveDir, "runner.pid"), `${JSON.stringify({ pid: process.pid, startedAt: olderActiveStartedAt })}\n`, { mode: 0o600 });
  const durableTerminal = recoveryVisibilityManager.start({
    name: "older durable terminal recovery result",
    steps: [{ argv: [process.execPath, "--version"] }],
  });
  await waitForJob(recoveryVisibilityManager, durableTerminal.job_id);
  for (let index = 0; index < MAX_LISTED_JOBS + 10; index += 1) {
    const helper = recoveryVisibilityManager.createJob({
      name: `newer transient helper ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: false, retentionClass: "transient_process" });
    recoveryVisibilityManager.cancel({ job_id: helper.job_id });
  }
  const recoveryVisibilityList = recoveryVisibilityManager.list({ limit: MAX_LISTED_JOBS });
  assert(recoveryVisibilityList.jobs.some((job) => job.job_id === olderActive.job_id && ACTIVE_JOB_STATES.has(job.status)),
    "newer terminal helper churn hid an older active managed job from the bounded recovery inventory");
  assert(recoveryVisibilityList.jobs.some((job) => job.job_id === durableTerminal.job_id && job.status === "succeeded"),
    "newer transient helper churn hid an older durable terminal recovery result from the bounded inventory");
  assert(recoveryVisibilityList.recent_activity?.created_last_15m >= MAX_LISTED_JOBS + 11
    && recoveryVisibilityList.recent_activity?.transient_process_last_15m >= MAX_LISTED_JOBS + 10
    && recoveryVisibilityList.capacity?.durable_terminal >= 1
    && recoveryVisibilityList.capacity?.transient_terminal >= MAX_LISTED_JOBS + 10,
  "managed-job listing did not expose bounded recent helper-churn diagnostics");
  const delegatedRecoveryList = recoveryVisibilityManager.list({ limit: 10 }, relayDelegatedContext());
  assert(!Object.hasOwn(delegatedRecoveryList, "recent_activity") && !Object.hasOwn(delegatedRecoveryList, "capacity")
    && Array.isArray(delegatedRecoveryList.recent_process_recovery)
    && delegatedRecoveryList.recent_process_recovery.every((job) => !Object.hasOwn(job, "retention_class")),
    "non-owner managed-job listing exposed global recent job activity or retained-state composition");

  const mixedRoot = join(root, "capacity-mixed-retention-jobs");
  const mixedManager = createManagedJobTestManager({
    jobRoot: mixedRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
  });
  const protectedManaged = mixedManager.start({
    name: "explicit managed recovery result",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  await waitForJob(mixedManager, protectedManaged.job_id);
  const dependencyProtector = mixedManager.stage({
    name: "active plan retaining explicit dependency",
    depends_on: [protectedManaged.job_id],
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const transientIds = [];
  for (let index = 0; index < MAX_JOBS - 2; index += 1) {
    const transient = mixedManager.createJob({
      name: `transient helper ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, { launch: false, retentionClass: "transient_process" });
    transientIds.push(transient.job_id);
    mixedManager.cancel({ job_id: transient.job_id });
  }
  const transientReplacement = mixedManager.createJob({
    name: "transient helper replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  }, { launch: false, retentionClass: "transient_process" });
  assert(await exists(join(mixedRoot, protectedManaged.job_id)),
    "transient helper churn evicted an explicit managed-job recovery result while transient terminal history was removable");
  const survivingTransient = (await Promise.all(transientIds.map((id) => exists(join(mixedRoot, id))))).filter(Boolean).length;
  assert(survivingTransient === MAX_JOBS - 3
    && mixedManager.list({ limit: MAX_LISTED_JOBS }).retained === MAX_JOBS,
    "mixed retention pruning did not reclaim exactly one transient helper record at the hard capacity boundary");
  mixedManager.cancel({ job_id: dependencyProtector.job_id });
  mixedManager.cancel({ job_id: transientReplacement.job_id });
  assert(!Object.hasOwn(mixedManager.read({ job_id: transientReplacement.job_id }), "retention_class")
    && !mixedManager.list({ limit: MAX_LISTED_JOBS }).jobs.some((job) => Object.hasOwn(job, "retention_class")),
  "internal transient-process retention class leaked through public managed-job projections");

  const stagedRoot = join(root, "capacity-staged-jobs");
  const stagedManager = createManagedJobTestManager({
    jobRoot: stagedRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
    logger: { warn() {} },
  });
  const stagedIds = [];
  for (let index = 0; index < MAX_JOBS; index += 1) {
    stagedIds.push(stagedManager.stage({
      name: `staged capacity ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }).job_id);
  }
  let capacityError = null;
  try {
    stagedManager.stage({
      name: "staged capacity overflow",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
  } catch (error) { capacityError = error; }
  assert(capacityError?.code === "limit_exceeded" && capacityError?.retryable === true,
    "fully active/staged managed-job capacity did not return a structured retryable limit error");
  assert(stagedManager.list({ limit: MAX_LISTED_JOBS }).retained === MAX_JOBS,
    "capacity reservation evicted a staged/active job to admit an overflow job");

  await rm(join(stagedRoot, stagedIds.pop()), { recursive: true, force: true });
  const retiredCapacityDir = join(stagedRoot, `retired_job_${"V".repeat(24)}_d0_i0`);
  await mkdir(retiredCapacityDir, { mode: 0o700 });
  let retiredCapacityError = null;
  try {
    stagedManager.stage({ name: "retired state capacity overflow", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { retiredCapacityError = error; }
  const ownerCapacityList = stagedManager.list({ limit: MAX_LISTED_JOBS });
  assert(retiredCapacityError?.code === "limit_exceeded"
    && retiredCapacityError?.details?.retained_state === MAX_JOBS
    && retiredCapacityError?.details?.retired_state === 1
    && retiredCapacityError?.details?.retired_unreadable === 1
    && ownerCapacityList.retained === MAX_JOBS - 1
    && ownerCapacityList.capacity?.retained_state === MAX_JOBS
    && ownerCapacityList.capacity?.retired_state === 1
    && ownerCapacityList.capacity?.retired_unreadable === 1,
  "unreadable retired managed-job state escaped the hard retained-state capacity boundary or owner diagnostics");
  const delegatedCapacityList = stagedManager.list({ limit: MAX_LISTED_JOBS }, relayDelegatedContext());
  assert(!("capacity" in delegatedCapacityList), "non-owner list_jobs exposed global retained-state capacity diagnostics");
  await rm(retiredCapacityDir, { recursive: true, force: true });

  const wrongTypeId = `job_${"W".repeat(24)}`;
  const wrongTypePath = join(stagedRoot, wrongTypeId);
  await writeFile(wrongTypePath, "not-a-job-directory\n", { mode: 0o600 });
  let wrongTypeCapacityError = null;
  try {
    stagedManager.stage({ name: "wrong-type state capacity overflow", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { wrongTypeCapacityError = error; }
  const wrongTypeList = stagedManager.list({ limit: MAX_LISTED_JOBS });
  assert(wrongTypeCapacityError?.code === "limit_exceeded"
    && wrongTypeCapacityError?.details?.retained_state === MAX_JOBS
    && wrongTypeCapacityError?.details?.job_state_unreadable === 1
    && wrongTypeList.retained === MAX_JOBS
    && wrongTypeList.jobs.some((job) => job.job_id === wrongTypeId && job.status === "unreadable")
    && wrongTypeList.capacity?.retained_state === MAX_JOBS && wrongTypeList.capacity?.job_state_unreadable === 1
    && activeManagedJobs(stagedRoot).some((job) => job.job_id === wrongTypeId && job.status === "unreadable"),
  "wrong-type public managed-job state escaped retained-state capacity or destructive inventory");
  const delegatedWrongTypeList = stagedManager.list({ limit: MAX_LISTED_JOBS }, relayDelegatedContext());
  assert(!delegatedWrongTypeList.jobs.some((job) => job.job_id === wrongTypeId) && !("capacity" in delegatedWrongTypeList),
    "non-owner list_jobs exposed wrong-type global job state or capacity diagnostics");
  await rm(wrongTypePath, { force: true });
}

async function testManagedJobDependencies() {
  const dependencyRoot = join(root, "dependency-jobs");
  const manager = createManagedJobTestManager({
    jobRoot: dependencyRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
  });
  const upstream = await pendingDependencyFixture(manager, "dependency upstream success");
  const downstream = manager.start({
    name: "dependency downstream success",
    depends_on: [upstream.job_id],
    temporary_files: [{ name: "dependency-helper.txt", content: "ready\n" }],
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  assert(downstream.dependency_total === 1 && downstream.recovery?.job_id === downstream.job_id
    && downstream.recovery?.same_response_followup_supported === true,
  "managed-job acceptance did not expose durable dependency/recovery metadata");
  const waitDeadline = Date.now() + 10_000;
  let waiting = null;
  while (Date.now() < waitDeadline) {
    const value = manager.read({ job_id: downstream.job_id });
    if (value.current_phase === "dependency_wait") { waiting = value; break; }
    if (!["queued", "running"].includes(value.status)) break;
    await delay(25);
  }
  assert(waiting?.status === "queued" && waiting.dependency_total === 1 && waiting.dependency_pending_count === 1,
    "dependent managed job did not remain in explicit pre-execution dependency_wait state");
  assert(!(await exists(join(dependencyRoot, downstream.job_id, "runtime", "files"))),
    "dependency_wait materialized private temporary files before the job became executable");
  await settleDependencyFixture(manager, upstream.job_id, "succeeded");
  const downstreamResult = await waitForJob(manager, downstream.job_id);
  assert(downstreamResult.status === "succeeded" && downstreamResult.dependency_pending_count === 0
    && downstreamResult.result?.steps?.[0]?.code === 0,
  "successful managed-job dependency did not release the downstream job exactly after terminal success");

  const failingUpstream = await pendingDependencyFixture(manager, "dependency upstream failure");
  const blockedDownstream = manager.start({
    name: "dependency downstream blocked",
    depends_on: [failingUpstream.job_id],
    temporary_files: [{ name: "cleanup-helper.txt", content: "cleanup-ready\n" }],
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
    finally_steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  const blockedWaitDeadline = Date.now() + 10_000;
  while (Date.now() < blockedWaitDeadline) {
    const value = manager.read({ job_id: blockedDownstream.job_id });
    if (value.current_phase === "dependency_wait") break;
    await delay(25);
  }
  assert(!(await exists(join(dependencyRoot, blockedDownstream.job_id, "runtime", "files"))),
    "failed dependency fixture materialized private cleanup inputs while still waiting");
  await settleDependencyFixture(manager, failingUpstream.job_id, "failed", "execution_failed");
  const blockedResult = await waitForJob(manager, blockedDownstream.job_id);
  assert(blockedResult.status === "failed" && blockedResult.error_class === "dependency_failed"
    && blockedResult.dependency_pending_count === 0
    && blockedResult.result?.error_class === "dependency_failed"
    && blockedResult.result?.dependency_failure?.dependency_job_id === failingUpstream.job_id
    && blockedResult.result?.dependency_failure?.dependency_status === "failed"
    && blockedResult.result?.steps?.length === 0
    && blockedResult.result?.finally_steps?.[0]?.code === 0,
  "failed upstream dependency did not propagate a structured dependency_failed terminal result");

  let alreadyFailed = null;
  try {
    manager.start({
      name: "already failed dependency rejection",
      depends_on: [failingUpstream.job_id],
      steps: [{ argv: [process.execPath, "--version"] }],
    });
  } catch (error) { alreadyFailed = error; }
  assert(alreadyFailed?.code === "conflict" && alreadyFailed?.retryable === false
    && alreadyFailed?.details?.reason === "dependency_failed",
    "already-failed dependency was accepted into another impossible long wait");

  const recoveryUpstream = await pendingDependencyFixture(manager, "dependency recovery upstream");
  const recoveryDownstream = manager.start({
    name: "dependency wait runner recovery",
    depends_on: [recoveryUpstream.job_id],
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  const recoveryWaitDeadline = Date.now() + 10_000;
  let recoveryWaiting = null;
  while (Date.now() < recoveryWaitDeadline) {
    const value = manager.read({ job_id: recoveryDownstream.job_id });
    if (value.current_phase === "dependency_wait") { recoveryWaiting = value; break; }
    await delay(25);
  }
  assert(recoveryWaiting?.status === "queued", "dependency recovery fixture never entered dependency_wait");
  const recoveryStatusPath = join(dependencyRoot, recoveryDownstream.job_id, "status.json");
  const recoveryPrivateStatus = JSON.parse(await readFile(recoveryStatusPath, "utf8"));
  const killedRunnerPid = Number(recoveryPrivateStatus.runner_pid || 0);
  assert(killedRunnerPid > 0, "dependency recovery fixture did not expose its private runner pid");
  process.kill(killedRunnerPid, "SIGKILL");
  await waitForPidExit(killedRunnerPid, 10_000);
  await delay(10_100);
  const recoveryCheckpoint = manager.read({ job_id: recoveryDownstream.job_id });
  assert(["queued", "running"].includes(recoveryCheckpoint.status) && recoveryCheckpoint.recovery_attempts === 1,
    "dead dependency-wait runner was not relaunched as the original pre-execution job");
  assert(recoveryCheckpoint.recovery_history?.length === 1
    && recoveryCheckpoint.recovery_history[0].attempt === 1
    && recoveryCheckpoint.recovery_history[0].reason === "dependency_wait_runner_interrupted"
    && Number.isFinite(Date.parse(recoveryCheckpoint.recovery_history[0].at)),
  "dependency-wait runner recovery lost bounded reason/time attribution");
  await settleDependencyFixture(manager, recoveryUpstream.job_id, "succeeded");
  const recoveryResult = await waitForJob(manager, recoveryDownstream.job_id);
  assert(recoveryResult.status === "succeeded" && recoveryResult.recovery_attempts === 1
    && recoveryResult.result?.steps?.[0]?.code === 0,
    "dependency-wait runner recovery ended in cleanup-only recovery or lost the downstream execution");

  const orphanGate = await pendingDependencyFixture(manager, "dependency autonomous recovery gate");
  const orphanUpstream = manager.start({
    name: "dependency upstream runner crash",
    depends_on: [orphanGate.job_id],
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  const orphanDownstream = manager.start({
    name: "dependency downstream autonomous recovery",
    depends_on: [orphanUpstream.job_id],
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  const orphanWaitDeadline = Date.now() + 10_000;
  while (Date.now() < orphanWaitDeadline) {
    const value = manager.read({ job_id: orphanDownstream.job_id });
    if (value.current_phase === "dependency_wait") break;
    await delay(25);
  }
  const orphanStatusPath = join(dependencyRoot, orphanUpstream.job_id, "status.json");
  let orphanStatus = null;
  const orphanRunnerDeadline = Date.now() + 10_000;
  while (Date.now() < orphanRunnerDeadline) {
    try {
      orphanStatus = JSON.parse(await readFile(orphanStatusPath, "utf8"));
      if (orphanStatus.current_phase === "dependency_wait" && Number(orphanStatus.runner_pid) > 0) break;
    } catch {}
    await delay(25);
  }
  assert(orphanStatus?.current_phase === "dependency_wait" && Number(orphanStatus?.runner_pid) > 0,
    "runner-crash recovery fixture did not persist dependency-wait runner ownership");
  process.kill(orphanStatus.runner_pid, "SIGKILL");
  await waitForPidExit(orphanStatus.runner_pid, 10_000);
  const autonomousDeadline = Date.now() + RUNNER_EXIT_RECOVERY_TEST_WAIT_MS;
  let autonomousStatus = null;
  while (Date.now() < autonomousDeadline) {
    try {
      autonomousStatus = JSON.parse(await readFile(orphanStatusPath, "utf8"));
      if (autonomousStatus.recovery_attempts === 1 && Number(autonomousStatus.runner_pid) > 0
        && Number(autonomousStatus.runner_pid) !== Number(orphanStatus.runner_pid)) break;
    } catch {}
    await delay(50);
  }
  assert(autonomousStatus?.recovery_attempts === 1 && Number(autonomousStatus?.runner_pid) > 0,
    "same-daemon runner exit did not autonomously relaunch a dependency-wait runner");
  assert(autonomousStatus?.recovery_history?.length === 1
    && autonomousStatus.recovery_history[0].reason === "dependency_wait_runner_interrupted",
  "same-daemon dependency-wait recovery lost its attribution record");
  await settleDependencyFixture(manager, orphanGate.job_id, "failed", "execution_failed");
  const orphanResult = await waitForJob(manager, orphanDownstream.job_id);
  assert(orphanResult.status === "failed" && orphanResult.error_class === "dependency_failed"
    && orphanResult.result?.steps?.length === 0
    && orphanResult.result?.dependency_failure?.dependency_job_id === orphanUpstream.job_id
    && orphanResult.result?.dependency_failure?.dependency_status === "failed"
    && orphanResult.result?.dependency_failure?.dependency_error_class === "dependency_failed",
  `daemon-lifetime runner-exit recovery did not propagate the interrupted upstream as a failed dependency: ${JSON.stringify({
    status: orphanResult.status,
    error_class: orphanResult.error_class,
    dependency_status: orphanResult.result?.dependency_failure?.dependency_status ?? null,
    dependency_error_class: orphanResult.result?.dependency_failure?.dependency_error_class ?? null,
    dependency_matches_upstream: orphanResult.result?.dependency_failure?.dependency_job_id === orphanUpstream.job_id,
    steps: orphanResult.result?.steps?.length ?? null,
  })}`);

  const stagedDependency = manager.stage({
    name: "staged dependency",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  let stagedDependencyError = null;
  try {
    manager.start({
      name: "staged dependency rejection",
      depends_on: [stagedDependency.job_id],
      steps: [{ argv: [process.execPath, "--version"] }],
    });
  } catch (error) { stagedDependencyError = error; }
  assert(stagedDependencyError?.code === "invalid_request" && stagedDependencyError?.retryable === false,
    "staged dependency was accepted even though staged jobs cannot become executable");
  manager.cancel({ job_id: stagedDependency.job_id });
}

async function testDependencyResultFirstProjection() {
  const projectionRoot = join(root, "dependency-result-first");
  const jobId = `job_${"r".repeat(24)}`;
  const dir = join(projectionRoot, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  await writeFile(join(dir, "status.json"), `${JSON.stringify({
    job_id: jobId,
    status: "running",
    plan_sha256: "a".repeat(64),
    created_at: now,
    updated_at: now,
    result_persisted: null,
  })}\n`, { mode: 0o600 });
  await writeFile(join(dir, "result.json"), `${JSON.stringify({
    job_id: jobId,
    status: "succeeded",
    steps: [],
    finally_steps: [],
    error_class: null,
    cleanup_error_class: null,
    finished_at: now,
  })}\n`, { mode: 0o600 });
  const projected = readManagedJobDependencyStatus(projectionRoot, jobId);
  assert(projected.status === "succeeded" && projected.result_persisted === true,
    "dependency polling ignored a durable terminal result during the result-first/status-second crash window");
  const stored = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert(stored.status === "running",
    "dependency polling mutated upstream status instead of using a read-only terminal projection");
}

async function testManagedJobActiveChildSafety() {
  const activeRoot = join(root, "active-child-safety");
  await mkdir(activeRoot, { recursive: true, mode: 0o700 });
  const file = join(activeRoot, "active-child.json");
  const startedAt = Date.now() - 1_000;
  let current = true;
  let terminateCalls = 0;
  const claim = publishManagedJobActiveChild(file, { pid: 424242, exitCode: null, signalCode: null }, {
    processStartTime: () => startedAt,
    isAlive: () => true,
    processState: () => "running",
    randomBytes: () => Buffer.alloc(16, 7),
  });
  const inspectProcess = () => current
    ? { current: true, alive: true, reason: "current_process" }
    : { current: false, alive: false, reason: "not_running" };
  assert(managedJobActiveChildRecoveryReady(file, { inspectProcess, processState: () => "running" }) === false,
    "live active-child ownership was incorrectly declared safe for destructive recovery");
  await terminateManagedJobActiveChild(file, {
    inspectProcess,
    processState: () => "running",
    terminate: () => { terminateCalls += 1; current = false; return true; },
    terminateWithEscalation(child, options) {
      options.terminate(child, "SIGTERM", options);
      options.onTerminationSettled();
    },
  });
  assert(terminateCalls === 1 && !(await exists(file)),
    "verified active-child termination did not clear the exact ownership claim");

  publishManagedJobActiveChild(file, { pid: claim.pid, exitCode: null, signalCode: null }, {
    processStartTime: () => startedAt,
    isAlive: () => true,
    processState: () => "running",
    randomBytes: () => Buffer.alloc(16, 8),
  });
  let unsafeTerminateCalls = 0;
  let unsafeError = null;
  try {
    await terminateManagedJobActiveChild(file, {
      inspectProcess: () => ({ current: false, alive: true, reason: "unverifiable" }),
      processState: () => "running",
      terminate: () => { unsafeTerminateCalls += 1; return true; },
    });
  } catch (error) { unsafeError = error; }
  assert(unsafeError && unsafeTerminateCalls === 0 && await exists(file),
    "unverifiable active-child ownership was signalled or deleted instead of failing closed");

  const unverifiedFile = join(activeRoot, "active-child-unverified.json");
  expectThrow(() => publishManagedJobActiveChild(unverifiedFile, { pid: 515151, exitCode: null, signalCode: null }, {
    processStartTime: () => null,
    isAlive: () => true,
    processState: () => "running",
    now: () => startedAt,
    randomBytes: () => Buffer.alloc(16, 9),
  }), "child process identity could not be verified");
  assert(!(await exists(unverifiedFile)),
    "unverified live active child published an ownership claim that crash recovery could not safely enforce");
  const exitedWithoutIdentity = publishManagedJobActiveChild(unverifiedFile, { pid: 515151, exitCode: 0, signalCode: null }, {
    processStartTime: () => null,
    isAlive: () => false,
    processState: () => "unknown",
  });
  assert(exitedWithoutIdentity === null && !(await exists(unverifiedFile)),
    "already-settled child required unverifiable ownership evidence");

  const coercedClaimFile = join(activeRoot, "active-child-coerced-token.json");
  await writeFile(coercedClaimFile, `${JSON.stringify({
    schema_version: 1,
    pid: 616161,
    token: ["a".repeat(32)],
    startedAt: new Date(startedAt).toISOString(),
    processStartedAt: new Date(startedAt).toISOString(),
    processIdentityVerified: true,
    processGroupIsolated: process.platform !== "win32",
  })}\n`, { mode: 0o600 });
  await expectReject(
    terminateManagedJobActiveChild(coercedClaimFile, {
      inspectProcess: () => ({ current: true, alive: true, reason: "current_process" }),
      processState: () => "running",
      terminate: () => { throw new Error("coerced active-child authority reached process termination"); },
    }),
    "managed job active child claim is invalid",
  );
  await rm(coercedClaimFile, { force: true });
}

function testDependencyPlanBackwardCompatibility() {
  const base = {
    name: "legacy no-dependency canonical plan",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  };
  const context = { workspace, resources: {}, fullEnv: false, unrestrictedPaths: false };
  const omitted = validatePlan(base, context);
  const explicit = validatePlan({ ...base, depends_on: [] }, context);
  assert(!Object.hasOwn(omitted, "depends_on"),
    "omitted depends_on changed the canonical plan shape and would break pre-generation-7 idempotency replay hashes");
  assert(Object.hasOwn(explicit, "depends_on") && explicit.depends_on.length === 0,
    "explicit empty depends_on was not preserved as an explicit generation-7 plan field");
}

function testDependencySuccessClassification() {
  assert(managedJobDependencySucceeded({ status: "succeeded", result_persisted: true }) === true,
    "successful terminal dependency was not recognized as successful");
  for (const status of ["recovered", "succeeded_cleanup_failed", "failed", "recovery_failed", "cancelled"]) {
    assert(managedJobDependencySucceeded({ status, result_persisted: true }) === false,
      `non-success terminal dependency ${status} was allowed to release downstream business execution`);
  }
  assert(managedJobDependencySucceeded({ status: "succeeded", result_persisted: false }) === false,
    "dependency with an unpersisted terminal result was allowed to release downstream business execution");
  assert(managedJobDependencyCount(-9) === 0 && managedJobDependencyCount(99) === 16
    && managedJobDependencyCount("1.5", 4, 7) === 4,
  "dependency-count projection stopped bounding malformed persisted state");
  const label = managedJobDependencyLabel("RESOURCE /Users/private\nTOKEN");
  assert(label === "resource__users_private_token" && !label.includes("/") && !label.includes("\n"),
    "dependency error-label projection stopped normalizing persisted diagnostic text");
}

async function testUnreadableDependencyProtectionFailsClosed() {
  const protectionRoot = join(root, "dependency-retention-fail-closed");
  const warnings = [];
  const manager = createManagedJobTestManager({
    jobRoot: protectionRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
    runnerEnvironmentOverrides: {
      AGENT_RESOURCE_COORDINATOR_ROOT: join(protectionRoot, "resource-coordinator"),
      AGENT_BUILD_ROOT: join(protectionRoot, "build-cache"),
    },
    logger: { warn(message, details) { warnings.push({ message, details }); } },
  });
  const upstream = manager.start({
    name: "old protected dependency result",
    steps: [{ argv: [process.execPath, "--version"] }],
  });
  const upstreamResult = await waitForJob(manager, upstream.job_id);
  assert(upstreamResult.status === "succeeded",
    `dependency-retention fixture upstream did not settle successfully: ${upstreamResult.status}/${upstreamResult.error_class || "none"}`);
  const dependent = manager.stage({
    name: "dependency plan that becomes unreadable",
    depends_on: [upstream.job_id],
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const upstreamDir = join(protectionRoot, upstream.job_id);
  const oldFinishedAt = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const statusPath = join(upstreamDir, "status.json");
  const resultPath = join(upstreamDir, "result.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  status.finished_at = oldFinishedAt;
  status.updated_at = oldFinishedAt;
  result.finished_at = oldFinishedAt;
  await writeFile(statusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  const dependentPlanPath = join(protectionRoot, dependent.job_id, "plan.json");
  const dependentPlan = JSON.parse(await readFile(dependentPlanPath, "utf8"));
  dependentPlan.depends_on = [];
  await writeFile(dependentPlanPath, `${JSON.stringify(dependentPlan)}\n`, { mode: 0o600 });

  manager.list({ limit: MAX_LISTED_JOBS });
  assert(await exists(upstreamDir),
    "unreadable active dependency protection allowed age-based pruning of a possibly referenced terminal job");
  assert(warnings.some(({ message }) => /could not determine active dependency protection/i.test(message)),
    "unreadable active dependency protection failed closed without a bounded diagnostic warning");
}

  function testTerminalPersistenceBoundary() {
  assert(managedJobFinalStatus({ recover: true, cancelled: false, mainError: new Error("resource snapshot changed"), cleanupError: null }) === "recovery_failed",
    "recovery ignored a pre-cleanup resource/state failure and reported success");
  assert(managedJobFinalStatus({ recover: true, cancelled: false, mainError: null, cleanupError: null }) === "recovered",
    "clean recovery was not reported as recovered");
  const terminalStates = new Set(["failed"]);
  assert(!isSettledTerminalJob({ status: "failed", artifact_cleanup_pending: true }, terminalStates),
    "terminal cleanup checkpoint was mistaken for fully settled job state");
  assert(isSettledTerminalJob({ status: "failed", artifact_cleanup_pending: false }, terminalStates),
    "cleanup-confirmed terminal job was not treated as settled");

  const status = { job_id: `job_${"P".repeat(24)}`, name: "persistence boundary", status: "running" };
  const result = {
    job_id: status.job_id, name: status.name, status: "failed", steps: [], finally_steps: [],
    error_class: "execution_failed", cleanup_error_class: null, finished_at: new Date().toISOString(),
  };

  const resultFailureWrites = [];
  const resultFailureRemoved = [];
  const resultFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan", "pid"], status, result,
    writeJson(file, value) {
      if (file === "result") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      resultFailureWrites.push(structuredClone(value));
    },
    removeFile(file) { resultFailureRemoved.push(file); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(resultFailure.statusPersisted && !resultFailure.resultPersisted && resultFailure.artifactsScrubbed, "result persistence failure did not preserve a terminal status");
  assert(resultFailure.status.result_persisted === false && resultFailure.status.terminal_record_error_class === "storage_limit", "result persistence failure metadata is incomplete");
  assert(resultFailureWrites.length === 2 && resultFailureRemoved.join(",") === "plan,pid", "terminal status was not confirmed around artifact cleanup");

  const statusFailureRemoved = [];
  const statusFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan"], status, result,
    writeJson(file) { if (file === "status") throw Object.assign(new Error("read only"), { code: "EROFS" }); },
    removeFile(file) { statusFailureRemoved.push(file); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(statusFailure.resultPersisted && !statusFailure.statusPersisted && statusFailureRemoved.length === 0, "status persistence failure deleted recovery artifacts");
  assert(statusFailure.statusErrorClass === "permission_denied", "status persistence failure was not classified");

  const cleanupWrites = [];
  const cleanupFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan", "pid"], status, result,
    writeJson(file, value) { if (file === "status") cleanupWrites.push(structuredClone(value)); },
    removeFile(file) { if (file === "plan") throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(cleanupFailure.statusPersisted && !cleanupFailure.artifactsScrubbed, "artifact cleanup failure was reported as successful");
  assert(cleanupFailure.status.artifact_cleanup_pending === true && cleanupFailure.cleanupErrorClass === "permission_denied", "artifact cleanup failure metadata is incomplete");
  assert(cleanupWrites.at(-1).artifact_cleanup_pending === true, "cleanup-pending status was not persisted");

  let statusWrites = 0;
  const confirmationFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan"], status, result,
    writeJson(file) {
      if (file === "status" && ++statusWrites === 2) throw new Error("confirmation failed");
    },
    removeFile() {}, maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(confirmationFailure.statusPersisted && confirmationFailure.artifactsScrubbed && confirmationFailure.statusErrorClass === "persistence_failed", "post-cleanup status confirmation failure was hidden");
  assert(confirmationFailure.status.artifact_cleanup_pending === true, "failed cleanup confirmation did not retain conservative pending state");
}

  testTerminalPersistenceBoundary();
  testManagedJobRetentionGraceBoundaries();
  testManagedJobContinuationProjection();
  testManagedJobContinuationModeValidation();
  await testTransientRecoveryMarkerBoundaries();
  testManagedStateIdentityRetry();
  await testRunnerExitRecoveryRetryPolicy();
  await testManagedJobDependencyReadRecoveryPolicy();
  testHostedManagedJobStatusProjection();
  await testManagedJobReadWaitPacing();
  await testRunnerClaimBoundary();
  await testRecoveryClaimFailurePreservesRetryState();
  await testManagedJobAccountRecoveryCapacity();
  await testManagedJobCapacityBoundary();
  await testManagedJobDependencies();
  await testDependencyResultFirstProjection();
  await testManagedJobActiveChildSafety();
  testDependencyPlanBackwardCompatibility();
  testDependencySuccessClassification();
  await testUnreadableDependencyProtectionFailsClosed();

  if (!context.root) {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
