import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertOwnedByContext, principalBinding } from "./authority-context.mjs";
import { BridgeError } from "./errors.mjs";
import { assertKnownManagedJobStatus, assertManagedJobDirectoryIdentity } from "./managed-job-state-validation.mjs";
import { assertManagedJobPlanIntegrity, managedJobPlanSha256 } from "./managed-job-plan-integrity.mjs";
import { readJson } from "./managed-job-storage.mjs";

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
