import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { TRANSIENT_PROCESS_RECOVERY_SLOTS, transientProcessUndeliveredRecoveryProtected } from "./managed-job-retention-policy.mjs";
import { readJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { assertKnownManagedJobStatus, assertManagedJobDirectoryIdentity } from "./managed-job-state-validation.mjs";
import { isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";
import { assertTerminalJobEvidence } from "./managed-job-terminal-maintenance.mjs";

export const NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS = TRANSIENT_PROCESS_RECOVERY_SLOTS;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;
const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;
const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ROLES = new Set(["reviewer", "editor", "operator", "owner"]);

export function transientProcessRecoveryAccountCapacityApplies(retentionClass, context = {}) {
  const principal = context?.authority?.principal;
  return retentionClass === "transient_process"
    && context?.authority?.owner === false
    && principal?.kind === "account";
}

export function assertTransientProcessRecoveryAccountCapacity({
  jobRoot,
  retentionClass,
  context = {},
  currentJobId = "",
  currentDirectoryExists = false,
  idempotencyReplayEligible = false,
  now = Date.now(),
}) {
  if (!transientProcessRecoveryAccountCapacityApplies(retentionClass, context)) {
    return { applies: false, persisted_replay: false };
  }
  const principal = context.authority.principal;
  if (!validPrincipal(principal)) {
    throw new BridgeError("authorization_denied", "managed-job pending-recovery capacity requires an authenticated account principal", {
      retryable: false,
    });
  }
  try {
    if (currentDirectoryExists && idempotencyReplayEligible && MANAGED_JOB_ID.test(currentJobId)) {
      const currentDir = join(jobRoot, currentJobId);
      const current = readJson(join(currentDir, "status.json"), 256 * 1024, "job status");
      if (current !== null) {
        assertQuotaStatus(currentDir, current);
        if (!matchesExactPrincipal(current, principal)) throw classificationIntegrityError();
        return { applies: true, persisted_replay: true };
      }
    }

    let pending = 0;
    for (const entry of safeReadDir(jobRoot)) {
      if (!MANAGED_JOB_ID.test(entry.name)) continue;
      if (currentDirectoryExists && idempotencyReplayEligible && entry.name === currentJobId) continue;
      if (!entry.isDirectory()) throw classificationIntegrityError();
      const dir = join(jobRoot, entry.name);
      const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
      if (status === null) continue;
      assertQuotaStatus(dir, status);
      if (status.transient_recovery_pending !== true) continue;
      if (status.retention_class !== "transient_process" || !validAccountBinding(status)) {
        throw classificationIntegrityError();
      }
      if (status.owner_role === "owner") continue;
      if (status.owner_account_id !== principal.accountId || status.owner_account_version !== principal.accountVersion) continue;
      if (isTerminalManagedJobStatus(status.status)) {
        const finishedAt = Date.parse(String(status.finished_at || ""));
        if (!Number.isFinite(finishedAt) || finishedAt > now) throw classificationIntegrityError();
        if (!transientProcessUndeliveredRecoveryProtected(status, 0, now)) continue;
      }
      pending += 1;
      if (pending >= NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS) throw accountCapacityExceeded();
    }
    return { applies: true, persisted_replay: false };
  } catch (error) {
    if (error instanceof BridgeError && error.code === "limit_exceeded") throw error;
    throw safeClassificationError(error);
  }
}

function assertQuotaStatus(dir, status) {
  assertManagedJobDirectoryIdentity(dir, status);
  assertKnownManagedJobStatus(status);
  if (isTerminalManagedJobStatus(status.status)) assertTerminalJobEvidence(dir, status);
}

function matchesExactPrincipal(status, principal) {
  return status?.owner_kind === "account"
    && status.owner_account_id === principal.accountId
    && status.owner_account_version === principal.accountVersion
    && status.owner_client_id === principal.clientId
    && status.owner_family_id === principal.familyId
    && status.owner_role === principal.role;
}

function validPrincipal(principal) {
  return principal?.kind === "account"
    && ACCOUNT_ID.test(String(principal.accountId || ""))
    && Number.isSafeInteger(principal.accountVersion) && principal.accountVersion > 0
    && CLIENT_ID.test(String(principal.clientId || ""))
    && FAMILY_ID.test(String(principal.familyId || ""))
    && ACCOUNT_ROLES.has(principal.role);
}

function validAccountBinding(status) {
  return status?.owner_kind === "account"
    && ACCOUNT_ID.test(String(status.owner_account_id || ""))
    && Number.isSafeInteger(status.owner_account_version) && status.owner_account_version > 0
    && CLIENT_ID.test(String(status.owner_client_id || ""))
    && FAMILY_ID.test(String(status.owner_family_id || ""))
    && ACCOUNT_ROLES.has(status.owner_role);
}

function accountCapacityExceeded() {
  return new BridgeError("limit_exceeded", "managed-job account pending-recovery capacity is fully occupied", {
    retryable: true,
    details: {
      maximum: NON_OWNER_TRANSIENT_PENDING_RECOVERY_SLOTS,
      capacity_scope: "account_pending_transient_recovery",
    },
  });
}

function classificationIntegrityError() {
  return new BridgeError("integrity_error", "managed-job pending-recovery capacity could not be classified safely", {
    retryable: false,
  });
}

function safeClassificationError(error) {
  if (error instanceof BridgeError && error.code === "integrity_error") return classificationIntegrityError();
  const errorClass = resourceErrorClass(error?.cause || error);
  const message = String(error?.message || "");
  const integrity = ["not_found", "symbolic_link_denied", "insecure_links", "insecure_permissions", "size_limit", "integrity_error"].includes(errorClass)
    || /not valid|unavailable or invalid|does not match|must be a real directory|identity is invalid/i.test(message);
  return new BridgeError(integrity ? "integrity_error" : "unavailable", "managed-job pending-recovery capacity could not be classified safely", {
    retryable: !integrity,
    cause: error instanceof Error ? error : undefined,
  });
}
