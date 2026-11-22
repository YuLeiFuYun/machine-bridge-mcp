import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { removeOwnedJsonFileSync } from "../core/exclusive-file.mjs";
import { inspectProcessInstance, isPidAlive, processStartTimeMs, processState } from "../process/identity.mjs";
import { terminateProcessTree, terminateProcessTreeWithEscalation } from "../process/tree-facade.mjs";
import { atomicWriteJson, readJson, resolveManagedJobDirectory, readRequiredJson, MANAGED_JOB_ID, resourceErrorClass } from "./directory.mjs";
import { assertOwnedByContext, principalBinding } from "../core/authority.mjs";
import { BridgeError } from "../core/errors.mjs";
import { assertKnownManagedJobStatus, assertManagedJobDirectoryIdentity } from "./redaction.mjs";
import { assertManagedJobPlanIntegrity, managedJobPlanSha256 } from "./projection.mjs";
import { managedJobDependencySucceeded } from "./dependencies.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus } from "./terminal-base.mjs";

const ACTIVE_CHILD_SCHEMA = 1;

const MAX_ACTIVE_CHILD_BYTES = 8192;

export function managedJobActiveChildFile(jobDir) {
  return join(jobDir, "active-child.json");
}

export function publishManagedJobActiveChild(file, child, options = {}) {
  const pid = positivePid(child?.pid);
  if (!pid) throw new Error("managed job child process did not receive a valid pid");
  const observedStart = (options.processStartTime || processStartTimeMs)(pid);
  const processIdentityVerified = Number.isFinite(observedStart) && observedStart > 0;
  if (!processIdentityVerified) {
    if (childExited(child) || !(options.isAlive || isPidAlive)(pid)
        || (options.processState || processState)(pid) === "zombie") return null;
    throw new Error("managed job child process identity could not be verified");
  }
  const existing = readActiveChildClaim(file, options);
  if (existing) {
    if (activeChildState(existing, options) !== "stopped") throw new Error("managed job active child claim already exists");
    clearManagedJobActiveChild(file, existing, options);
  }
  const claim = {
    schema_version: ACTIVE_CHILD_SCHEMA,
    pid,
    token: (options.randomBytes || randomBytes)(16).toString("hex"),
    startedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    processStartedAt: new Date(observedStart).toISOString(),
    processIdentityVerified: true,
    processGroupIsolated: (options.platform || process.platform) !== "win32",
  };
  (options.writeJson || atomicWriteJson)(file, claim, MAX_ACTIVE_CHILD_BYTES);
  return claim;
}

export function clearManagedJobActiveChild(file, claim, options = {}) {
  if (!claim) return true;
  const remove = options.removeOwned || removeOwnedJsonFileSync;
  if (remove(file, { pid: claim.pid, token: claim.token }, { maxBytes: MAX_ACTIVE_CHILD_BYTES })) return true;
  const current = readActiveChildClaim(file, options);
  if (!current) return true;
  if (current.pid === claim.pid && current.token === claim.token) {
    throw new Error("managed job active child claim could not be removed safely");
  }
  throw new Error("managed job active child claim changed before cleanup");
}

export function managedJobActiveChildRecoveryReady(file, options = {}) {
  return managedJobActiveChildRecoveryState(file, options) === "ready";
}

export function managedJobActiveChildRecoveryState(file, options = {}) {
  let claim;
  try { claim = readActiveChildClaim(file, options); }
  catch { return "ambiguous"; }
  if (!claim) return "ready";
  const state = activeChildState(claim, options);
  if (state !== "stopped") return state;
  try { clearManagedJobActiveChild(file, claim, options); }
  catch { return "ambiguous"; }
  return "ready";
}

export async function terminateManagedJobActiveChild(file, options = {}) {
  const claim = readActiveChildClaim(file, options);
  if (!claim) return { active_child_present: false, terminated: false };
  const initialState = activeChildState(claim, options);
  if (initialState === "stopped") {
    clearManagedJobActiveChild(file, claim, options);
    return { active_child_present: true, terminated: false };
  }
  if (initialState !== "current") throw new Error("managed job active child ownership cannot be verified");

  const child = recoveredChild(claim, options);
  const terminateWithEscalation = options.terminateWithEscalation || terminateProcessTreeWithEscalation;
  const terminate = options.terminate || terminateProcessTree;
  await new Promise((resolvePromise, rejectPromise) => {
    try {
      terminateWithEscalation(child, {
        ...(options.terminationOptions || {}),
        terminate(target, signal, terminationOptions) {
          const currentState = activeChildState(claim, options);
          if (currentState === "stopped") return false;
          if (currentState !== "current") throw new Error("managed job active child ownership changed before termination");
          return terminate(target, signal, terminationOptions);
        },
        onTerminationSettled: resolvePromise,
      });
    } catch (error) { rejectPromise(error); }
  });
  const settledState = activeChildState(claim, options);
  if (settledState !== "stopped") throw new Error("managed job active child did not settle after process-tree termination");
  clearManagedJobActiveChild(file, claim, options);
  return { active_child_present: true, terminated: true };
}

function readActiveChildClaim(file, options) {
  const value = readJson(file, MAX_ACTIVE_CHILD_BYTES, "managed job active child", options.readOptions || {});
  if (!value) return null;
  const platform = String(options.platform || process.platform);
  if (value.schema_version !== ACTIVE_CHILD_SCHEMA || !positivePid(value.pid)
      || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)
      || !validTime(value.startedAt) || !validTime(value.processStartedAt)
      || (value.processIdentityVerified !== undefined && typeof value.processIdentityVerified !== "boolean")
      || typeof value.processGroupIsolated !== "boolean"
      || value.processGroupIsolated !== (platform !== "win32")) {
    throw new Error("managed job active child claim is invalid");
  }
  return value;
}

function activeChildState(claim, options) {
  const inspect = options.inspectProcess || inspectProcessInstance;
  const state = (options.processState || processState)(claim.pid);
  if (state === "zombie") return "stopped";
  const observed = inspect(claim, options.inspectOptions || {});
  if (observed?.alive === false || observed?.reason === "pid_reused") return "stopped";
  if (claim.processIdentityVerified === false) return "ambiguous";
  if (observed?.current === true && observed?.alive === true) return "current";
  return "ambiguous";
}

function recoveredChild(claim, options) {
  const killProcess = options.killProcess || process.kill.bind(process);
  return {
    pid: claim.pid,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      try { killProcess(claim.pid, signal); return true; }
      catch { return false; }
    },
  };
}

function childExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
export function normalizeJobIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(value)) {
    throw new BridgeError("invalid_request", "idempotency_key must be a 1-128 character identifier using letters, digits, dot, underscore, tilde, colon, or hyphen");
  }
  return value;
}

export function omitJobIdempotencyKey(args) {
  const { idempotency_key: _ignored, ...planArgs } = args;
  return planArgs;
}

export function managedJobIdempotencyDigest(key, context) {
  const binding = principalBinding(context);
  const scope = binding.owner_kind === "account"
    ? [binding.owner_kind, binding.owner_account_id, binding.owner_account_version, binding.owner_client_id, binding.owner_family_id].join("\0")
    : "local";
  return createHash("sha256")
    .update("machine-bridge-managed-job-idempotency-v1\0")
    .update(scope)
    .update("\0")
    .update(key)
    .digest("hex");
}

// Inputs are the bounded, normalized intent produced by validatePlanIntent,
// never resource bytes or an unvalidated external object graph.
export function managedJobRequestSha256(intent, executionOptions) {
  return createHash("sha256")
    .update("machine-bridge-managed-job-request-v1\0")
    .update(JSON.stringify(canonicalRequest({ intent, executionOptions })))
    .digest("hex");
}

function canonicalRequest(value) {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRequest(value[key])]));
}

// This proof is performed under the manager's capacity and transition locks.
// It never reconciles lifecycle or launches execution.
export function inspectManagedJobReplayIntent({ dir, status, context, requestSha256, preparePlan, intent, maxPlanBytes }) {
  assertKnownManagedJobStatus(status);
  assertOwnedByContext(status, context, "managed job");
  assertManagedJobDirectoryIdentity(dir, status);
  if (Object.hasOwn(status, "request_sha256")
      && (typeof status.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(status.request_sha256))) {
    throw new BridgeError("integrity_error", "managed job request identity is invalid");
  }
  let replayPlan = intent;
  let sameRequest = status.request_sha256 === requestSha256;
  if (!Object.hasOwn(status, "request_sha256")) {
    // Retained pre-upgrade records have only their execution-plan hash.
    // Preserve that check, discounting only a fresh inspection timestamp.
    replayPlan = preparePlan();
    const savedPlan = readJson(join(dir, "plan.json"), maxPlanBytes, "job plan");
    if (savedPlan !== null) {
      assertManagedJobPlanIntegrity(savedPlan, status);
      for (const [name, resource] of Object.entries(replayPlan.resources)) {
        if (Object.hasOwn(savedPlan.resources || {}, name)) resource.updatedAt = savedPlan.resources[name].updatedAt;
      }
    }
    sameRequest = status.plan_sha256 === managedJobPlanSha256(replayPlan);
  }
  if (!sameRequest) {
    throw new BridgeError("conflict", "idempotency key is already bound to a different managed-job plan", {
      retryable: false,
      details: { existing_job_id: status.job_id },
    });
  }
  return replayPlan;
}
export function resolveManagedJobDependencies({ jobRoot, dependencyIds, currentJobId, context, reconcileStatus }) {
  const witnesses = [];
  let pending = 0;
  for (const jobId of dependencyIds || []) {
    if (jobId === currentJobId) {
      throw new BridgeError("invalid_request", "managed job cannot depend on itself", { retryable: false });
    }
    const dir = resolveManagedJobDirectory(jobRoot, jobId);
    reconcileStatus(dir);
    const status = readRequiredJson(join(dir, "status.json"), 256 * 1024, "dependency job status");
    if (status.job_id !== jobId || (!ACTIVE_JOB_STATES.has(status.status)
      && status.status !== "staged" && !isTerminalManagedJobStatus(status.status))) {
      throw new BridgeError("integrity_error", "managed job dependency state is invalid");
    }
    assertOwnedByContext(status, context, "managed job dependency");
    if (status.status === "staged") {
      throw new BridgeError("invalid_request", "managed job dependency is staged and cannot become executable", {
        retryable: false, details: { dependency_job_id: jobId, dependency_status: status.status },
      });
    }
    if (isTerminalManagedJobStatus(status.status) && !managedJobDependencySucceeded(status)) {
      throw new BridgeError("conflict", "managed job dependency has already failed", {
        retryable: false,
        details: {
          reason: "dependency_failed",
          dependency_job_id: jobId,
          dependency_status: status.status,
          dependency_error_class: status.error_class ?? null,
        },
      });
    }
    if (!isTerminalManagedJobStatus(status.status)) pending += 1;
    witnesses.push({ job_id: jobId, plan_sha256: status.plan_sha256, created_at: status.created_at });
  }
  return { witnesses, pending };
}
export function managedJobDependencyProtection(entries, logger, extraProtectedIds) {
  const ids = new Set(extraProtectedIds || []);
  let complete = true;
  for (const item of entries) {
    if (!item.status || (item.status.status !== "staged" && !ACTIVE_JOB_STATES.has(item.status.status))) continue;
    try {
      const plan = readRequiredJson(join(item.dir, "plan.json"), 1024 * 1024, "managed job plan");
      assertManagedJobPlanIntegrity(plan, item.status);
      if (plan.depends_on === undefined) continue;
      if (!Array.isArray(plan.depends_on)) throw new Error("managed job dependency plan is invalid");
      for (const jobId of plan.depends_on) {
        if (typeof jobId !== "string" || !MANAGED_JOB_ID.test(jobId)) {
          throw new Error("managed job dependency plan is invalid");
        }
        ids.add(jobId);
      }
    } catch (error) {
      try {
        const current = readRequiredJson(join(item.dir, "status.json"), 256 * 1024, "job status");
        if (current?.job_id === item.status.job_id && isTerminalManagedJobStatus(current.status)) continue;
      } catch {
        // Preserve fail-closed behavior when current state cannot prove the stale active/staged
        // snapshot has reached a terminal state.
      }
      complete = false;
      logger.warn?.("managed job pruning could not determine active dependency protection; retaining terminal state", {
        error_class: resourceErrorClass(error),
      });
    }
  }
  return { ids, complete };
}
