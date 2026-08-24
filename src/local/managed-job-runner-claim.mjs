import { join } from "node:path";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { inspectPathIfPresentSync, ownerOnlyFile, readBoundedRegularFileSync, retryTransientMultipleLinksSync } from "./secure-file.mjs";

const RUNNER_CLAIM_BYTES = 1024;
const RUNNER_CLAIM_WAIT_MS = 30_000;
const RUNNER_CLAIM_PUBLICATION_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function publishProvisionalRunnerClaim(dir, pid, launchToken) {
  if (!/^[a-f0-9]{32}$/.test(String(launchToken || ""))) throw new Error("runner launch token is invalid");
  const file = join(dir, "runner.pid");
  const claim = { pid, startedAt: new Date().toISOString(), launchToken, committed: false };
  try {
    createExclusiveFileSync(file, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readManagedJobRunnerClaim(file, "managed job runner claim already exists but is unreadable");
    if (Number(existing?.pid) !== pid || existing?.launchToken !== launchToken) {
      throw new Error("managed job runner claim is owned by another process or launch");
    }
    if (existing.committed === true) return;
    if (existing.committed !== false) throw new Error("managed job runner claim has an invalid provisional state");
    claim.startedAt = typeof existing.startedAt === "string" && existing.startedAt ? existing.startedAt : claim.startedAt;
  }
  ownerOnlyFile(file);
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
  if (!/^[a-f0-9]{32}$/.test(launchToken)) throw new Error("runner launch token is invalid");
  const deadline = createMonotonicDeadline(waitMs);
  while (!deadline.expired()) {
    if (!inspectPath(file, "managed job runner claim")) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
      continue;
    }
    const provisional = readManagedJobRunnerClaim(file, "runner ownership claim is unreadable");
    if (Number(provisional?.pid) !== pid || provisional?.launchToken !== launchToken) {
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
      : () => readBoundedRegularFileSync(file, RUNNER_CLAIM_BYTES, "managed job runner claim", {
        verifyPathIdentity: true,
        rejectMultipleLinks: true,
      });
    const bytes = readStableRunnerClaimBytes(readBytes);
    const claim = JSON.parse(bytes.toString("utf8"));
    if (!validRunnerClaim(claim)) throw new Error("managed job runner claim has an invalid shape");
    return claim;
  } catch (error) { throw new Error(message, { cause: error }); }
}

function readStableRunnerClaimBytes(readBytes) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return retryTransientMultipleLinksSync(readBytes); }
    catch (error) {
      if (error?.code !== "MBM_IDENTITY_CHANGED" || attempt === 4) throw error;
      Atomics.wait(RUNNER_CLAIM_PUBLICATION_RETRY_BUFFER, 0, 0, 1);
    }
  }
  throw new Error("runner claim publication retry did not settle");
}

function validRunnerClaim(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  if (!Number.isInteger(claim.pid) || claim.pid <= 0 || !validClaimTime(claim.startedAt)) return false;
  if (claim.processStartedAt !== undefined && !validClaimTime(claim.processStartedAt)) return false;
  if (claim.launchToken !== undefined && !/^[a-f0-9]{32}$/.test(String(claim.launchToken))) return false;
  if (claim.committed !== undefined && typeof claim.committed !== "boolean") return false;
  return true;
}

function validClaimTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
