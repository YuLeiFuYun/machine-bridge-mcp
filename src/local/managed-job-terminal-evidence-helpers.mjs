// @ts-check

import { lstatSync } from "node:fs";
import { BridgeError } from "./errors.mjs";
import { readJson } from "./managed-job-storage.mjs";

/** @param {string} file @returns {{status: Record<string, unknown> | null, identity: string}} */
export function readStableTerminalStatus(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = terminalEvidenceFileIdentity(file, "job status");
    const status = readJson(file, 256 * 1024, "job status");
    const after = terminalEvidenceFileIdentity(file, "job status");
    if (before === after) return { status, identity: after };
  }
  throw new BridgeError("integrity_error", "managed job status changed repeatedly during terminal evidence validation");
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} after */
export function sameTerminalJobStatus(before, after) {
  const mutableCleanupFields = new Set(["artifact_cleanup_pending", "artifact_cleanup_error_class", "updated_at"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (mutableCleanupFields.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
  }
  return true;
}

/** @param {string} statusIdentity @param {string} resultIdentity @param {Record<string, unknown>} status */
export function terminalEvidenceSignature(statusIdentity, resultIdentity, status) {
  return `${statusIdentity}|${resultIdentity}|${status.job_id}|${status.status}|${status.finished_at}|${status.result_persisted}`;
}

/** @param {string} file @param {string} label */
export function terminalEvidenceFileIdentity(file, label) {
  let info;
  try { info = lstatSync(file, { bigint: true }); }
  catch (error) {
    if (label === "job result" && error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new BridgeError("integrity_error", "managed job terminal result is missing", { cause: error });
    }
    throw new BridgeError("integrity_error", `managed job ${label} identity could not be verified`, { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new BridgeError("integrity_error", `managed job ${label} is not an exclusive regular file`);
  }
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(":");
}
