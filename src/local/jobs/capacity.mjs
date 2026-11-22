// @ts-check
import { cleanupIsolatedWorktreeDir, MANAGED_JOB_ID, retiredManagedJobDirectories, safeReadDir, readJson, atomicWriteJson, resourceErrorClass } from "./directory.mjs";
import { lstatSync, rmSync } from "node:fs";
import { BridgeError } from "../core/errors.mjs";
import { basename, join } from "node:path";
import { isTerminalManagedJobResult, isTerminalManagedJobStatus, scrubManagedJobArtifacts } from "./terminal-base.mjs";
import { managedJobActiveChildFile, managedJobActiveChildRecoveryReady } from "./execution.mjs";

export const MAX_JOBS = 512;

export const MAX_LISTED_JOBS = 50;

/** @param {string} jobRoot */
export function managedJobCapacitySnapshot(jobRoot) {
  const retired = retiredManagedJobDirectories(jobRoot);
  const reservedJobs = safeReadDir(jobRoot).filter((entry) => MANAGED_JOB_ID.test(entry.name));
  return {
    retained_state: reservedJobs.length + retired.length,
    job_state_unreadable: reservedJobs.filter((entry) => !entry.isDirectory()).length,
    retired_state: retired.length,
    retired_unreadable: retired.filter((entry) => !entry.reclaimable).length,
  };
}
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
const TERMINAL_EVIDENCE_CACHE_MAX = 1024;

/** @type {Map<string, string>} */
const terminalEvidenceCache = new Map();

/** @typedef {Record<string, unknown> & {job_id?: unknown, status?: unknown, result_persisted?: unknown, finished_at?: unknown, terminal_record_error_class?: unknown, artifact_cleanup_pending?: unknown, artifact_cleanup_error_class?: unknown, updated_at?: unknown}} TerminalJobStatusRecord */
/** @typedef {{readResult?: (path: string, maxBytes: number, label: string) => Record<string, unknown> | null}} TerminalEvidenceOptions */

/** @param {string} dir @param {TerminalJobStatusRecord} status @param {TerminalEvidenceOptions} [options] */
export function assertTerminalJobEvidence(dir, status, options = {}) {
  if (status?.job_id !== basename(dir) || !isTerminalManagedJobStatus(status?.status)) {
    throw new BridgeError("integrity_error", "managed job terminal state does not match its directory");
  }
  if (status.result_persisted === false) {
    if (typeof status.finished_at !== "string" || !Number.isFinite(Date.parse(status.finished_at))
        || typeof status.terminal_record_error_class !== "string"
        || !/^[a-z0-9._-]{1,80}$/.test(status.terminal_record_error_class)) {
      throw new BridgeError("integrity_error", "managed job unpersisted terminal result lacks valid failure evidence");
    }
    return;
  }
  const statusFile = join(dir, "status.json");
  const resultFile = join(dir, "result.json");
  const stableStatus = readStableTerminalStatus(statusFile);
  const currentStatus = stableStatus.status;
  if (!currentStatus || !sameTerminalJobStatus(status, currentStatus)) {
    throw new BridgeError("integrity_error", "managed job status changed during terminal evidence validation");
  }
  const resultIdentity = terminalEvidenceFileIdentity(resultFile, "job result");
  const signature = terminalEvidenceSignature(stableStatus.identity, resultIdentity, currentStatus);
  if (terminalEvidenceCache.get(dir) === signature) {
    const latestStatus = readStableTerminalStatus(statusFile);
    const latestResultIdentity = terminalEvidenceFileIdentity(resultFile, "job result");
    if (!latestStatus.status || !sameTerminalJobStatus(currentStatus, latestStatus.status)
        || latestResultIdentity !== resultIdentity) {
      terminalEvidenceCache.delete(dir);
      throw new BridgeError("integrity_error", "managed job terminal evidence changed during cached validation");
    }
    terminalEvidenceCache.delete(dir);
    terminalEvidenceCache.set(dir, terminalEvidenceSignature(latestStatus.identity, latestResultIdentity, latestStatus.status));
    return;
  }
  const readResult = typeof options.readResult === "function" ? options.readResult : readJson;
  const result = readResult(resultFile, 4 * 1024 * 1024, "job result");
  if (!result) throw new BridgeError("integrity_error", "managed job terminal result is missing");
  if (!isTerminalManagedJobResult(result, status.job_id)
      || result.status !== status.status || result.finished_at !== status.finished_at) {
    throw new BridgeError("integrity_error", "managed job terminal status and result are inconsistent");
  }
  const latestStatus = readStableTerminalStatus(statusFile);
  const latestResultIdentity = terminalEvidenceFileIdentity(resultFile, "job result");
  if (!latestStatus.status || !sameTerminalJobStatus(currentStatus, latestStatus.status)
      || latestResultIdentity !== resultIdentity) {
    throw new BridgeError("integrity_error", "managed job terminal evidence changed during validation");
  }
  terminalEvidenceCache.delete(dir);
  terminalEvidenceCache.set(dir, terminalEvidenceSignature(latestStatus.identity, latestResultIdentity, latestStatus.status));
  if (terminalEvidenceCache.size > TERMINAL_EVIDENCE_CACHE_MAX) {
    const oldest = terminalEvidenceCache.keys().next().value;
    if (oldest !== undefined) terminalEvidenceCache.delete(oldest);
  }
}
/** @param {string} dir @param {TerminalJobStatusRecord} status @param {{removeArtifact?: (file: string) => void}} [options] */
export function scrubTerminalJobArtifacts(dir, status, options = {}) {
  assertTerminalJobEvidence(dir, status);
  const activeChildReady = managedJobActiveChildRecoveryReady(managedJobActiveChildFile(dir));
  cleanupIsolatedWorktreeDir(join(dir, "runtime", "worktree"), "", join(dir, "runtime"));
  /** @type {(file: string) => void} */
  const removeArtifact = options.removeArtifact || ((file) => rmSync(file, { recursive: true, force: true }));
  const cleanup = scrubManagedJobArtifacts([
    join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel"),
  ], removeArtifact, terminalCleanupErrorClass);
  if (!activeChildReady) {
    cleanup.scrubbed = false;
    cleanup.errorClass ||= "active_child_unsettled";
    cleanup.failureCount += 1;
  }
  const pending = !cleanup.scrubbed;
  if (status.artifact_cleanup_pending !== pending
      || (status.artifact_cleanup_error_class || null) !== cleanup.errorClass) {
    status.artifact_cleanup_pending = pending;
    status.artifact_cleanup_error_class = cleanup.errorClass;
    status.updated_at = new Date().toISOString();
    atomicWriteJson(join(dir, "status.json"), status, 256 * 1024);
  }
  return cleanup;
}

/** @param {unknown} error @returns {"not_found" | "permission_denied" | "persistence_failed" | "storage_limit"} */
function terminalCleanupErrorClass(error) {
  const category = resourceErrorClass(error);
  if (category === "not_found" || category === "permission_denied") return category;
  if (category === "size_limit") return "storage_limit";
  return "persistence_failed";
}
