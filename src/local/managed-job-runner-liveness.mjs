import { join } from "node:path";
import { inspectProcessInstance, inspectProcessInstanceAsync } from "./process-identity.mjs";
import {
  exactManagedJobRunnerPid, exactManagedJobRunnerTime, readManagedJobRunnerClaim,
} from "./managed-job-runner-claim.mjs";

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
