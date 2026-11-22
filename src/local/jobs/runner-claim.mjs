import { join } from "node:path";
import { createMonotonicDeadline } from "../core/timing.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync, verifyExclusiveFilePublicationResidueSync } from "../core/exclusive-file.mjs";
import { inspectPathIfPresentSync, readBoundedRegularFileSync, retryTransientMultipleLinksSync } from "../core/secure-file.mjs";
import { inspectProcessInstance, inspectProcessInstanceAsync } from "../process/identity.mjs";

const RUNNER_CLAIM_BYTES = 1024;

const RUNNER_CLAIM_WAIT_MS = 30_000;

const RUNNER_CLAIM_PUBLICATION_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function publishProvisionalRunnerClaim(dir, pid, launchToken) {
  if (typeof launchToken !== "string" || !/^[a-f0-9]{32}$/.test(launchToken)) throw new Error("runner launch token is invalid");
  const file = join(dir, "runner.pid");
  const claim = { pid, startedAt: new Date().toISOString(), launchToken, committed: false };
  try {
    createExclusiveFileSync(file, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readManagedJobRunnerClaim(file, "managed job runner claim already exists but is unreadable");
    if (existing.pid !== pid || existing.launchToken !== launchToken) {
      throw new Error("managed job runner claim is owned by another process or launch");
    }
    if (existing.committed === true) return;
    if (existing.committed !== false) throw new Error("managed job runner claim has an invalid provisional state");
    claim.startedAt = typeof existing.startedAt === "string" && existing.startedAt ? existing.startedAt : claim.startedAt;
  }
  replaceFileAtomicallySync(file, `${JSON.stringify({ ...claim, committed: true })}\n`, { mode: 0o600 });
}

export async function confirmRunnerClaim({
  file, pid, processStartedAt, launchToken, inspectPath = inspectPathIfPresentSync,
  waitMs = RUNNER_CLAIM_WAIT_MS,
}) {
  const exact = { pid, startedAt: new Date().toISOString(), processStartedAt };
  if (!launchToken) {
    createExclusiveFileSync(file, `${JSON.stringify(exact)}\n`, { mode: 0o600 });
    return;
  }
  if (typeof launchToken !== "string" || !/^[a-f0-9]{32}$/.test(launchToken)) throw new Error("runner launch token is invalid");
  const deadline = createMonotonicDeadline(waitMs);
  while (!deadline.expired()) {
    if (!inspectPath(file, "managed job runner claim")) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
      continue;
    }
    const provisional = readManagedJobRunnerClaim(file, "runner ownership claim is unreadable");
    if (provisional.pid !== pid || provisional.launchToken !== launchToken) {
      throw new Error("runner ownership claim does not match the spawned process");
    }
    if (provisional.committed !== true) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(10, Math.max(1, deadline.remainingMs()))); });
      continue;
    }
    exact.startedAt = typeof provisional.startedAt === "string" && provisional.startedAt
      ? provisional.startedAt
      : exact.startedAt;
    replaceFileAtomicallySync(file, `${JSON.stringify(exact)}\n`, { mode: 0o600 });
    return;
  }
  throw new Error("runner ownership claim was not published before startup deadline");
}

export function readManagedJobRunnerClaim(file, message = "managed job runner claim is unreadable", options = {}) {
  try {
    const readBytes = typeof options.readBytes === "function"
      ? options.readBytes
      : (residueIdentity) => readBoundedRegularFileSync(file, RUNNER_CLAIM_BYTES, "managed job runner claim", {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
        allowedMultipleLinkIdentity: residueIdentity,
      });
    const bytes = readStableRunnerClaimBytes(readBytes, () => verifyExclusiveFilePublicationResidueSync(file));
    const claim = JSON.parse(bytes.toString("utf8"));
    if (!validRunnerClaim(claim)) throw new Error("managed job runner claim has an invalid shape");
    return claim;
  } catch (error) { throw new Error(message, { cause: error }); }
}

export function exactManagedJobRunnerPid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function exactManagedJobRunnerTime(value) {
  if (typeof value === "string" && value && Number.isFinite(Date.parse(value))) return value;
  return null;
}

function readStableRunnerClaimBytes(readBytes, verifyResidue) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return retryTransientMultipleLinksSync(readBytes, { verifyResidue }); }
    catch (error) {
      if (error?.code !== "MBM_IDENTITY_CHANGED" || attempt === 4) throw error;
      Atomics.wait(RUNNER_CLAIM_PUBLICATION_RETRY_BUFFER, 0, 0, 1);
    }
  }
  throw new Error("runner claim publication retry did not settle");
}

function validRunnerClaim(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  if (exactManagedJobRunnerPid(claim.pid) === null || exactManagedJobRunnerTime(claim.startedAt) === null) return false;
  if (claim.processStartedAt !== undefined && exactManagedJobRunnerTime(claim.processStartedAt) === null) return false;
  if (claim.launchToken !== undefined
      && (typeof claim.launchToken !== "string" || !/^[a-f0-9]{32}$/.test(claim.launchToken))) return false;
  if (claim.committed !== undefined && typeof claim.committed !== "boolean") return false;
  return true;
}
export function runnerProcessIsCurrent(status, dir, { ownerOnly = false } = {}) {
  const owner = readRunnerOwner(dir, fallbackOwner(status, ownerOnly));
  if (!owner.pid) return false;
  return identityIsCurrent(inspectProcessInstance(owner, { maxAgeMs: Number.POSITIVE_INFINITY }));
}

export async function runnerProcessIsCurrentAsync(status, dir, { ownerOnly = false, ...options } = {}) {
  const owner = readRunnerOwner(dir, fallbackOwner(status, ownerOnly));
  if (!owner.pid) return false;
  return identityIsCurrent(await inspectProcessInstanceAsync(owner, { ...options, maxAgeMs: Number.POSITIVE_INFINITY }));
}

function fallbackOwner(status, ownerOnly) {
  if (ownerOnly) return status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return {};
  const pid = exactManagedJobRunnerPid(status?.runner_pid);
  const processStartedAt = exactManagedJobRunnerTime(status?.runner_process_started_at);
  const startedAt = status?.started_at ?? status?.updated_at ?? status?.created_at;
  const exactStartedAt = exactManagedJobRunnerTime(startedAt);
  if (pid === null || processStartedAt === null || exactStartedAt === null) return {};
  return {
    pid,
    processStartedAt,
    startedAt: exactStartedAt,
  };
}

function readRunnerOwner(dir, fallback = {}) {
  let parsed;
  try { parsed = readManagedJobRunnerClaim(join(dir, "runner.pid"), "managed job runner claim is invalid"); }
  catch (error) { if (error?.cause?.code === "ENOENT") return { ...fallback }; throw error; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("managed job runner claim is invalid");
  return { ...fallback, ...parsed };
}

function identityIsCurrent(identity) {
  return identity.current || (identity.alive && !identity.reclaimable);
}
