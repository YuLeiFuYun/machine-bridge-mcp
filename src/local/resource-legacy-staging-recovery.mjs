import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeFromSnapshot } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const LEGACY_WORKFLOW_BUNDLE_LEASE_STAGING = /^\.(?<target>lease_[a-f0-9]{32}\.json)\.(?<nonce>[a-z0-9_]{8})\.tmp$/;
const RESOURCE_STAGING_BUSY_CODE = "MBM_RESOURCE_STAGING_BUSY";

export function recoverLegacyWorkflowBundleLeaseStaging(dir, entry, kind, processStarts = null) {
  if (!entry?.isFile?.() || kind !== "lease") return false;
  const match = LEGACY_WORKFLOW_BUNDLE_LEASE_STAGING.exec(entry.name);
  if (!match?.groups?.target) return false;
  const stagingPath = join(dir, entry.name);
  const targetPath = join(dir, match.groups.target);
  const staging = inspect(stagingPath, "legacy resource coordinator staging file");
  const target = inspectOptional(targetPath, "resource coordinator published file");
  if (!target) throw new Error("legacy resource coordinator staging file has no published lease authority");
  if (staging.nlink !== 1n || target.nlink !== 1n) throw new Error("resource coordinator legacy replacement staging has unexpected links");
  const owner = legacyWorkflowBundlePublisher(targetPath);
  const observedStart = owner.pid === process.pid
    ? currentProcessStartTimeMs()
    : processStartTimeFromSnapshot(processStarts, owner.pid);
  const status = inspectProcessInstance(owner, { getProcessStartTime: () => observedStart });
  if (status.alive === true && status.reclaimable !== true) {
    throw Object.assign(new Error("legacy resource coordinator staging file is still owned by a live publisher"), { code: RESOURCE_STAGING_BUSY_CODE });
  }
  verifyUncommittedPair(stagingPath, targetPath, staging, target);
  unlinkSync(stagingPath);
  return true;
}

function legacyWorkflowBundlePublisher(targetPath) {
  let lease;
  try {
    lease = JSON.parse(readBoundedRegularFileSync(targetPath, 32 * 1024, "legacy staging lease authority", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).toString("utf8"));
  } catch (error) {
    throw new Error("legacy staging lease authority could not be validated", { cause: error });
  }
  const owner = lease?.owner;
  const pid = Number(owner?.pid);
  if (owner?.kind !== "provisional" || !Number.isSafeInteger(pid) || pid <= 0
      || typeof owner?.process_started_at !== "string" || typeof lease?.acquired_at !== "string") {
    throw new Error("legacy staging lease authority does not identify a provisional publisher");
  }
  return { pid, startedAt: lease.acquired_at, processStartedAt: owner.process_started_at };
}

function verifyUncommittedPair(stagingPath, targetPath, staging, target) {
  const currentStaging = inspect(stagingPath, "legacy resource coordinator staging file");
  const currentTarget = inspect(targetPath, "resource coordinator published file");
  if (currentStaging.nlink !== 1n || currentTarget.nlink !== 1n
      || !sameFilesystemIdentity(staging.identity, currentStaging.identity)
      || !sameFilesystemIdentity(target.identity, currentTarget.identity)) {
    throw new Error("legacy resource coordinator staging file changed during recovery");
  }
}

function inspect(file, label) {
  const info = lstatSync(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return { nlink: info.nlink, identity: filesystemIdentity(info, label) };
}

function inspectOptional(file, label) {
  try { return inspect(file, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
