import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { atomicWriteJson, readJson, resourceErrorClass } from "./managed-job-storage.mjs";
import { isTerminalManagedJobResult, isTerminalManagedJobStatus, scrubManagedJobArtifacts } from "./managed-job-terminal.mjs";

export function assertTerminalJobEvidence(dir, status) {
  if (status?.job_id !== basename(dir) || !isTerminalManagedJobStatus(status?.status)) {
    throw new BridgeError("integrity_error", "managed job terminal state does not match its directory");
  }
  if (status.result_persisted === false) {
    if (!Number.isFinite(Date.parse(String(status.finished_at || "")))
        || !/^[a-z0-9._-]{1,80}$/.test(String(status.terminal_record_error_class || ""))) {
      throw new BridgeError("integrity_error", "managed job unpersisted terminal result lacks valid failure evidence");
    }
    return;
  }
  const result = readJson(join(dir, "result.json"), 4 * 1024 * 1024, "job result");
  if (!result) throw new BridgeError("integrity_error", "managed job terminal result is missing");
  if (!isTerminalManagedJobResult(result, status.job_id)
      || result.status !== status.status || result.finished_at !== status.finished_at) {
    throw new BridgeError("integrity_error", "managed job terminal status and result are inconsistent");
  }
}

export function scrubTerminalJobArtifacts(dir, status) {
  assertTerminalJobEvidence(dir, status);
  const cleanup = scrubManagedJobArtifacts([
    join(dir, "runtime"), join(dir, "plan.json"), join(dir, "runner.pid"), join(dir, "cancel"),
  ], (file) => rmSync(file, { recursive: true, force: true }), resourceErrorClass);
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
