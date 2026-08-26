import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { inspectProcessInstance, processStartTimeFromSnapshot } from "./process-identity.mjs";

const STAGING = /^\.(?<target>(?<kind>lease|wait)_[a-f0-9]{32}\.json)\.(?<pid>[1-9][0-9]*)\.(?<nonce>[a-f0-9]{16})\.tmp$/;
const FINAL = Object.freeze({ lease: /^lease_[a-f0-9]{32}\.json$/, wait: /^wait_[a-f0-9]{32}\.json$/ });
export const RESOURCE_STAGING_BUSY_CODE = "MBM_RESOURCE_STAGING_BUSY";

export function recoverResourceDirectoryStaging(dir, entries, kind, processStarts = null) {
  const expected = FINAL[kind];
  if (!expected) throw new Error("resource staging kind is invalid");
  let recovered = false;
  for (const entry of entries) {
    if (entry.isFile() && expected.test(entry.name)) continue;
    const match = entry.isFile() ? STAGING.exec(entry.name) : null;
    if (!match || match.groups?.kind !== kind) throw new Error(`resource coordinator ${kind} directory contains an unexpected entry`);
    recoverStagingAlias(dir, entry.name, match.groups.target, Number(match.groups.pid), processStarts);
    recovered = true;
  }
  return recovered;
}

function recoverStagingAlias(dir, stagingName, targetName, publisherPid, processStarts) {
  const stagingPath = join(dir, stagingName);
  const targetPath = join(dir, targetName);
  const staging = inspect(stagingPath, "resource coordinator staging file");
  const target = inspectOptional(targetPath, "resource coordinator published file");
  if (target) {
    const sameObject = sameFilesystemIdentity(staging.identity, target.identity);
    if (sameObject) {
      if (staging.nlink !== 2n || target.nlink !== 2n) throw new Error("resource coordinator committed staging alias has unexpected links");
      verifyPair(stagingPath, targetPath, staging, target, true);
      unlinkSync(stagingPath);
      return;
    }
    if (stagingPublisherMayBeCurrent(publisherPid, staging, processStarts)) throw Object.assign(new Error("resource coordinator staging file is still owned by a live publisher"), { code: RESOURCE_STAGING_BUSY_CODE });
    if (staging.nlink !== 1n || target.nlink !== 1n) throw new Error("resource coordinator uncommitted replacement staging has unexpected links");
    verifyPair(stagingPath, targetPath, staging, target, false);
    unlinkSync(stagingPath);
    return;
  }
  if (stagingPublisherMayBeCurrent(publisherPid, staging, processStarts)) throw Object.assign(new Error("resource coordinator staging file is still owned by a live publisher"), { code: RESOURCE_STAGING_BUSY_CODE });
  if (staging.nlink !== 1n) throw new Error("resource coordinator uncommitted staging file has unexpected links");
  const current = inspect(stagingPath, "resource coordinator staging file");
  if (current.nlink !== 1n || !sameFilesystemIdentity(staging.identity, current.identity)) {
    throw new Error("resource coordinator staging file changed during recovery");
  }
  unlinkSync(stagingPath);
}

function verifyPair(stagingPath, targetPath, staging, target, requireSameObject) {
  const currentStaging = inspect(stagingPath, "resource coordinator staging file");
  const currentTarget = inspect(targetPath, "resource coordinator published file");
  if (currentStaging.nlink !== staging.nlink || currentTarget.nlink !== target.nlink
      || !sameFilesystemIdentity(staging.identity, currentStaging.identity)
      || !sameFilesystemIdentity(target.identity, currentTarget.identity)
      || (requireSameObject && !sameFilesystemIdentity(currentStaging.identity, currentTarget.identity))) {
    throw new Error("resource coordinator staging file changed during recovery");
  }
}

function inspect(file, label) {
  const info = lstatSync(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return { nlink: info.nlink, identity: filesystemIdentity(info, label), modified_at: Number(info.mtimeMs) };
}
function inspectOptional(file, label) {
  try { return inspect(file, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function stagingPublisherMayBeCurrent(pid, staging, processStarts = undefined) {
  const options = { getProcessStartTime: (value) => processStartTimeFromSnapshot(processStarts, value) };
  const status = inspectProcessInstance({ pid, startedAt: staging.modified_at }, options);
  return status.alive === true && status.reclaimable !== true;
}
