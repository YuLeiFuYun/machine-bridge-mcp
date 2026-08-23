import { join } from "node:path";
import { inspectProcessInstance, inspectProcessInstanceAsync } from "./process-identity.mjs";
import { readManagedJobRunnerClaim } from "./managed-job-runner-claim.mjs";

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
  return ownerOnly ? status : {
    pid: Number(status?.runner_pid) || undefined,
    processStartedAt: status?.runner_process_started_at,
    startedAt: status?.started_at || status?.updated_at || status?.created_at,
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
