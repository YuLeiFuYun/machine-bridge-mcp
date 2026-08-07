import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedJobCancellationRequested, writeManagedJobCancellation } from "../src/local/managed-job-cancellation.mjs";
import { resolveManagedJobDirectory, resolveManagedJobRootIfPresent } from "../src/local/managed-job-directory.mjs";
import { confirmRunnerClaim } from "../src/local/managed-job-runner-claim.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-managed-job-boundary-"));
try {
  const jobs = join(root, "jobs");
  mkdirSync(jobs);
  const id = `job_${"A".repeat(24)}`;
  const dir = join(jobs, id);
  mkdirSync(dir);
  assert.equal(resolveManagedJobDirectory(jobs, id), realpathSync(dir));
  assert.equal(resolveManagedJobRootIfPresent(jobs), realpathSync(jobs));
  const losslessRootInfo = lstatSync(jobs, { bigint: true });
  assert.equal(typeof losslessRootInfo.dev, "bigint");
  assert.equal(typeof losslessRootInfo.ino, "bigint");
  assert.equal(resolveManagedJobRootIfPresent(join(root, "missing")), null);

  const marker = join(dir, "cancel");
  assert.equal(managedJobCancellationRequested(marker), false);
  writeManagedJobCancellation(marker, new Date("2026-08-06T00:00:00.000Z"));
  assert.equal(managedJobCancellationRequested(marker), true);
  writeFileSync(marker, "not-a-timestamp\n");
  assert.throws(() => managedJobCancellationRequested(marker), /marker is invalid/);

  const storageError = Object.assign(new Error("synthetic storage failure"), { code: "EIO" });
  assert.throws(() => managedJobCancellationRequested(marker, { inspectPath: () => { throw storageError; } }), error => error === storageError);
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
