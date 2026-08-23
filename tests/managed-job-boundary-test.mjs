import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedJobCancellationRequested, writeManagedJobCancellation } from "../src/local/managed-job-cancellation.mjs";
import { MANAGED_JOB_ID, resolveManagedJobDirectory, resolveManagedJobRootIfPresent } from "../src/local/managed-job-directory.mjs";
import { inspectManagedJobDirectoryGeneration, pruneRetiredManagedJobDirectories, removeManagedJobDirectoryIfCurrent, retiredManagedJobDirectories } from "../src/local/managed-job-directory-generation.mjs";
import { confirmRunnerClaim } from "../src/local/managed-job-runner-claim.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-managed-job-boundary-"));
try {
  const jobs = join(root, "jobs");
  mkdirSync(jobs);
  assert.deepEqual(retiredManagedJobDirectories(join(root, "missing-jobs")), [],
    "missing managed-job root was not treated as having no retired generations");
  const id = `job_${"A".repeat(24)}`;
  const dir = join(jobs, id);
  mkdirSync(dir);
  assert.equal(resolveManagedJobDirectory(jobs, id), realpathSync(dir));
  assert.equal(resolveManagedJobRootIfPresent(jobs), realpathSync(jobs));
  if (process.platform !== "win32") {
    let observedDirectoryMode = null;
    assert.equal(resolveManagedJobRootIfPresent(jobs, {
      openSync(target, flags, mode) { observedDirectoryMode = mode; return openSync(target, flags, mode); },
    }), realpathSync(jobs));
    assert.equal(observedDirectoryMode, 0o700, "POSIX managed job directory descriptor open omitted the explicit private mode");
  }
  let windowsDescriptorOpened = false;
  assert.equal(resolveManagedJobRootIfPresent(jobs, {
    platform: "win32",
    openSync() { windowsDescriptorOpened = true; throw new Error("Windows managed job root must not use POSIX directory descriptor pinning"); },
  }), realpathSync(jobs));
  assert.equal(windowsDescriptorOpened, false, "Windows managed job root unexpectedly used POSIX directory descriptor pinning");
  const losslessRootInfo = lstatSync(jobs, { bigint: true });
  assert.equal(typeof losslessRootInfo.dev, "bigint");
  assert.equal(typeof losslessRootInfo.ino, "bigint");
  assert.equal(resolveManagedJobRootIfPresent(join(root, "missing")), null);

  const retiredId = `job_${"R".repeat(24)}`;
  const retiredDir = join(jobs, retiredId);
  mkdirSync(retiredDir);
  const retiredGeneration = inspectManagedJobDirectoryGeneration(retiredDir).identity;
  rmSync(retiredDir, { recursive: true });
  mkdirSync(retiredDir);
  writeFileSync(join(retiredDir, "replacement.txt"), "replacement generation\n");
  assert.equal(removeManagedJobDirectoryIfCurrent(retiredDir, retiredGeneration), false,
    "retention removal deleted a replacement managed-job directory generation");
  assert.equal(existsSync(join(retiredDir, "replacement.txt")), true,
    "retention removal damaged the replacement managed-job directory");
  const replacementGeneration = inspectManagedJobDirectoryGeneration(retiredDir).identity;
  assert.equal(removeManagedJobDirectoryIfCurrent(retiredDir, replacementGeneration), true,
    "retention removal could not delete the exact inspected directory generation");

  const racedId = `job_${"S".repeat(24)}`;
  const racedDir = join(jobs, racedId);
  mkdirSync(racedDir);
  const racedGeneration = inspectManagedJobDirectoryGeneration(racedDir).identity;
  let racedQuarantine = "";
  const racedRemoved = removeManagedJobDirectoryIfCurrent(racedDir, racedGeneration, "managed job directory", {
    renameSync(source, destination) {
      rmSync(source, { recursive: true, force: true });
      mkdirSync(source);
      writeFileSync(join(source, "replacement.txt"), "replacement generation\n");
      racedQuarantine = destination;
      renameSync(source, destination);
    },
  });
  assert.equal(racedRemoved, false, "managed-job retirement deleted a pathname replacement generation");
  const racedInventory = retiredManagedJobDirectories(jobs).find((entry) => entry.dir === racedQuarantine);
  assert(racedInventory?.reclaimable === false && !existsSync(racedDir)
    && existsSync(join(racedQuarantine, "replacement.txt")),
  "managed-job retirement did not preserve a raced replacement generation as quarantined evidence");
  pruneRetiredManagedJobDirectories(jobs, { warn() {} });
  assert.equal(existsSync(racedQuarantine), true,
    "managed-job retired-state maintenance deleted generation-mismatched race evidence");
  rmSync(racedQuarantine, { recursive: true, force: true });

  const crashedId = `job_${"C".repeat(24)}`;
  const crashedDir = join(jobs, crashedId);
  mkdirSync(crashedDir);
  const crashedGeneration = inspectManagedJobDirectoryGeneration(crashedDir).identity;
  const crashedRetiredName = `retired_job_${"Q".repeat(24)}_d${crashedGeneration.dev}_i${crashedGeneration.ino}`;
  assert.equal(MANAGED_JOB_ID.test(crashedRetiredName), false, "internal retired state overlapped the public managed-job id grammar");
  const crashedRetired = join(jobs, crashedRetiredName);
  renameSync(crashedDir, crashedRetired);
  const crashedInventory = retiredManagedJobDirectories(jobs).find((entry) => entry.dir === crashedRetired);
  assert(crashedInventory?.reclaimable === true && crashedInventory.error_class === null,
    "retired managed-job inventory did not recognize the exact crash generation as reclaimable");
  pruneRetiredManagedJobDirectories(jobs, { warn() {} });
  assert.equal(existsSync(crashedRetired), false, "crash-recoverable retired managed-job generation was not reclaimed");

  const corruptRetired = join(jobs, `retired_job_${"Z".repeat(24)}_d${crashedGeneration.dev + 1n}_i${crashedGeneration.ino}`);
  mkdirSync(corruptRetired);
  const corruptInventory = retiredManagedJobDirectories(jobs).find((entry) => entry.dir === corruptRetired);
  assert(corruptInventory?.reclaimable === false && corruptInventory.error_class === "integrity_error",
    "retired managed-job inventory did not fail closed for an encoded generation mismatch");
  const retirementWarnings = [];
  pruneRetiredManagedJobDirectories(jobs, { warn(message, fields) { retirementWarnings.push({ message, fields }); } });
  assert.equal(existsSync(corruptRetired), true, "retired managed-job cleanup deleted a generation that did not match its encoded identity");
  assert(retirementWarnings.some((entry) => entry.fields?.error_class === "integrity_error"),
    "retired managed-job generation mismatch was retained without an integrity diagnostic");
  rmSync(corruptRetired, { recursive: true });

  const retiredFile = join(jobs, `retired_job_${"F".repeat(24)}_d0_i0`);
  writeFileSync(retiredFile, "not-a-directory\n");
  const fileInventory = retiredManagedJobDirectories(jobs).find((entry) => entry.dir === retiredFile);
  assert(fileInventory?.reclaimable === false && fileInventory.error_class === "integrity_error",
    "non-directory retired managed-job state did not block destructive cleanup");
  pruneRetiredManagedJobDirectories(jobs, { warn() {} });
  assert.equal(existsSync(retiredFile), true, "retired managed-job cleanup deleted a non-directory replacement");
  rmSync(retiredFile);

  const malformedRetired = join(jobs, "retired_job_malformed");
  mkdirSync(malformedRetired);
  const malformedInventory = retiredManagedJobDirectories(jobs).find((entry) => entry.dir === malformedRetired);
  assert(malformedInventory?.reclaimable === false && malformedInventory.error_class === "integrity_error",
    "malformed reserved managed-job retirement name was silently ignored");
  pruneRetiredManagedJobDirectories(jobs, { warn() {} });
  assert.equal(existsSync(malformedRetired), true, "malformed reserved managed-job retirement residue was deleted");
  rmSync(malformedRetired, { recursive: true, force: true });

  const marker = join(dir, "cancel");
  assert.equal(managedJobCancellationRequested(marker), false);
  writeManagedJobCancellation(marker, new Date("2026-08-06T00:00:00.000Z"));
  assert.equal(managedJobCancellationRequested(marker), true);
  writeFileSync(marker, "not-a-timestamp\n");
  assert.throws(() => managedJobCancellationRequested(marker), /marker is invalid/);

  const storageError = Object.assign(new Error("synthetic storage failure"), { code: "EIO" });
  assert.throws(() => managedJobCancellationRequested(marker, { inspectPath: () => { throw storageError; } }), error => error === storageError);
  const runnerSource = readFileSync(new URL("../src/local/job-runner.mjs", import.meta.url), "utf8");
  assert(/if \(cancellationAware && isCancellationRequested\(\)\) throw new JobCancelledError\(\);\s*child = spawn\(/.test(runnerSource),
    "managed-job launch lost its final synchronous cancellation check immediately before spawn");
  await assert.rejects(
    confirmRunnerClaim({
      file: join(dir, "runner.pid"), pid: process.pid, processStartedAt: "1", launchToken: "a".repeat(32),
      inspectPath: () => { throw storageError; },
    }),
    error => error === storageError,
  );

  if (process.platform !== "win32") {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const linkedId = `job_${"B".repeat(24)}`;
    symlinkSync(outside, join(jobs, linkedId));
    assert.throws(() => resolveManagedJobDirectory(jobs, linkedId), /real directory/);

    rmSync(marker);
    symlinkSync(join(root, "outside-marker"), marker);
    assert.throws(() => managedJobCancellationRequested(marker), /symbolic link/);
    rmSync(marker);
    writeManagedJobCancellation(marker, new Date("2026-08-06T00:00:01.000Z"));
    linkSync(marker, join(root, "cancel-hard-link"));
    assert.throws(() => managedJobCancellationRequested(marker), /multiple hard links/);
  }
  console.log("managed job boundary test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
