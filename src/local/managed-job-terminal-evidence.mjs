// @ts-check

import { basename, join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { readJson } from "./managed-job-storage.mjs";
import { isTerminalManagedJobResult, isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";
import {
  readStableTerminalStatus, sameTerminalJobStatus, terminalEvidenceFileIdentity, terminalEvidenceSignature,
} from "./managed-job-terminal-evidence-helpers.mjs";

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
