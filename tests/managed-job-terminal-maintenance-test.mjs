import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubTerminalJobArtifacts } from "../src/local/managed-job-terminal-maintenance.mjs";
import { assertTerminalJobEvidence } from "../src/local/managed-job-terminal-evidence.mjs";
import { readJson } from "../src/local/managed-job-storage.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-terminal-evidence-cache-"));
const jobId = "job_terminal_evidence_cache";
const dir = join(root, jobId);
const statusFile = join(dir, "status.json");
const resultFile = join(dir, "result.json");
const finishedAt = new Date().toISOString();
const stableResultMtime = new Date("2020-01-01T00:00:00.000Z");
const status = { job_id: jobId, status: "succeeded", finished_at: finishedAt, result_persisted: true };
const result = { job_id: jobId, status: "succeeded", finished_at: finishedAt, steps: [], finally_steps: [] };

try {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(statusFile, JSON.stringify(status), { mode: 0o600 });
  writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
  utimesSync(resultFile, stableResultMtime, stableResultMtime);
  let resultReads = 0;
  const countedRead = (...args) => {
    resultReads += 1;
    return readJson(...args);
  };

  assertTerminalJobEvidence(dir, status, { readResult: countedRead });
  assertTerminalJobEvidence(dir, status, { readResult: countedRead });
  assert.equal(resultReads, 1, "unchanged terminal evidence was parsed more than once for the same file generation");

  writeFileSync(statusFile, JSON.stringify({
    ...status,
    artifact_cleanup_pending: true,
    artifact_cleanup_error_class: null,
    updated_at: new Date().toISOString(),
  }), { mode: 0o600 });
  let cleanupRaceReads = 0;
  const cleanupRaceRead = (...args) => {
    cleanupRaceReads += 1;
    const value = readJson(...args);
    writeFileSync(statusFile, JSON.stringify({
      ...status,
      artifact_cleanup_pending: false,
      artifact_cleanup_error_class: null,
      updated_at: new Date().toISOString(),
    }), { mode: 0o600 });
    return value;
  };
  assert.doesNotThrow(() => assertTerminalJobEvidence(dir, status, { readResult: cleanupRaceRead }),
    "terminal cleanup metadata updates were misclassified as a change to the committed result");
  assert.equal(cleanupRaceReads, 1, "terminal cleanup race did not validate its result exactly once");

  writeFileSync(statusFile, JSON.stringify({
    ...status,
    artifact_cleanup_pending: true,
    artifact_cleanup_error_class: null,
    updated_at: new Date().toISOString(),
  }), { mode: 0o600 });
  const authorityMutationRead = (...args) => {
    const value = readJson(...args);
    writeFileSync(statusFile, JSON.stringify({ ...status, owner_id: "unexpected-owner" }), { mode: 0o600 });
    return value;
  };
  assert.throws(() => assertTerminalJobEvidence(dir, status, { readResult: authorityMutationRead }),
    /terminal evidence changed during validation/);

  writeFileSync(statusFile, JSON.stringify(status), { mode: 0o600 });
  writeFileSync(resultFile, JSON.stringify({ ...result, status: "failed" }), { mode: 0o600 });
  utimesSync(resultFile, stableResultMtime, stableResultMtime);
  assert.throws(() => assertTerminalJobEvidence(dir, status, { readResult: countedRead }), /terminal status and result are inconsistent/);
  assert.equal(resultReads, 2, "changed terminal evidence reused a stale cache entry");

  const cleanupDir = join(root, "job_terminal_cleanup");
  mkdirSync(join(cleanupDir, "runtime"), { recursive: true, mode: 0o700 });
  const cleanupStatus = { job_id: "job_terminal_cleanup", status: "succeeded", finished_at: finishedAt, result_persisted: true };
  writeFileSync(join(cleanupDir, "status.json"), JSON.stringify(cleanupStatus), { mode: 0o600 });
  writeFileSync(join(cleanupDir, "result.json"), JSON.stringify({ ...result, job_id: cleanupStatus.job_id }), { mode: 0o600 });
  const cleanup = scrubTerminalJobArtifacts(cleanupDir, cleanupStatus);
  assert.equal(cleanup.scrubbed, true, "verified terminal artifacts were not cleaned");
  assert.equal(cleanupStatus.artifact_cleanup_pending, false, "successful terminal cleanup was not persisted");
  assert.equal(cleanupStatus.artifact_cleanup_error_class, null, "successful terminal cleanup retained an error classification");

  const failedCleanupDir = join(root, "job_terminal_cleanup_failure");
  mkdirSync(failedCleanupDir, { recursive: true, mode: 0o700 });
  const failedCleanupStatus = { job_id: "job_terminal_cleanup_failure", status: "succeeded", finished_at: finishedAt, result_persisted: true };
  writeFileSync(join(failedCleanupDir, "status.json"), JSON.stringify(failedCleanupStatus), { mode: 0o600 });
  writeFileSync(join(failedCleanupDir, "result.json"), JSON.stringify({ ...result, job_id: failedCleanupStatus.job_id }), { mode: 0o600 });
  const failedCleanup = scrubTerminalJobArtifacts(failedCleanupDir, failedCleanupStatus, {
    removeArtifact(file) {
      if (file.endsWith("runtime")) throw Object.assign(new Error("synthetic EACCES cleanup failure"), { code: "EACCES" });
      rmSync(file, { recursive: true, force: true });
    },
  });
  assert.equal(failedCleanup.scrubbed, false, "terminal cleanup failure was reported as successful");
  assert.equal(failedCleanup.errorClass, "permission_denied", "terminal cleanup failure lost its bounded error classification");
  assert.equal(failedCleanupStatus.artifact_cleanup_pending, true, "terminal cleanup failure was not persisted as pending");
  assert.equal(failedCleanupStatus.artifact_cleanup_error_class, "permission_denied", "terminal cleanup error class was not persisted");
  console.log("managed-job terminal evidence cache generation test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
