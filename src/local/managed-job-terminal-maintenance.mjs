// @ts-check

import { rmSync } from "node:fs";
import { join } from "node:path";
import { managedJobActiveChildFile, managedJobActiveChildRecoveryReady } from "./managed-job-active-child.mjs";
import { atomicWriteJson, resourceErrorClass } from "./managed-job-storage.mjs";
import { scrubManagedJobArtifacts } from "./managed-job-terminal.mjs";
import { assertTerminalJobEvidence } from "./managed-job-terminal-evidence.mjs";

/** @typedef {Record<string, unknown> & {job_id?: unknown, status?: unknown, result_persisted?: unknown, finished_at?: unknown, terminal_record_error_class?: unknown, artifact_cleanup_pending?: unknown, artifact_cleanup_error_class?: unknown, updated_at?: unknown}} TerminalJobStatusRecord */

/** @param {string} dir @param {TerminalJobStatusRecord} status @param {{removeArtifact?: (file: string) => void}} [options] */
export function scrubTerminalJobArtifacts(dir, status, options = {}) {
  assertTerminalJobEvidence(dir, status);
  const activeChildReady = managedJobActiveChildRecoveryReady(managedJobActiveChildFile(dir));
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
