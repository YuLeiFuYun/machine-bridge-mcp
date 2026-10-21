import { closeSync, fstatSync, rmSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { runFixtureChild } from "../child-fixture.mjs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeManagedJobs, inspectResourceFile, launchRunner, ManagedJobManager } from "../../../src/local/managed-jobs.mjs";



import { normalizeResourceRegistry } from "../../../src/local/managed-job-plan.mjs";
import { managedRunnerEnvironment } from "../../../src/local/managed-job-runner.mjs";
import {  publishProvisionalRunnerClaim } from "../../../src/local/managed-job-runner-claim.mjs";

import {  acquireJobTransitionLock } from "../../../src/local/managed-job-lock.mjs";


import { EXECUTION_SURFACE } from "../../../src/local/execution-surface.mjs";
import { currentProcessStartTimeMs, processStartTimeMs, processState } from "../../../src/local/process-identity.mjs";
import "../../../src/shared/server-metadata.json" with { type: "json" };
import {
  assert, expectThrow, delay, exists, withFixtureResourceTransactionLock, createManagedJobTestManager,
  setRunnerFixtureState, pendingDependencyFixture, settleDependencyFixture,
  waitForConfirmedRunnerClaim, waitForRunning, waitForJob,
  waitForManagedJobFixtureFileText, managedJobFixtureDiagnostics, waitForPidExit, spawnManagedJobTestRunnerWithoutCoverage, managedJobTestRunnerForCoordinatorRoot, MANAGED_JOB_TEST_WAIT_MS, MANAGED_JOB_MULTI_STEP_WAIT_MS,
  MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS, MANAGED_JOB_TREE_TIMEOUT_SECONDS, MANAGED_JOB_TREE_READY_MS,
  RECOVERY_RESOURCE_LOCK_HOLD_MS, runnerEntry,
} from "./common.mjs";

export async function runManagedJobExecutionScenarios(context = {}) {
  const root = context.root || await mkdtemp(join(tmpdir(), "mbm-managed-job-test-"));
  const workspace = context.workspace || join(root, "workspace");
  const jobRoot = context.jobRoot || join(root, "jobs");
  const secretFile = join(root, "local-resource.txt");
  const helperFile = join(workspace, "temporary-helper.txt");
  const cleanupMarker = join(workspace, "cleanup-marker.txt");
  const cancelMarker = join(workspace, "cancel-cleanup-marker.txt");
  const recoveryMarker = join(workspace, "recovery-cleanup-marker.txt");
  const secret = "managed-job-secret-value-42";
  const previousCoordinatorRoot = process.env.AGENT_RESOURCE_COORDINATOR_ROOT;
  const previousBuildRoot = process.env.AGENT_BUILD_ROOT;
  process.env.AGENT_RESOURCE_COORDINATOR_ROOT = join(root, "resource-coordinator");
  process.env.AGENT_BUILD_ROOT = join(root, "build-cache");

  await mkdir(workspace, { recursive: true });
  await mkdir(jobRoot, { recursive: true });
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(secretFile, 0o600);
  await writeFile(helperFile, "temporary", "utf8");

  try {
  const minimalRunnerEnv = managedRunnerEnvironment({
    source: { PATH: "/safe/bin", HOME: "/safe/home", LANG: "C", HTTPS_PROXY: "http://secret", API_TOKEN: "secret" },
  });
  assert(minimalRunnerEnv.PATH === "/safe/bin" && minimalRunnerEnv.HOME === "/safe/home" && minimalRunnerEnv.LANG === "C", "minimal runner environment lost control variables");
  assert(minimalRunnerEnv.HTTPS_PROXY === undefined && minimalRunnerEnv.API_TOKEN === undefined, "minimal runner environment retained daemon credentials");
  assert(minimalRunnerEnv.MBM_EXECUTION_SURFACE === EXECUTION_SURFACE.managedJob,
    "managed runner environment omitted its durable execution-surface identity");
  const recoveryRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin", MBM_RECOVERY_LOCK_TOKEN: "stale" }, recoveryToken: "fresh" });
  assert(recoveryRunnerEnv.MBM_RECOVERY_LOCK_TOKEN === "fresh", "recovery runner environment lost the ownership token");
  const ordinaryRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin", MBM_RECOVERY_LOCK_TOKEN: "stale", MBM_RUNNER_LAUNCH_TOKEN: "stale" } });
  assert(ordinaryRunnerEnv.MBM_RECOVERY_LOCK_TOKEN === undefined, "ordinary runner inherited a stale recovery token");
  assert(ordinaryRunnerEnv.MBM_RUNNER_LAUNCH_TOKEN === undefined, "ordinary runner inherited a stale launch token");
  const resourceRunnerEnv = managedRunnerEnvironment({ source: {
    PATH: "/bin", AGENT_RESOURCE_COORDINATOR_ROOT: process.env.AGENT_RESOURCE_COORDINATOR_ROOT,
    AGENT_BUILD_ROOT: process.env.AGENT_BUILD_ROOT,
  } });
  assert(resourceRunnerEnv.AGENT_RESOURCE_COORDINATOR_ROOT === process.env.AGENT_RESOURCE_COORDINATOR_ROOT
    && resourceRunnerEnv.AGENT_BUILD_ROOT === process.env.AGENT_BUILD_ROOT,
  "minimal runner environment lost resource coordinator/build-root controls");
  const launchRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin" }, launchToken: "a".repeat(32) });
  assert(launchRunnerEnv.MBM_RUNNER_LAUNCH_TOKEN === "a".repeat(32), "runner environment lost the fresh launch token");
  const fullRunnerEnv = managedRunnerEnvironment({ fullEnv: true, source: { PATH: "/bin", API_TOKEN: "explicit", MBM_EXECUTION_SURFACE: "spoofed" } });
  assert(fullRunnerEnv.API_TOKEN === "explicit", "explicit full-env runner did not preserve the requested parent environment");
  assert(fullRunnerEnv.MBM_EXECUTION_SURFACE === EXECUTION_SURFACE.managedJob,
    "full-env managed runner allowed the parent to spoof its execution surface");

  const failedRunnerDir = join(root, `job_${"R".repeat(24)}`);
  await mkdir(failedRunnerDir, { recursive: true });
  const runnerErrors = [];
  const failedChild = new EventEmitter();
  failedChild.pid = undefined;
  failedChild.unref = () => { throw new Error("failed runner must not be unreferenced"); };
  expectThrow(() => launchRunner(failedRunnerDir, false, "", {
    spawnProcess: () => failedChild,
    logger: { error(message, fields) { runnerErrors.push({ message, fields }); } },
  }), "did not receive a process id");
  failedChild.emit("error", Object.assign(new Error("resource exhausted"), { code: "EAGAIN" }));
  assert(runnerErrors.length === 1 && runnerErrors[0].fields.error_class === "execution_failed", "asynchronous runner spawn failure was unhandled or unobservable");
  assert(!("job_id" in runnerErrors[0].fields), "default asynchronous runner failure log exposed the managed-job identifier");

  for (const fault of ["descriptor-close-failed", "logger-threw", ...(process.platform === "win32" ? [] : ["diagnostic-replaced"])]) {
    const faultDir = join(root, "runner-launch-" + fault);
    await mkdir(faultDir, { mode: 0o700 });
    const child = new EventEmitter();
    child.pid = 90_000_023;
    child.unref = () => {};
    let descriptors = [];
    let reported = 0;
    const outside = join(root, "runner-launch-untouched.txt");
    await writeFile(outside, "untouched", { mode: 0o600 });
    const returnedPid = launchRunner(faultDir, false, "", {
      spawnProcess(_command, _args, options) {
        descriptors = options.stdio.slice(1);
        for (const fd of descriptors) assert((process.platform === "win32" || (fstatSync(fd).mode & 0o077) === 0), "runner inherited a public diagnostic descriptor");
        if (fault === "descriptor-close-failed") closeSync(descriptors[0]);
        if (fault === "diagnostic-replaced") {
          rmSync(join(faultDir, "runner.err.log"));
          symlinkSync(outside, join(faultDir, "runner.err.log"));
        }
        return child;
      },
      logger: { error() { reported += 1; if (fault === "logger-threw") throw new Error("synthetic closed logging sink"); } },
    });
    assert(returnedPid === child.pid, "diagnostic cleanup discarded the child launch outcome");
    child.emit("error", Object.assign(new Error("synthetic child error"), { code: "EAGAIN" }));
    assert(reported === 1 && await readFile(outside, "utf8") === "untouched",
      "runner error was unobserved or diagnostic handling followed a replaced path");
    for (const fd of descriptors) {
      let closed = false;
      try { fstatSync(fd); } catch (error) { closed = error?.code === "EBADF"; }
      assert(closed, "runner launch leaked a parent diagnostic descriptor");
    }
    await rm(faultDir, { recursive: true, force: true });
  }

  const provisionalRunnerDir = join(root, `job_${"P".repeat(24)}`);
  await mkdir(provisionalRunnerDir, { recursive: true });
  const provisionalChild = new EventEmitter();
  provisionalChild.pid = process.pid;
  provisionalChild.unref = () => {};
  let provisionalEnvironment = null;
  const provisionalPid = launchRunner(provisionalRunnerDir, false, "", {
    spawnProcess: (_command, _args, options) => { provisionalEnvironment = options.env; return provisionalChild; },
  });
  const provisionalClaim = JSON.parse(await readFile(join(provisionalRunnerDir, "runner.pid"), "utf8"));
  assert(provisionalPid === process.pid && provisionalClaim.pid === process.pid, "launchRunner did not synchronously publish the spawned runner pid");
  assert(/^[a-f0-9]{32}$/.test(provisionalClaim.launchToken) && provisionalEnvironment?.MBM_RUNNER_LAUNCH_TOKEN === provisionalClaim.launchToken,
    "launchRunner did not bind the provisional claim to its one-time launch token");
  assert(typeof provisionalClaim.startedAt === "string" && provisionalClaim.committed === true && !provisionalClaim.processStartedAt,
    "provisional runner claim did not preserve its provisional identity shape");
  await rm(provisionalRunnerDir, { recursive: true, force: true });

  const staleRuntimeRunnerDir = join(root, `job_${"S".repeat(24)}`);
  await mkdir(staleRuntimeRunnerDir, { recursive: true });
  const staleRuntimeChild = new EventEmitter();
  staleRuntimeChild.pid = process.pid;
  staleRuntimeChild.unref = () => {};
  const stableLauncher = "/opt/homebrew/bin/node";
  const staleExecutable = "/opt/homebrew/Cellar/node/removed/bin/node";
  let staleRuntimeSpawnCommand = null;
  const staleRuntimeWarnings = [];
  const staleRuntimePid = launchRunner(staleRuntimeRunnerDir, false, "", {
    runtimeExecutable: staleExecutable,
    runtimeLauncher: stableLauncher,
    platform: "darwin",
    isExecutable: (candidate) => candidate === stableLauncher,
    spawnProcess: (command) => { staleRuntimeSpawnCommand = command; return staleRuntimeChild; },
    logger: { warn(message, fields) { staleRuntimeWarnings.push({ message, fields }); }, error() {} },
  });
  assert(staleRuntimePid === process.pid && staleRuntimeSpawnCommand === stableLauncher,
    "managed runner did not recover a removed daemon process.execPath through the original absolute Node launcher");
  assert(staleRuntimeWarnings.length === 1
    && staleRuntimeWarnings[0].fields.runtime_executable_source === "original_launcher"
    && staleRuntimeWarnings[0].fields.stale_exec_path === true,
  "managed runner stale-runtime fallback was not recorded with bounded provenance");
  assert(!JSON.stringify(staleRuntimeWarnings).includes(staleExecutable)
    && !JSON.stringify(staleRuntimeWarnings).includes(stableLauncher),
  "managed runner stale-runtime warning exposed executable paths");
  await rm(staleRuntimeRunnerDir, { recursive: true, force: true });

  const conflictingRunnerDir = join(root, `job_${"C".repeat(24)}`);
  await mkdir(conflictingRunnerDir, { recursive: true });
  await writeFile(join(conflictingRunnerDir, "runner.pid"), `${JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString(), launchToken: "b".repeat(32) })}\n`, { mode: 0o600 });
  const conflictingChild = new EventEmitter();
  conflictingChild.pid = process.pid;
  conflictingChild.unref = () => { throw new Error("conflicting runner must not be unreferenced"); };
  let conflictingChildKilled = false;
  conflictingChild.kill = (signal) => { conflictingChildKilled = signal === "SIGKILL"; return true; };
  expectThrow(() => launchRunner(conflictingRunnerDir, false, "", { spawnProcess: () => conflictingChild }),
    "runner claim is owned by another process");
  assert(conflictingChildKilled, "runner claim collision did not terminate the unowned spawned process");
  await rm(conflictingRunnerDir, { recursive: true, force: true });

  const malformedPruneRoot = join(root, "malformed-runner-prune-jobs");
  const malformedPruneId = `job_${"M".repeat(24)}`;
  const malformedPruneDir = join(malformedPruneRoot, malformedPruneId);
  await mkdir(malformedPruneDir, { recursive: true, mode: 0o700 });
  await writeFile(join(malformedPruneDir, "runner.pid"), "not-json\n", { mode: 0o600 });
  const stalePruneTime = new Date(Date.now() - 120_000);
  await utimes(malformedPruneDir, stalePruneTime, stalePruneTime);
  const pruneWarnings = [];
  const malformedPruneManager = createManagedJobTestManager({
    jobRoot: malformedPruneRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {},
    logger: { warn(message, fields) { pruneWarnings.push({ message, fields }); } },
  });
  malformedPruneManager.prune();
  assert(await exists(malformedPruneDir), "prune deleted a job directory whose runner ownership claim was malformed");
  assert(pruneWarnings.some((entry) => entry.message.includes("unreadable runner ownership")),
    "prune did not report malformed runner ownership while retaining the job");
  const malformedActive = activeManagedJobs(malformedPruneRoot);
  assert(malformedActive.length === 1 && malformedActive[0].job_id === malformedPruneId
    && malformedActive[0].status === "unreadable" && malformedActive[0].runner_alive === true,
  "active-job inventory treated malformed runner ownership as absence");

  const invalidStatusRoot = join(root, "invalid-status-jobs");
  const invalidStatusId = `job_${"U".repeat(24)}`;
  const invalidStatusDir = join(invalidStatusRoot, invalidStatusId);
  await mkdir(invalidStatusDir, { recursive: true, mode: 0o700 });
  const invalidStatusTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await writeFile(join(invalidStatusDir, "status.json"), `${JSON.stringify({
    job_id: invalidStatusId, name: "invalid lifecycle status", status: "unknown-future-state",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(),
  })}\n`, { mode: 0o600 });
  await writeFile(join(invalidStatusDir, "plan.json"), "must-remain-for-inspection\n", { mode: 0o600 });
  await utimes(invalidStatusDir, invalidStatusTime, invalidStatusTime);
  const invalidStatusManager = createManagedJobTestManager({
    jobRoot: invalidStatusRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {},
    logger: { warn() {} },
  });
  invalidStatusManager.prune();
  assert(await exists(join(invalidStatusDir, "plan.json")), "prune scrubbed an unknown lifecycle status as if it were terminal");
  expectThrow(() => invalidStatusManager.cancel({ job_id: invalidStatusId }), "managed job status is invalid");
  const invalidStatusActive = activeManagedJobs(invalidStatusRoot);
  assert(invalidStatusActive.length === 1 && invalidStatusActive[0].status === "unreadable"
    && invalidStatusActive[0].runner_alive === true && invalidStatusActive[0].error_class === "integrity_error",
  "active-job inventory did not fail closed for an unknown lifecycle status");

  const mismatchedIdentityRoot = join(root, "mismatched-job-identity");
  const mismatchedIdentityId = `job_${"I".repeat(24)}`;
  const mismatchedIdentityDir = join(mismatchedIdentityRoot, mismatchedIdentityId);
  await mkdir(mismatchedIdentityDir, { recursive: true, mode: 0o700 });
  await writeFile(join(mismatchedIdentityDir, "status.json"), `${JSON.stringify({
    job_id: `job_${"J".repeat(24)}`, name: "mismatched directory identity", status: "staged",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(),
  })}\n`, { mode: 0o600 });
  await writeFile(join(mismatchedIdentityDir, "plan.json"), "must-remain-after-identity-rejection\n", { mode: 0o600 });
  await utimes(mismatchedIdentityDir, invalidStatusTime, invalidStatusTime);
  const mismatchedIdentityManager = createManagedJobTestManager({
    jobRoot: mismatchedIdentityRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {},
    logger: { warn() {} },
  });
  mismatchedIdentityManager.prune();
  assert(await exists(join(mismatchedIdentityDir, "plan.json")), "prune scrubbed a job whose status identity did not match its directory");
  expectThrow(() => mismatchedIdentityManager.cancel({ job_id: mismatchedIdentityId }), "managed job state does not match its directory");
  assert(activeManagedJobs(mismatchedIdentityRoot).some((job) => job.job_id === mismatchedIdentityId
    && job.status === "unreadable" && job.runner_alive === true && job.error_class === "integrity_error"),
  "active-job inventory did not fail closed for mismatched directory identity");
  const corruptRetiredName = `retired_job_${"K".repeat(24)}_d0_i0`;
  const corruptRetiredDir = join(mismatchedIdentityRoot, corruptRetiredName);
  await mkdir(corruptRetiredDir, { mode: 0o700 });
  const retiredBlockedInventory = activeManagedJobs(mismatchedIdentityRoot);
  const retiredBlockedEntries = retiredBlockedInventory.filter((job) => job.state_kind === "retired_managed_job");
  assert(retiredBlockedEntries.length === 1 && retiredBlockedEntries[0].status === "unreadable"
    && retiredBlockedEntries[0].runner_alive === true && retiredBlockedEntries[0].error_class === "integrity_error"
    && !("job_id" in retiredBlockedEntries[0]) && !retiredBlockedInventory.some((job) => job.job_id === corruptRetiredName),
  "retired managed-job generation mismatch escaped its privacy-bounded internal inventory namespace");
  await rm(corruptRetiredDir, { recursive: true, force: true });

  const inconsistentTerminalRoot = join(root, "inconsistent-terminal-jobs");
  const inconsistentTerminalId = `job_${"T".repeat(24)}`;
  const inconsistentTerminalDir = join(inconsistentTerminalRoot, inconsistentTerminalId);
  await mkdir(inconsistentTerminalDir, { recursive: true, mode: 0o700 });
  await writeFile(join(inconsistentTerminalDir, "status.json"), `${JSON.stringify({
    job_id: inconsistentTerminalId, name: "missing terminal result", status: "succeeded",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(), finished_at: invalidStatusTime.toISOString(),
    result_persisted: true,
  })}\n`, { mode: 0o600 });
  await writeFile(join(inconsistentTerminalDir, "plan.json"), "must-remain-after-terminal-integrity-rejection\n", { mode: 0o600 });
  await utimes(inconsistentTerminalDir, invalidStatusTime, invalidStatusTime);

  const unprovenFailureId = `job_${"U".repeat(24)}`;
  const unprovenFailureDir = join(inconsistentTerminalRoot, unprovenFailureId);
  await mkdir(unprovenFailureDir, { recursive: true, mode: 0o700 });
  await writeFile(join(unprovenFailureDir, "status.json"), `${JSON.stringify({
    job_id: unprovenFailureId, name: "unproven result persistence failure", status: "failed",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(), finished_at: invalidStatusTime.toISOString(),
    result_persisted: false,
  })}\n`, { mode: 0o600 });
  await writeFile(join(unprovenFailureDir, "plan.json"), "must-remain-without-terminal-record-error-class\n", { mode: 0o600 });
  await utimes(unprovenFailureDir, invalidStatusTime, invalidStatusTime);

  const coercedFailureId = `job_${"W".repeat(24)}`;
  const coercedFailureDir = join(inconsistentTerminalRoot, coercedFailureId);
  await mkdir(coercedFailureDir, { recursive: true, mode: 0o700 });
  await writeFile(join(coercedFailureDir, "status.json"), `${JSON.stringify({
    job_id: coercedFailureId, name: "coerced terminal persistence evidence", status: "failed",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(),
    finished_at: [invalidStatusTime.toISOString()],
    result_persisted: false, terminal_record_error_class: ["storage_limit"],
  })}\n`, { mode: 0o600 });
  await writeFile(join(coercedFailureDir, "plan.json"), "must-remain-after-coerced-terminal-evidence\n", { mode: 0o600 });
  await utimes(coercedFailureDir, invalidStatusTime, invalidStatusTime);

  const mismatchedFinishedId = `job_${"V".repeat(24)}`;
  const mismatchedFinishedDir = join(inconsistentTerminalRoot, mismatchedFinishedId);
  await mkdir(mismatchedFinishedDir, { recursive: true, mode: 0o700 });
  await writeFile(join(mismatchedFinishedDir, "status.json"), `${JSON.stringify({
    job_id: mismatchedFinishedId, name: "mismatched terminal generation", status: "succeeded",
    created_at: invalidStatusTime.toISOString(), updated_at: invalidStatusTime.toISOString(), finished_at: invalidStatusTime.toISOString(),
    result_persisted: true,
  })}\n`, { mode: 0o600 });
  await writeFile(join(mismatchedFinishedDir, "result.json"), `${JSON.stringify({
    job_id: mismatchedFinishedId, name: "mismatched terminal generation", status: "succeeded",
    steps: [], finally_steps: [], error_class: null, cleanup_error_class: null,
    finished_at: new Date(invalidStatusTime.getTime() + 1000).toISOString(),
  })}\n`, { mode: 0o600 });
  await writeFile(join(mismatchedFinishedDir, "plan.json"), "must-remain-after-terminal-generation-mismatch\n", { mode: 0o600 });
  await utimes(mismatchedFinishedDir, invalidStatusTime, invalidStatusTime);

  const inconsistentTerminalWarnings = [];
  const inconsistentTerminalManager = createManagedJobTestManager({
    jobRoot: inconsistentTerminalRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {},
    logger: { warn(message, fields) { inconsistentTerminalWarnings.push({ message, fields }); } },
  });
  inconsistentTerminalManager.prune();
  assert(await exists(inconsistentTerminalDir) && await exists(join(inconsistentTerminalDir, "plan.json")),
    "prune scrubbed or evicted terminal state whose persisted result evidence was missing");
  assert(await exists(join(unprovenFailureDir, "plan.json")),
    "prune trusted result_persisted=false without terminal-record failure evidence");
  assert(await exists(join(coercedFailureDir, "plan.json")),
    "prune coerced non-string terminal persistence evidence into cleanup authority");
  assert(await exists(join(mismatchedFinishedDir, "plan.json")),
    "prune trusted same-status terminal files from different finished_at generations");
  assert(inconsistentTerminalWarnings.filter((entry) => entry.fields?.error_class === "integrity_error").length >= 4,
    "terminal evidence mismatches were retained without integrity-class diagnostics");
  const inconsistentActive = activeManagedJobs(inconsistentTerminalRoot);
  assert([inconsistentTerminalId, unprovenFailureId, coercedFailureId, mismatchedFinishedId].every((jobId) => inconsistentActive.some((job) =>
    job.job_id === jobId && job.status === "unreadable" && job.runner_alive === true && job.error_class === "integrity_error")),
  "state inventory did not block removal for corrupted terminal evidence");

  const oversizedRegistry = Object.create(null);
  for (let index = 0; index < 65; index += 1) oversizedRegistry[`r${String(index).padStart(2, "0")}`] = { kind: "file", path: secretFile };
  expectThrow(() => normalizeResourceRegistry(oversizedRegistry), "local resource registry limit exceeded (64)");
  const inheritedRegistry = Object.create({ inherited: { kind: "file", path: secretFile } });
  inheritedRegistry.owned = { kind: "file", path: secretFile };
  const inheritedNormalized = normalizeResourceRegistry(inheritedRegistry);
  assert(Object.keys(inheritedNormalized).length === 1 && Object.hasOwn(inheritedNormalized, "owned") && !Object.hasOwn(inheritedNormalized, "inherited"),
    "resource registry normalization counted or exposed inherited prototype entries");

  const malformedResourceState = join(root, "malformed-resource-state.json");
  await writeFile(malformedResourceState, JSON.stringify({ resources: "corrupt" }) + "\n", { mode: 0o600 });
  const malformedResourceManager = createManagedJobTestManager({
    jobRoot: join(root, "malformed-resource-state-jobs"), workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {}, resourceStatePath: malformedResourceState, recover: false,
  });
  expectThrow(() => malformedResourceManager.resourceInfo(), "resource state registry is invalid");
  expectThrow(() => malformedResourceManager.listResources(), "resource state registry is invalid");

  const resource = inspectResourceFile(secretFile);
  const sourcePathAlias = `${secretFile}.registration-alias`;
  resource.pathAliases = [...new Set([...(resource.pathAliases || []), sourcePathAlias])];
  const prototypeResourceManager = createManagedJobTestManager({
    jobRoot: join(root, "prototype-resource-jobs"),
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: true },
    resources: { constructor: resource },
  });
  const prototypeResources = prototypeResourceManager.listResources();
  assert(prototypeResources.count === 1 && prototypeResources.resources[0].name === "constructor", "prototype-shaped resource name was not treated as ordinary data");
  const prototypeResourceJob = prototypeResourceManager.stage({
    name: "prototype resource",
    steps: [{ argv: [process.execPath, "-e", ""], env_resources: { MBM_PROTOTYPE_RESOURCE: "constructor" } }],
  });
  assert(prototypeResourceManager.inspectLocal({ job_id: prototypeResourceJob.job_id }).review_plan.resources.constructor?.kind === "file", "prototype-shaped resource lookup used inherited state");
  prototypeResourceManager.cancel({ job_id: prototypeResourceJob.job_id });

  const prototypeEnvironment = JSON.parse('{"__proto__":"plain-value","constructor":"constructor-value","toString":"string-value"}');
  const prototypeEnvironmentResources = JSON.parse('{"__proto__":"constructor","valueOf":"constructor"}');
  const prototypeEnvironmentJob = prototypeResourceManager.stage({
    name: "prototype environment",
    steps: [
      { argv: [process.execPath, "-e", ""], env: prototypeEnvironment },
      { argv: [process.execPath, "-e", ""], env_resources: prototypeEnvironmentResources },
    ],
  });
  const prototypeReviewSteps = prototypeResourceManager.inspectLocal({ job_id: prototypeEnvironmentJob.job_id }).review_plan.steps;
  const prototypeStep = prototypeReviewSteps[0];
  const prototypeResourceStep = prototypeReviewSteps[1];
  assert(Object.hasOwn(prototypeStep.env, "__proto__") && prototypeStep.env.__proto__ === "plain-value", "prototype-shaped environment key mutated the validation object prototype");
  assert(Object.hasOwn(prototypeStep.env, "constructor") && prototypeStep.env.constructor === "constructor-value", "constructor environment key was not ordinary data");
  assert(Object.hasOwn(prototypeStep.env, "toString") && prototypeStep.env.toString === "string-value", "toString environment key was not ordinary data");
  assert(Object.hasOwn(prototypeResourceStep.env_resources, "__proto__") && prototypeResourceStep.env_resources.__proto__ === "constructor", "prototype-shaped resource environment key mutated the validation object prototype");
  assert(Object.hasOwn(prototypeResourceStep.env_resources, "valueOf") && prototypeResourceStep.env_resources.valueOf === "constructor", "valueOf resource environment key was not ordinary data");
  prototypeResourceManager.cancel({ job_id: prototypeEnvironmentJob.job_id });
  const manager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false, unrestrictedPaths: true },
    resources: { "test-secret": resource },
  });
  const authorityAccountId = `acct_${"j".repeat(32)}`;
  const authorityClientId = `mcp_client_${"j".repeat(43)}`;
  const authorityFamilyId = `mcp_family_${"j".repeat(43)}`;
  const authorityContext = (accountVersion) => ({ authority: { principal: {
    kind: "account", accountId: authorityAccountId, accountVersion,
    clientId: authorityClientId, familyId: authorityFamilyId, role: "owner",
  } } });
  const blockedRevoked = manager.stage({ name: "revocation retry job", steps: [{ argv: [process.execPath, "-e", ""] }] }, authorityContext(6));
  const blockedRevokedDir = join(jobRoot, blockedRevoked.job_id);
  const blockedRevocationTransition = acquireJobTransitionLock(blockedRevokedDir);
  assert(blockedRevocationTransition, "authority revocation retry fixture could not acquire the transition lock");
  expectThrow(
    () => manager.revokeAuthority({ accountId: authorityAccountId, accountVersion: 6, clientId: authorityClientId, familyId: authorityFamilyId }),
    "authority revocation was incomplete",
  );
  assert(manager.read({ job_id: blockedRevoked.job_id }, authorityContext(6)).status === "staged",
    "failed authority revocation mutated a transition-locked staged job");
  blockedRevocationTransition.release();
  assert(manager.revokeAuthority({ accountId: authorityAccountId, accountVersion: 6, clientId: authorityClientId, familyId: authorityFamilyId }) === 1,
    "retained authority revocation did not succeed after the transient job-state conflict cleared");
  assert(manager.read({ job_id: blockedRevoked.job_id }, authorityContext(6)).status === "cancelled_before_start",
    "retried authority revocation left its staged durable job executable");

  const policyNarrowedJob = manager.stage({ name: "revocation under narrowed policy", steps: [{ argv: [process.execPath, "-e", ""] }] }, authorityContext(7));
  const readOnlyManager = createManagedJobTestManager({
    jobRoot, workspace,
    policy: { allowWrite: false, execMode: "off", minimalEnv: true, unrestrictedPaths: false },
    resources: { "test-secret": resource },
  });
  expectThrow(() => readOnlyManager.cancel({ job_id: policyNarrowedJob.job_id }, authorityContext(7)), "disabled by the active policy");
  assert(readOnlyManager.revokeAuthority({ accountId: authorityAccountId, accountVersion: 7, clientId: authorityClientId, familyId: authorityFamilyId }) === 1,
    "internal authority revocation inherited the public cancel_job policy gate after the daemon policy narrowed");
  assert(readOnlyManager.read({ job_id: policyNarrowedJob.job_id }, authorityContext(7)).status === "cancelled_before_start",
    "narrowed-policy authority revocation left a previously accepted durable job executable");

  const revokedStaged = manager.stage({ name: "revoked staged job", steps: [{ argv: [process.execPath, "-e", ""] }] }, authorityContext(4));
  const currentStaged = manager.stage({ name: "current staged job", steps: [{ argv: [process.execPath, "-e", ""] }] }, authorityContext(5));
  assert(manager.revokeAuthority({ accountId: authorityAccountId, accountVersion: 4, clientId: authorityClientId, familyId: authorityFamilyId }) === 1,
    "managed-job authority revocation did not target exactly the old owner version");
  assert(manager.read({ job_id: revokedStaged.job_id }, authorityContext(4)).status === "cancelled_before_start",
    "revoked staged managed job remained executable");
  assert(manager.read({ job_id: currentStaged.job_id }, authorityContext(5)).status === "staged",
    "managed-job authority revocation cancelled a newer owner version");
  manager.cancel({ job_id: currentStaged.job_id }, authorityContext(5));

  const delayedId = `job_${"Q".repeat(24)}`;
  const delayedDir = join(jobRoot, delayedId);
  await mkdir(delayedDir, { recursive: true, mode: 0o700 });
  const delayedAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(join(delayedDir, "status.json"), `${JSON.stringify({
    job_id: delayedId, name: "provisional runner identity", status: "queued", approval: "mcp",
    created_at: delayedAt, updated_at: delayedAt, current_phase: null, current_step: null,
    cleanup_guarantee: "best-effort-finally-and-recovery",
  }, null, 2)}\n`, { mode: 0o600 });
  let delayedChild = null;
  const delayedPid = launchRunner(delayedDir, false, "", {
    spawnProcess: (_command, _args, options) => {
      delayedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], options);
      return delayedChild;
    },
  });
  try {
    const delayedStatus = manager.read({ job_id: delayedId });
    assert(delayedStatus.status === "queued" && Number(delayedStatus.recovery_attempts || 0) === 0,
      `an active provisional runner was mistaken for an interrupted job after the recovery grace period: status=${JSON.stringify(delayedStatus)} claim=${await readFile(join(delayedDir, "runner.pid"), "utf8").catch(() => "missing")}`);
    const remoteDelayedStatus = manager.read({ job_id: delayedId }, { authority: { origin: "relay", owner: true } });
    assert(remoteDelayedStatus.host_turn_handoff_recommended === false && remoteDelayedStatus.status_polling_mode === "bounded_followup",
      "remote active read_job did not preserve bounded same-turn follow-up");
    assert(!("host_turn_handoff_recommended" in delayedStatus) && !("status_polling_mode" in delayedStatus),
      "local read_job unexpectedly gained hosted-turn polling metadata");
    const inFlightFinishedAt = new Date().toISOString();
    await writeFile(join(delayedDir, "result.json"), `${JSON.stringify({
      job_id: delayedId, name: "provisional runner identity", status: "succeeded",
      steps: [], finally_steps: [], error_class: null, cleanup_error_class: null, finished_at: inFlightFinishedAt,
    })}\n`, { mode: 0o600 });
    const coherentTerminalRead = manager.read({ job_id: delayedId });
    assert(coherentTerminalRead.status === "succeeded"
      && coherentTerminalRead.result?.status === "succeeded"
      && coherentTerminalRead.result_persisted === true
      && coherentTerminalRead.artifact_cleanup_pending === true,
    "read_job combined an active status generation with a newer terminal result generation");
    const remoteTerminalRead = manager.read({ job_id: delayedId }, { authority: { origin: "relay", owner: true } });
    assert(remoteTerminalRead.host_turn_handoff_recommended === false && remoteTerminalRead.status_polling_mode === "terminal",
      "remote terminal read_job retained active follow-up semantics");
    await writeFile(join(delayedDir, "result.json"), `${JSON.stringify({
      job_id: delayedId, status: "running", steps: [], finally_steps: [], finished_at: inFlightFinishedAt,
    })}\n`, { mode: 0o600 });
    expectThrow(() => manager.read({ job_id: delayedId }), "managed job result is invalid");
  } finally {
    try { process.kill(delayedPid, "SIGKILL"); } catch {}
    await waitForPidExit(delayedPid, MANAGED_JOB_TEST_WAIT_MS).catch(() => {});
    await rm(delayedDir, { recursive: true, force: true });
  }

  const reconstructedId = `job_${"T".repeat(24)}`;
  const reconstructedDir = join(jobRoot, reconstructedId);
  await mkdir(reconstructedDir, { recursive: true, mode: 0o700 });
  const reconstructedFinishedAt = new Date(Date.now() - 5000).toISOString();
  await writeFile(join(reconstructedDir, "status.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "running", approval: "mcp",
    created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 30_000).toISOString(),
    current_phase: "finally_steps", current_step: 0, cleanup_guarantee: "best-effort-finally-and-recovery",
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, status: "running", steps: [], finally_steps: [], finished_at: reconstructedFinishedAt,
  })}\n`, { mode: 0o600 });
  expectThrow(() => manager.read({ job_id: reconstructedId }), "managed job result is invalid");
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "failed",
    steps: [], finally_steps: [], error_class: "execution_failed", cleanup_error_class: null,
    finished_at: reconstructedFinishedAt,
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(reconstructedDir, "plan.json"), "sensitive-plan-must-be-scrubbed\n", { mode: 0o600 });
  const reconstructed = manager.read({ job_id: reconstructedId });
  assert(reconstructed.status === "failed" && reconstructed.finished_at === reconstructedFinishedAt, "terminal result did not reconstruct an interrupted status");
  assert(reconstructed.result_persisted === true && reconstructed.artifact_cleanup_pending === false, "reconstructed terminal status lost persistence metadata");
  assert(!(await exists(join(reconstructedDir, "plan.json"))), "terminal result recovery retained the sensitive execution plan");
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "succeeded",
    steps: [], finally_steps: [], error_class: null, cleanup_error_class: null, finished_at: reconstructedFinishedAt,
  })}\n`, { mode: 0o600 });
  expectThrow(() => manager.read({ job_id: reconstructedId }), "managed job terminal status and result are inconsistent");
  await rm(join(reconstructedDir, "result.json"), { force: true });
  expectThrow(() => manager.read({ job_id: reconstructedId }), "managed job terminal result is missing");
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "failed",
    steps: [], finally_steps: [], error_class: "execution_failed", cleanup_error_class: null,
    finished_at: reconstructedFinishedAt,
  })}\n`, { mode: 0o600 });

  const restrictedManager = createManagedJobTestManager({
    jobRoot: join(root, "restricted-jobs"),
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: false },
    resources: {},
  });
  expectThrow(() => restrictedManager.start({
    steps: [{ argv: [process.execPath, "-e", ""], cwd: root }],
  }), "outside the configured workspace");

  const unreadableRoot = join(root, "unreadable-jobs");
  const unreadableId = `job_${"A".repeat(24)}`;
  const unreadableDir = join(unreadableRoot, unreadableId);
  await mkdir(unreadableDir, { recursive: true });
  await writeFile(join(unreadableDir, "status.json"), "not-json\n", { mode: 0o600 });
  const oldUnreadable = new Date(Date.now() - 120_000);
  await utimes(unreadableDir, oldUnreadable, oldUnreadable);
  const unreadableManager = createManagedJobTestManager({
    jobRoot: unreadableRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: false },
    resources: {},
    logger: { warn() {} },
    recover: true,
  });
  assert(await exists(unreadableDir), "managed-job pruning deleted unreadable state");
  const unreadableList = unreadableManager.list({ limit: 10 });
  assert(unreadableList.jobs.some((job) => job.job_id === unreadableId && job.status === "unreadable"), "managed-job list hid unreadable state");
  assert(activeManagedJobs(unreadableRoot).some((job) => job.job_id === unreadableId && job.status === "unreadable"), "unreadable managed job did not block removal");

  const expiredStaged = manager.stage({
    name: "expired staged sensitive plan",
    steps: [{ argv: [process.execPath, "-e", ""], env: { PRIVATE_VALUE: "must-be-scrubbed" }, stdin: "sensitive-stdin" }],
  });
  assert(expiredStaged.plan_expires_after_hours === 24, "staged job did not report the 24-hour sensitive-plan TTL");
  const expiredDir = join(jobRoot, expiredStaged.job_id);
  const expiredStatusFile = join(expiredDir, "status.json");
  const expiredStatus = JSON.parse(await readFile(expiredStatusFile, "utf8"));
  expiredStatus.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeFile(expiredStatusFile, JSON.stringify(expiredStatus, null, 2) + "\n", { mode: 0o600 });
  const heldExpiryTransition = acquireJobTransitionLock(expiredDir);
  assert(heldExpiryTransition, "staged expiry fixture could not acquire the per-job transition lock");
  manager.list({ limit: 50 });
  const expiryBlockedStatus = JSON.parse(await readFile(expiredStatusFile, "utf8"));
  assert(expiryBlockedStatus.status === "staged" && await exists(join(expiredDir, "plan.json")),
    "staged retention mutated a job while another transition owned its state machine");
  heldExpiryTransition.release();
  manager.list({ limit: 50 });
  const expiredResult = manager.read({ job_id: expiredStaged.job_id });
  assert(expiredResult.status === "expired_before_start" && expiredResult.error_class === "expired", "staged sensitive plan did not expire fail-closed");
  assert(expiredResult.result_persisted === true && expiredResult.artifact_cleanup_pending === false,
    "staged expiry bypassed the shared result-first terminal persistence contract");
  assert(!(await exists(join(expiredDir, "plan.json"))), "expired staged plan retained env/stdin/script content");
  const expiredDiskText = (await Promise.all(["status.json", "result.json"].map((name) => readFile(join(expiredDir, name), "utf8")))).join("\n");
  assert(!expiredDiskText.includes("must-be-scrubbed") && !expiredDiskText.includes("sensitive-stdin"), "expired staged audit records retained sensitive plan content");

  const malformedExpiry = manager.stage({
    name: "malformed staged timestamp",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const malformedExpiryDir = join(jobRoot, malformedExpiry.job_id);
  const malformedExpiryStatusFile = join(malformedExpiryDir, "status.json");
  const malformedExpiryStatus = JSON.parse(await readFile(malformedExpiryStatusFile, "utf8"));
  malformedExpiryStatus.created_at = [new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()];
  await writeFile(malformedExpiryStatusFile, `${JSON.stringify(malformedExpiryStatus)}\n`, { mode: 0o600 });
  manager.list({ limit: 50 });
  const retainedMalformedExpiry = JSON.parse(await readFile(malformedExpiryStatusFile, "utf8"));
  assert(retainedMalformedExpiry.status === "staged" && await exists(join(malformedExpiryDir, "plan.json")),
    "staged retention coerced malformed created_at evidence into destructive expiry authority");
  manager.cancel({ job_id: malformedExpiry.job_id });

  const degradedExpiry = manager.stage({
    name: "expired staged result persistence failure",
    steps: [{ argv: [process.execPath, "-e", ""], stdin: "must-be-scrubbed-on-result-failure" }],
  });
  const degradedExpiryDir = join(jobRoot, degradedExpiry.job_id);
  const degradedExpiryStatusFile = join(degradedExpiryDir, "status.json");
  const degradedExpiryStatus = JSON.parse(await readFile(degradedExpiryStatusFile, "utf8"));
  degradedExpiryStatus.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeFile(degradedExpiryStatusFile, `${JSON.stringify(degradedExpiryStatus)}\n`, { mode: 0o600 });
  await mkdir(join(degradedExpiryDir, "result.json"));
  manager.list({ limit: 50 });
  const degradedExpiryTerminal = JSON.parse(await readFile(degradedExpiryStatusFile, "utf8"));
  assert(degradedExpiryTerminal.status === "expired_before_start"
    && degradedExpiryTerminal.result_persisted === false
    && typeof degradedExpiryTerminal.terminal_record_error_class === "string",
  "staged expiry result-write failure did not preserve an explicit terminal-record failure in status");
  const degradedExpiryRead = manager.read({ job_id: degradedExpiry.job_id });
  assert(degradedExpiryRead.status === "expired_before_start" && degradedExpiryRead.result_persisted === false && !("result" in degradedExpiryRead),
    "read_job retried an explicitly unpersisted terminal result instead of returning its status evidence");
  assert(!(await exists(join(degradedExpiryDir, "plan.json"))),
    "staged expiry result-write failure retained the sensitive plan after terminal status persisted");
  await rm(join(degradedExpiryDir, "result.json"), { recursive: true, force: true });

  const longAbandonedStage = manager.stage({ name: "long abandoned staged draft", steps: [{ argv: [process.execPath, "-e", ""] }] });
  const longAbandonedDir = join(jobRoot, longAbandonedStage.job_id);
  const longAbandonedStatusFile = join(longAbandonedDir, "status.json");
  const longAbandonedStatus = JSON.parse(await readFile(longAbandonedStatusFile, "utf8"));
  const longAbandonedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  longAbandonedStatus.created_at = longAbandonedAt.toISOString();
  await writeFile(longAbandonedStatusFile, `${JSON.stringify(longAbandonedStatus)}\n`, { mode: 0o600 });
  await utimes(longAbandonedDir, longAbandonedAt, longAbandonedAt);
  manager.list({ limit: 50 });
  assert(await exists(longAbandonedDir) && await exists(join(longAbandonedDir, "result.json")),
    "newly expired staged record was immediately deleted using its pre-expiry directory age");
  const longAbandonedTerminal = JSON.parse(await readFile(longAbandonedStatusFile, "utf8"));
  assert(longAbandonedTerminal.status === "expired_before_start" && Date.parse(longAbandonedTerminal.finished_at) > longAbandonedAt.getTime(),
    "long-abandoned staged record did not begin terminal retention from its actual expiry transition");

  expectThrow(() => manager.stage({
    name: "invalid capture output",
    steps: [{ argv: [process.execPath, "-e", ""], capture_output: "raw" }],
  }), "capture_output must be redacted or discard");
  expectThrow(() => manager.stage({ name: "bad finally", steps: [{ argv: [process.execPath, "-e", ""] }], finally_steps: "" }), "finally_steps must contain 0-16 steps");
  expectThrow(() => manager.stage({ name: "bad temp", steps: [{ argv: [process.execPath, "-e", ""] }], temporary_files: 0 }), "temporary_files must contain 0-16 files");
  expectThrow(() => manager.stage({ name: "bad temp name", steps: [{ argv: [process.execPath, "-e", ""] }], temporary_files: [{ name: ["helper"], content: "" }] }), "resource name must be a string");
  expectThrow(() => manager.stage({ name: "bad resource alias", steps: [{ argv: [process.execPath, "-e", ""], env_resources: { MBM_BAD: ["test-secret"] } }] }), "resource name must be a string");
  expectThrow(() => manager.stage({ name: "bad bool", steps: [{ argv: [process.execPath, "-e", ""], allow_failure: "true" }] }), "allow_failure must be a boolean");
  expectThrow(() => manager.stage({ name: "bad timeout", steps: [{ argv: [process.execPath, "-e", ""], timeout_seconds: "60" }] }), "timeout_seconds must be an integer between 1 and 21600");
  const hundredMinuteStage = manager.stage({
    name: "single-step over 100 minutes",
    steps: [{ argv: [process.execPath, "-e", ""], timeout_seconds: 6_100 }],
  });
  const hundredMinuteInspection = manager.inspectLocal({ job_id: hundredMinuteStage.job_id });
  assert(hundredMinuteInspection.review_plan?.steps?.[0]?.timeout_seconds === 6_100,
    "managed-job plan could not retain one continuous step beyond 100 minutes");
  manager.cancel({ job_id: hundredMinuteStage.job_id });
  expectThrow(() => manager.stage({
    name: "step timeout beyond managed-job ceiling",
    steps: [{ argv: [process.execPath, "-e", ""], timeout_seconds: 21_601 }],
  }), "timeout_seconds must be an integer between 1 and 21600");
  expectThrow(() => manager.stage({ name: "bad executable", temporary_files: [{ name: "helper.js", content: "", executable: "true" }], steps: [{ argv: [process.execPath, "-e", ""] }] }), "temporary_files[0].executable must be a boolean");
  expectThrow(() => inspectResourceFile([secretFile]), "resource path must be a string");

  const stagedMarker = join(workspace, "staged-review-only.txt");
  const staged = manager.stage({
    name: "review-only staged draft",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", stagedMarker], env_resources: { MBM_REVIEW_ONLY: "test-secret" }, timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  assert(staged.status === "staged" && staged.execution_started === false, "stage_job started execution");
  await delay(200);
  assert(!(await exists(stagedMarker)), "review-only staged job executed");
  const stagedStatus = manager.read({ job_id: staged.job_id });
  assert(stagedStatus.status === "staged" && stagedStatus.approval === "review-only" && await exists(join(jobRoot, staged.job_id, "plan.json")), "staged plan was not retained as review-only state");
  const stagedInspection = manager.inspectLocal({ job_id: staged.job_id });
  const stagedInspectionText = JSON.stringify(stagedInspection);
  assert(stagedInspection.review_plan?.steps?.length === 1 && stagedInspection.plan_sha256 === staged.plan_sha256 && stagedInspection.plan_integrity_verified === true, "local staged-plan inspection is incomplete");
  const inspectedResource = stagedInspection.review_plan?.resources?.["test-secret"];
  assert(!stagedInspectionText.includes(secretFile) && inspectedResource && !("path" in inspectedResource) && !("sha256" in inspectedResource), "local staged-plan inspection exposed a resource source path/hash");
  assert(manager.approve === undefined, "removed staged-plan promotion API remained reachable on ManagedJobManager");
  const reviewCancelled = manager.cancel({ job_id: staged.job_id });
  assert(reviewCancelled.status === "cancelled_before_start" && !(await exists(stagedMarker)), "review-only staged draft was not cancelled without execution");

  const tamperedMarker = join(workspace, "tampered-plan-ran.txt");
  const tampered = manager.stage({
    name: "tamper detection",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", tamperedMarker] }],
  });
  const tamperedPlanFile = join(jobRoot, tampered.job_id, "plan.json");
  const tamperedPlan = JSON.parse(await readFile(tamperedPlanFile, "utf8"));
  tamperedPlan.name = "modified after review";
  await writeFile(tamperedPlanFile, `${JSON.stringify(tamperedPlan, null, 2)}\n`, { mode: 0o600 });
  expectThrow(() => manager.inspectLocal({ job_id: tampered.job_id }), "plan integrity check failed");
  assert(!(await exists(tamperedMarker)), "tampered staged plan executed");
  manager.cancel({ job_id: tampered.job_id });

  const directMarker = join(workspace, "direct-staged-runner.txt");
  const directStaged = manager.stage({
    name: "direct staged runner rejection",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", directMarker] }],
  });
  const directRunner = spawn(process.execPath, [runnerEntry, "--job-dir", join(jobRoot, directStaged.job_id)], { stdio: "ignore", windowsHide: true });
  const { code: directExit } = await runFixtureChild(directRunner, { label: "staged runner" });
  assert(directExit !== 0, "runner accepted an unapproved staged job");
  const directStatus = manager.read({ job_id: directStaged.job_id });
  assert(directStatus.status === "staged" && !(await exists(directMarker)), "direct runner changed or executed a staged job");
  assert(!(await exists(join(jobRoot, directStaged.job_id, "runner.pid"))), "rejected staged runner left a PID claim");
  manager.cancel({ job_id: directStaged.job_id });

  const locked = manager.stage({
    name: "transition lock",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  if (process.platform !== "win32") {
    const hardState = manager.stage({ name: "hard-linked state", steps: [{ argv: [process.execPath, "-e", ""] }] });
    const hardStateDir = join(jobRoot, hardState.job_id);
    const hardStatus = join(hardStateDir, "status.json");
    const hardStatusAlias = join(hardStateDir, "status.json.alias");
    const hardPlan = join(hardStateDir, "plan.json");
    const hardPlanAlias = join(hardStateDir, "plan.json.alias");
    try {
      await link(hardStatus, hardStatusAlias);
      expectThrow(() => manager.read({ job_id: hardState.job_id }), "insecure_links");
      assert(await exists(hardStatus) && await exists(hardStatusAlias), "hard-linked job status was modified after rejection");
      await rm(hardStatusAlias, { force: true });
      await link(hardPlan, hardPlanAlias);
      expectThrow(() => manager.inspectLocal({ job_id: hardState.job_id }), "insecure_links");
      assert(await exists(hardPlan) && await exists(hardPlanAlias), "hard-linked job plan was modified after rejection");
    } finally {
      await rm(hardStatusAlias, { force: true });
      await rm(hardPlanAlias, { force: true });
    }
    manager.cancel({ job_id: hardState.job_id });
  }

  const transitionLock = join(jobRoot, locked.job_id, "transition.lock");
  await writeFile(transitionLock, `${JSON.stringify({
    pid: process.pid,
    token: "b".repeat(32),
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
  })}\n`, { mode: 0o600 });
  expectThrow(() => manager.inspectLocal({ job_id: locked.job_id }), "job state is being modified");
  expectThrow(() => manager.cancel({ job_id: locked.job_id }), "job state is being modified");
  await rm(transitionLock, { force: true });

  await writeFile(transitionLock, "{malformed", { mode: 0o600 });
  expectThrow(() => manager.inspectLocal({ job_id: locked.job_id }), "managed-job lock is malformed");
  expectThrow(() => manager.cancel({ job_id: locked.job_id }), "managed-job lock is malformed");
  assert((await readFile(transitionLock, "utf8")) === "{malformed",
    "malformed managed-job transition lock was deleted or rewritten by inspection/cancellation");
  await rm(transitionLock, { force: true });
  manager.cancel({ job_id: locked.job_id });

  const hardLinked = manager.stage({
    name: "hard-linked transition lock",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const hardLinkedLock = join(jobRoot, hardLinked.job_id, "transition.lock");
  const hardLinkedAlias = join(jobRoot, hardLinked.job_id, "transition.lock.alias");
  await writeFile(hardLinkedLock, `${JSON.stringify({
    pid: process.pid, token: "a".repeat(32), startedAt: new Date().toISOString(),
    processStartedAt: new Date(Date.now() - 1000).toISOString(),
  })}\n`, { mode: 0o600 });
  try {
    await link(hardLinkedLock, hardLinkedAlias);
    expectThrow(() => manager.cancel({ job_id: hardLinked.job_id }), "multiple hard links");
    assert(await exists(hardLinkedLock) && await exists(hardLinkedAlias), "managed-job lock rejection removed a multiply-linked lock");
    await rm(hardLinkedAlias, { force: true });
  } catch (error) {
    if (!["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error?.code)) throw error;
  }
  await rm(hardLinkedLock, { force: true });
  manager.cancel({ job_id: hardLinked.job_id });

  const staleReusedPid = manager.stage({
    name: "stale reused pid transition lock",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const staleTransitionLock = join(jobRoot, staleReusedPid.job_id, "transition.lock");
  await writeFile(staleTransitionLock, `${JSON.stringify({
    pid: process.pid,
    token: "c".repeat(32),
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs() - 60_000).toISOString(),
  })}\n`, { mode: 0o600 });
  const oldTime = new Date(Date.now() - 10 * 60_000);
  await utimes(staleTransitionLock, oldTime, oldTime);
  const staleCancellation = manager.cancel({ job_id: staleReusedPid.job_id });
  assert(staleCancellation.status === "cancelled_before_start", "stale transition lock with a reused live PID was not reclaimed");

  for (const [name, mutation] of [
    ["array token", { token: ["a".repeat(32)] }],
    ["array timestamp", { startedAt: [new Date().toISOString()] }],
  ]) {
    const malformedLock = manager.stage({
      name: `stale ${name} transition lock`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
    const malformedLockPath = join(jobRoot, malformedLock.job_id, "transition.lock");
    await writeFile(malformedLockPath, `${JSON.stringify({
      pid: process.pid,
      token: "a".repeat(32),
      startedAt: new Date().toISOString(),
      processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
      ...mutation,
    })}\n`, { mode: 0o600 });
    await utimes(malformedLockPath, oldTime, oldTime);
    expectThrow(() => manager.cancel({ job_id: malformedLock.job_id }), "managed-job lock is malformed");
    assert(await exists(malformedLockPath),
      `stale transition lock with ${name} was reclaimed by age despite malformed ownership metadata`);
    await rm(malformedLockPath, { force: true });
    manager.cancel({ job_id: malformedLock.job_id });
  }

  const stdinMutationMarker = join(workspace, "stdin-mutation-once.txt");
  const stdinCleanupMarker = join(workspace, "stdin-cleanup-once.txt");
  const closedStdin = manager.start({
    name: "early closed child stdin",
    steps: [{
      argv: [process.execPath, "-e",
        "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');fs.closeSync(0);setTimeout(()=>process.exit(0),100)",
        stdinMutationMarker],
      env: { NODE_V8_COVERAGE: "" }, stdin: "x".repeat(256 * 1024), timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
    finally_steps: [{
      argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],'x')", stdinCleanupMarker],
      env: { NODE_V8_COVERAGE: "" }, timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
  });
  const stdinResult = await waitForJob(manager, closedStdin.job_id);
  assert(stdinResult.status === "failed" && stdinResult.error_class === "execution_failed",
    "early closed child stdin was silently accepted or escaped through runner crash recovery");
  assert(await readFile(stdinMutationMarker, "utf8") === "x", "stdin delivery failure replayed the main mutation");
  assert(await readFile(stdinCleanupMarker, "utf8") === "x", "stdin delivery failure skipped or duplicated finally cleanup");
  const stdinRunnerDiagnostics = await readFile(join(jobRoot, closedStdin.job_id, "runner.err.log"), "utf8");
  assert(!stdinRunnerDiagnostics.includes("Unhandled 'error' event"), "child stdin EPIPE still terminated the job runner");
  assert(stdinResult.result_persisted === true && stdinResult.artifact_cleanup_pending === false,
    "stdin failure did not settle durable result persistence and artifact cleanup");

  const privateRuntimeManager = createManagedJobTestManager({
    jobRoot: join(root, "private-runtime-jobs"), workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {}, recover: false,
  });
  const privateRuntime = privateRuntimeManager.start({
    name: "minimal job runtime directories",
    steps: [{ argv: [process.execPath, "-e",
      "const fs=require('node:fs'),os=require('node:os'),p=require('node:path');for(const n of ['HOME','TMPDIR','XDG_CACHE_HOME']){const s=fs.lstatSync(process.env[n]);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)!==0))throw new Error('runtime directory is not private');}const t=fs.mkdtempSync(p.join(os.tmpdir(),'synthetic-'));fs.writeFileSync(p.join(t,'synthetic.txt'),'ok');fs.rmSync(t,{recursive:true});process.stdout.write('private-runtime-ok');"],
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  const privateRuntimeResult = await waitForJob(privateRuntimeManager, privateRuntime.job_id);
  assert(privateRuntimeResult.status === "succeeded" && privateRuntimeResult.result?.steps?.[0]?.stdout === "private-runtime-ok",
    "minimal managed jobs cannot use their private home, temp and cache directories");

  const runnerDiagnosticRoot = join(root, "runner-diagnostic-jobs");
  const runnerDiagnosticManager = new ManagedJobManager({
    jobRoot: runnerDiagnosticRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: true },
    resources: {},
    recover: false,
  });
  const trimmedLogJob = runnerDiagnosticManager.stage({
    name: "bounded runner diagnostics",
    steps: [{ argv: [process.execPath, "--version"] }],
  });
  const trimmedLogInspection = runnerDiagnosticManager.inspectLocal({ job_id: trimmedLogJob.job_id });
  assert(trimmedLogInspection.review_plan?.full_env === false
    && !Object.hasOwn(trimmedLogInspection.review_plan?.steps?.[0]?.env || {}, "NODE_V8_COVERAGE"),
  "bounded runner diagnostic fixture inherited a Node instrumentation environment and lost deterministic light admission");
  await setRunnerFixtureState(runnerDiagnosticRoot, trimmedLogJob.job_id, true);
  const trimmedLogPath = join(runnerDiagnosticRoot, trimmedLogJob.job_id, "runner.out.log");
  const trimTailMarker = "runner-diagnostic-tail-marker";
  await writeFile(trimmedLogPath, `${"old-line\n".repeat(20_000)}${trimTailMarker}\n`, { mode: 0o600 });
  launchRunner(join(runnerDiagnosticRoot, trimmedLogJob.job_id));
  await waitForJob(runnerDiagnosticManager, trimmedLogJob.job_id);
  const trimmedLog = await readFile(trimmedLogPath, "utf8");
  assert(Buffer.byteLength(trimmedLog) <= 64 * 1024, "runner diagnostic log remained above its launch bound");
  assert(trimmedLog.includes(trimTailMarker), "runner diagnostic trimming discarded the useful tail");

  if (process.platform !== "win32") {
    const logTarget = join(root, "runner-log-symlink-target.txt");
    await writeFile(logTarget, "unchanged", "utf8");
    const logSymlinkJob = manager.stage({
      name: "runner log symlink rejection",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
    await setRunnerFixtureState(jobRoot, logSymlinkJob.job_id, true);
    await symlink(logTarget, join(jobRoot, logSymlinkJob.job_id, "runner.out.log"));
    expectThrow(() => launchRunner(join(jobRoot, logSymlinkJob.job_id)), "symbolic link");
    assert(await readFile(logTarget, "utf8") === "unchanged", "runner diagnostics followed a symbolic link");
    await rm(join(jobRoot, logSymlinkJob.job_id, "runner.out.log"), { force: true });
    await setRunnerFixtureState(jobRoot, logSymlinkJob.job_id, false);
    manager.cancel({ job_id: logSymlinkJob.job_id });
  }

  const neverRunMarker = join(workspace, "staged-cancelled.txt");
  const stagedCancelled = manager.stage({
    name: "cancel before approval",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'should-not-run')", neverRunMarker] }],
    finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'finally-should-not-run')", neverRunMarker] }],
  });
  const cancelledBeforeStart = manager.cancel({ job_id: stagedCancelled.job_id });
  assert(cancelledBeforeStart.status === "cancelled_before_start" && cancelledBeforeStart.execution_started === false, "staged cancellation status is incorrect");
  const cancelledBeforeStartRead = manager.read({ job_id: stagedCancelled.job_id });
  assert(cancelledBeforeStartRead.result_persisted === true && cancelledBeforeStartRead.artifact_cleanup_pending === false
    && cancelledBeforeStartRead.result?.status === "cancelled_before_start",
  "staged cancellation did not use the same result-first terminal persistence contract as runner completion");
  await delay(200);
  assert(!(await exists(neverRunMarker)), "cancelled staged job executed a main or finally step");
  assert(!(await exists(join(jobRoot, stagedCancelled.job_id, "plan.json"))), "cancelled staged plan was not scrubbed");

  const publicResources = manager.listResources();
  assert(publicResources.count === 1 && publicResources.resources[0].name === "test-secret", "resource alias was not listed");
  assert(!JSON.stringify(publicResources).includes(secretFile) && !JSON.stringify(publicResources).includes(secret), "resource listing exposed a path or value");
  assert(manager.diagnoseStorage().ok, "managed-job storage probe failed");

  const idempotencyKey = "managed-job-idempotency-retry-001";
  // Idempotency is the behavior under test here, not resource admission. On POSIX use the
  // identity-based trusted-light sleep executable so transient host CPU pressure cannot turn
  // this semantic fixture into an unrelated resource-governance failure during full coverage.
  const idempotentFixtureArgv = process.platform === "win32"
    ? [process.execPath, "-e", "setTimeout(()=>{},250)"]
    : ["/bin/sleep", "1"];
  const idempotentPlan = {
    idempotency_key: idempotencyKey,
    name: "idempotent managed job",
    steps: [{ argv: idempotentFixtureArgv, timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  };
  const idempotentFirst = manager.start(idempotentPlan);
  const idempotentReplay = manager.start(idempotentPlan);
  assert(idempotentReplay.job_id === idempotentFirst.job_id && idempotentReplay.idempotency_replay === true,
    "replayed idempotent start_job created a second managed job instead of returning the durable original");
  expectThrow(() => manager.start({
    ...idempotentPlan,
    name: "conflicting idempotent managed job",
  }), "idempotency key is already bound to a different managed-job plan");
  const idempotentStatusText = await readFile(join(jobRoot, idempotentFirst.job_id, "status.json"), "utf8");
  assert(!idempotentStatusText.includes(idempotencyKey), "managed-job status persisted the raw client idempotency key");
  const idempotentResult = await waitForJob(manager, idempotentFirst.job_id);
  assert(idempotentResult.status === "succeeded",
    `idempotent managed-job fixture did not finish successfully: ${await managedJobFixtureDiagnostics(idempotentFirst.job_id, idempotentResult, jobRoot)}`);

  const resultFirstReplayKey = "managed-job-result-first-replay-001";
  const duplicateMarker = join(workspace, "idempotent-result-first-duplicate.txt");
  const resultFirstPlanArgs = {
    name: "result-first idempotent replay",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'duplicate')", duplicateMarker] }],
  };
  const resultFirstStage = manager.stage(resultFirstPlanArgs);
  const resultFirstStageDir = join(jobRoot, resultFirstStage.job_id);
  const resultFirstPlanText = await readFile(join(resultFirstStageDir, "plan.json"), "utf8");
  const resultFirstStatus = JSON.parse(await readFile(join(resultFirstStageDir, "status.json"), "utf8"));
  const resultFirstDigest = createHash("sha256")
    .update("machine-bridge-managed-job-idempotency-v1\0").update("local").update("\0").update(resultFirstReplayKey).digest("hex");
  const resultFirstJobId = `job_${resultFirstDigest}`;
  const resultFirstDir = join(jobRoot, resultFirstJobId);
  await mkdir(resultFirstDir, { recursive: true, mode: 0o700 });
  const resultFirstAt = new Date().toISOString();
  await writeFile(join(resultFirstDir, "plan.json"), resultFirstPlanText, { mode: 0o600 });
  await writeFile(join(resultFirstDir, "status.json"), `${JSON.stringify({
    ...resultFirstStatus, job_id: resultFirstJobId, status: "queued", approval: "mcp", runner_pid: null,
    cleanup_guarantee: "best-effort-finally-and-recovery", updated_at: resultFirstAt,
  })}\n`, { mode: 0o600 });
  await writeFile(join(resultFirstDir, "result.json"), `${JSON.stringify({
    job_id: resultFirstJobId, name: resultFirstPlanArgs.name, status: "succeeded",
    steps: [], finally_steps: [], error_class: null, cleanup_error_class: null, finished_at: resultFirstAt,
  })}\n`, { mode: 0o600 });
  await rm(resultFirstStageDir, { recursive: true, force: true });
  const resultFirstReplay = manager.start({ ...resultFirstPlanArgs, idempotency_key: resultFirstReplayKey });
  assert(resultFirstReplay.job_id === resultFirstJobId && resultFirstReplay.status === "succeeded" && resultFirstReplay.idempotency_replay === true,
    "idempotent replay relaunched a queued job instead of reconciling its durable terminal result first");
  await delay(200);
  assert(!(await exists(duplicateMarker)) && !(await exists(join(resultFirstDir, "plan.json"))) && !(await exists(join(resultFirstDir, "runner.pid"))),
    "result-first idempotent replay executed business work or retained active execution metadata");

  const script = [
    "const fs=require('node:fs');",
    "const chunks=[];",
    "process.stdin.on('data',c=>chunks.push(c));",
    "process.stdin.on('end',()=>{",
    " const p=process.argv[1];",
    " const file=fs.readFileSync(p);",
    " const stdin=Buffer.concat(chunks);",
    " const alt=v=>process.platform==='win32'?v.replaceAll('\\\\','/'):v.replaceAll('/','\\\\');",
    " process.stdout.write(file.toString()+process.env.MBM_JOB_SECRET+'\\n'+stdin.toString()+file.toString('base64')+'\\n'+file.toString('base64url')+'\\n'+file.toString('hex')+'\\n'+p+'\\n'+alt(p)+'\\n'+process.env.MBM_SOURCE_PATH+'\\n'+alt(process.env.MBM_SOURCE_PATH)+'\\n');",
    " process.exit(7);",
    "});",
  ].join("");
  const cleanupScript = "const fs=require('node:fs'); fs.rmSync(process.argv[1],{force:true}); fs.writeFileSync(process.argv[2],'cleaned');";
  const finallyFixtureStep = process.platform === "win32"
    ? {
        name: "remove temporary helper",
        argv: [process.execPath, "-e", cleanupScript, helperFile, cleanupMarker],
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      }
    : {
        // The fixture is proving finally-step execution/redaction, not resource admission. Use an
        // identity-based trusted-light executable so transient host pressure cannot manufacture
        // an unrelated cleanup_error while the job-runtime cleanup assertion below remains live.
        name: "prove finally execution",
        argv: ["/bin/echo", "finally-step-ran"],
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      };

  const accepted = manager.start({
    name: "resource redaction and finally cleanup",
    temporary_files: [{ name: "helper.js", content: "process.stdout.write('temporary-helper-ok')" }],
    steps: [{
      name: "run job-scoped helper",
      argv: [process.execPath, "{{temp:helper.js}}"],
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }, {
      name: "consume local resource",
      argv: [process.execPath, "-e", script, "{{resource:test-secret}}"],
      env: { MBM_SOURCE_PATH: sourcePathAlias },
      env_resources: { MBM_JOB_SECRET: "test-secret" },
      stdin_resource: "test-secret",
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
    finally_steps: [finallyFixtureStep],
  });
  assert(accepted.detached && accepted.continues_without_mcp_connection, "managed job was not accepted as detached");
  const failed = await waitForJob(manager, accepted.job_id);
  assert(failed.status === "failed",
    `expected failed job: ${await managedJobFixtureDiagnostics(accepted.job_id, failed, jobRoot)}`);
  if (process.platform === "win32") {
    assert(!(await exists(helperFile)) && await exists(cleanupMarker), "finally step did not clean the temporary helper");
  } else {
    assert(failed.result?.finally_steps?.[0]?.stdout?.includes("finally-step-ran"), "trusted-light finally fixture did not execute");
  }
  const serialized = JSON.stringify(failed);
  assert(!serialized.includes(secret), "job result exposed raw resource content");
  assert(!serialized.includes(Buffer.from(`${secret}\n`).toString("base64")), "job result exposed base64 resource content");
  assert(!serialized.includes(Buffer.from(`${secret}\n`).toString("base64url")), "job result exposed base64url resource content");
  assert(!serialized.includes(Buffer.from(`${secret}\n`).toString("hex")), "job result exposed hex resource content");
  assert(!serialized.includes(secretFile) && !serialized.includes(sourcePathAlias), "job result exposed a registered resource path alias");
  const expectedRedactionMarkers = ["redacted-resource:test-secret", "resource:test-secret", "resource-source:test-secret"];
  const missingRedactionMarkers = expectedRedactionMarkers.filter((marker) => !serialized.includes(marker));
  assert(missingRedactionMarkers.length === 0, `job result did not mark redacted values and paths: ${missingRedactionMarkers.join(", ")}`);
  assert(serialized.includes("temporary-helper-ok"), "job-scoped temporary helper did not run");
  assert(!(await exists(join(jobRoot, accepted.job_id, "runtime"))), "job runtime resource copies and temporary files were not removed");
  assert(!(await exists(join(jobRoot, accepted.job_id, "plan.json"))), "finished job retained scripts, stdin, argv, or resource source paths in plan.json");

  const boundarySecret = `managed-boundary-${"q".repeat(32)}`;
  const boundarySecretFile = join(root, "boundary-secret.txt");
  await writeFile(boundarySecretFile, boundarySecret, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(boundarySecretFile, 0o600);
  const boundaryManager = createManagedJobTestManager({
    jobRoot: join(root, "boundary-jobs"),
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { boundary: inspectResourceFile(boundarySecretFile) },
  });
  const boundaryPrefixLength = 12;
  const boundaryScript = (stream) => [
    `const stream=process.${stream};`,
    `stream.write('x'.repeat(${64 * 1024 - boundaryPrefixLength}));`,
    "stream.write(process.env.MBM_BOUNDARY_SECRET);",
  ].join("");
  for (const stream of ["stdout", "stderr"]) {
    const boundaryJob = boundaryManager.start({
      name: `${stream} resource truncation redaction`,
      steps: [{
        argv: [process.execPath, "-e", boundaryScript(stream)],
        env_resources: { MBM_BOUNDARY_SECRET: "boundary" },
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      }],
    });
    const boundaryResult = await waitForJob(boundaryManager, boundaryJob.job_id);
    const boundaryStep = boundaryResult.result.steps[0];
    const captured = String(boundaryStep[stream] || "");
    assert(boundaryStep[`${stream}_truncated_bytes`] > 0, `${stream} truncation fixture did not cross the capture boundary`);
    assert(!captured.includes(boundarySecret.slice(0, boundaryPrefixLength)), `${stream} exposed a resource prefix across the capture boundary`);
  }

  const aggregateBoundary = boundaryManager.start({
    name: "aggregate resource truncation redaction",
    steps: [
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `fill-${index}`,
        argv: [process.execPath, "-e", `process.stdout.write('a'.repeat(${64 * 1024}))`],
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      })),
      {
        name: "cross aggregate capture boundary",
        argv: [process.execPath, "-e", boundaryScript("stdout")],
        env_resources: { MBM_BOUNDARY_SECRET: "boundary" },
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      },
    ],
  });
  const aggregateBoundaryResult = await waitForJob(boundaryManager, aggregateBoundary.job_id, null, MANAGED_JOB_MULTI_STEP_WAIT_MS);
  const aggregateBoundaryStep = aggregateBoundaryResult.result.steps[3];
  assert(aggregateBoundaryResult.result.capture_remaining_bytes === 0 && aggregateBoundaryStep.stdout_truncated_bytes > 0,
    "aggregate truncation fixture did not exhaust the shared capture budget at the resource boundary");
  assert(!aggregateBoundaryStep.stdout.includes(boundarySecret.slice(0, boundaryPrefixLength)),
    "aggregate capture boundary exposed a resource prefix before redaction");

  const changingResource = join(root, "changing-resource.txt");
  await writeFile(changingResource, "first-value", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(changingResource, 0o600);
  const changingManager = createManagedJobTestManager({
    jobRoot: join(root, "changing-jobs"),
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { changing: inspectResourceFile(changingResource) },
  });
  const resourceGate = await pendingDependencyFixture(changingManager, "resource replacement preparation gate");
  const changingJob = changingManager.start({
    name: "resource replacement fails closed",
    depends_on: [resourceGate.job_id],
    steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},250)"], stdin_resource: "changing", timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  // The runner must not copy the original input before the replacement completes.
  try {
    await writeFile(changingResource, "second-value", { mode: 0o600 });
  } finally {
    await settleDependencyFixture(changingManager, resourceGate.job_id, "succeeded");
  }
  const changed = await waitForJob(changingManager, changingJob.job_id);
  assert(changed.status === "failed" && changed.result?.error_class === "resource_error"
    && changed.result.steps.length === 0, "resource change before preparation did not fail closed before step execution");

  const outputBudget = manager.start({
    name: "bounded aggregate output",
    steps: Array.from({ length: 4 }, (_, index) => ({
      name: `output-${index}`,
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000));"],
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      allow_failure: true,
    })),
  });
  const bounded = await waitForJob(manager, outputBudget.job_id, null, MANAGED_JOB_MULTI_STEP_WAIT_MS);
  assert(bounded.status === "succeeded", `bounded output job ended as ${bounded.status}`);
  const resultText = JSON.stringify(bounded.result);
  assert(Buffer.byteLength(resultText) < 2 * 1024 * 1024, "managed job result exceeded a safe transport bound");
  assert(bounded.result.capture_limit_bytes === 256 * 1024 && bounded.result.capture_remaining_bytes === 0, "aggregate capture budget was not enforced");

  const discarded = manager.start({
    name: "discard output",
    steps: [{
      argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_DISCARD_SECRET)"],
      env_resources: { MBM_DISCARD_SECRET: "test-secret" },
      capture_output: "discard",
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
  });
  const discardedResult = await waitForJob(manager, discarded.job_id);
  const discardedStep = discardedResult.result.steps[0];
  assert(discardedStep.output_discarded === true && discardedStep.stdout === "" && discardedStep.stderr === "", "discard output mode retained output");
  assert(Number.isFinite(discardedStep.resource_admission_ms) && discardedStep.resource_admission_ms >= 0
    && discardedStep.resource_admission_ms <= discardedStep.duration_ms,
  "managed job result omitted or invalidated owner resource admission timing");

  const delegatedTimingContext = { authority: { owner: false, principal: {
    kind: "account", accountId: `acct_${"t".repeat(32)}`, accountVersion: 1,
    clientId: `mcp_client_${"t".repeat(43)}`, familyId: `mcp_family_${"t".repeat(43)}`, role: "operator",
  } } };
  const delegatedTiming = manager.createJob({
    name: "delegated timing projection",
    steps: [{ argv: [process.execPath, "-e", "process.stdout.write('ok')"], timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  }, { launch: true, executionPriority: "interactive" }, delegatedTimingContext);
  const delegatedTimingRead = await waitForJob(manager, delegatedTiming.job_id, null, MANAGED_JOB_TEST_WAIT_MS, delegatedTimingContext);
  assert(!Object.hasOwn(delegatedTimingRead.result.steps[0], "resource_admission_ms"),
    "delegated managed-job read exposed machine-user resource admission timing");
  const ownerTimingRead = manager.read({ job_id: delegatedTiming.job_id });
  assert(Number.isFinite(ownerTimingRead.result.steps[0].resource_admission_ms),
    "owner managed-job read lost resource admission timing needed for queue diagnosis");

  const processStateObservable = process.platform === "win32" || processState(process.pid) === "running";
  if (processStateObservable) {
    const descendantPidFile = join(workspace, "managed-descendant.pid");
    const treeOrderFile = join(workspace, "managed-tree-order.txt");
    const treeJobRoot = join(root, "tree-timeout-jobs");
    const treeManager = createManagedJobTestManager({
      jobRoot: treeJobRoot,
      workspace,
      policy: { allowWrite: true, execMode: "direct", minimalEnv: false, unrestrictedPaths: true },
      resources: {},
      recover: false,
      // This fixture measures real process-tree timeout/escalation, not nested V8 instrumentation latency.
      runnerSpawnProcess: spawnManagedJobTestRunnerWithoutCoverage,
    });
    const treeTimeout = treeManager.start({
      name: "timeout terminates descendants",
      steps: [{
        argv: [process.execPath, "-e", `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{},1000);`, descendantPidFile],
        timeout_seconds: MANAGED_JOB_TREE_TIMEOUT_SECONDS,
      }],
      finally_steps: [{
        argv: [process.execPath, "-e", "const { readFileSync, writeFileSync } = require('node:fs'); const pid = Number(readFileSync(process.argv[1],'utf8')); let alive = false; try { process.kill(pid,0); alive = true; } catch {} writeFileSync(process.argv[2], alive ? 'alive' : 'dead');", descendantPidFile, treeOrderFile],
        timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
      }],
    });
    await waitForRunning(treeManager, treeTimeout.job_id);
    const treeRunnerClaim = JSON.parse(await readFile(join(treeJobRoot, treeTimeout.job_id, "runner.pid"), "utf8"));
    const treeRunnerPid = Number(treeRunnerClaim.pid);
    assert(Number.isInteger(treeRunnerPid) && treeRunnerPid > 0, "managed job private runner claim omitted the runner pid");
    assert(typeof treeRunnerClaim.processStartedAt === "string" && !("launchToken" in treeRunnerClaim),
      "runner did not atomically upgrade its provisional claim to an exact token-free identity");
    const descendantPid = Number(await waitForManagedJobFixtureFileText(treeManager, treeTimeout.job_id, descendantPidFile, MANAGED_JOB_TREE_READY_MS));
    assert(Number.isInteger(descendantPid) && descendantPid > 0, "managed job process-tree fixture published an invalid descendant pid");
    const treeTimeoutResult = await waitForJob(treeManager, treeTimeout.job_id, null, MANAGED_JOB_TEST_WAIT_MS);
    assert(treeTimeoutResult.result.steps[0].timed_out === true, "managed job process-tree fixture did not time out");
    await waitForPidExit(descendantPid, MANAGED_JOB_TEST_WAIT_MS);
    await waitForPidExit(treeRunnerPid, MANAGED_JOB_TEST_WAIT_MS);
    const treeOrder = (await readFile(treeOrderFile, "utf8")).trim();
    assert(treeOrder === "dead",
      `managed job cleanup began before timed-out descendants settled: ${treeOrder}`);
  }

  const cancellable = manager.start({
    name: "cancel with cleanup",
    steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"], timeout_seconds: 60 }],
    finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cancel-cleaned')", cancelMarker], timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  await waitForRunning(manager, cancellable.job_id);
  const cancellation = manager.cancel({ job_id: cancellable.job_id });
  assert(cancellation.cancellation_requested && cancellation.cleanup_will_run, "cancellation was not accepted");
  const cancelled = await waitForJob(manager, cancellable.job_id);
  assert(cancelled.status === "cancelled", `expected cancelled job, got ${cancelled.status}`);
  assert(await exists(cancelMarker), "cancelled job did not execute finally cleanup");

  const recoverable = manager.start({
    name: "recover interrupted cleanup",
    steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"], timeout_seconds: 60 }],
    finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],'x')", recoveryMarker], timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  await waitForRunning(manager, recoverable.job_id);
  const recoverableDir = join(jobRoot, recoverable.job_id);
  const runnerClaimText = (await readFile(join(recoverableDir, "runner.pid"), "utf8")).trim();
  const runnerClaim = runnerClaimText.startsWith("{") ? JSON.parse(runnerClaimText) : { pid: Number(runnerClaimText) };
  const runnerPid = Number(runnerClaim.pid);
  if (!Number.isInteger(runnerPid) || runnerPid <= 0 || typeof runnerClaim.processStartedAt !== "string") {
    throw new Error("managed job did not persist its runner process identity");
  }
  try { process.kill(runnerPid, "SIGKILL"); } catch {}
  await waitForPidExit(runnerPid, 10_000);
  const statusFile = join(recoverableDir, "status.json");
  const stale = JSON.parse(await readFile(statusFile, "utf8"));
  Object.assign(stale, {
    status: "running",
    runner_pid: runnerPid,
    runner_process_started_at: runnerClaim.processStartedAt,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: null,
  });
  await writeFile(statusFile, `${JSON.stringify(stale, null, 2)}
`, { mode: 0o600 });
  const staleRecoveryLock = join(recoverableDir, "recovery.lock");
  await writeFile(staleRecoveryLock, `${JSON.stringify({
    pid: process.pid,
    token: "e".repeat(32),
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs() - 60_000).toISOString(),
  })}
`, { mode: 0o600 });
  const oldRecoveryTime = new Date(Date.now() - 10 * 60_000);
  await utimes(staleRecoveryLock, oldRecoveryTime, oldRecoveryTime);
  const recoveryManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "test-secret": resource },
    recover: false,
  });
  const concurrentRecoveryManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "test-secret": resource },
    recover: false,
  });
  const coordinatorRoot = join(root, "resource-coordinator");
  await mkdir(coordinatorRoot, { recursive: true, mode: 0o700 });
  let releaseCoordinatorLock = null;
  let coordinatorLockReadyResolve = null;
  const coordinatorLockReady = new Promise((resolvePromise) => { coordinatorLockReadyResolve = resolvePromise; });
  const coordinatorLockTask = withFixtureResourceTransactionLock(coordinatorRoot, async () => {
    coordinatorLockReadyResolve();
    await new Promise((resolvePromise) => { releaseCoordinatorLock = resolvePromise; });
  }, 30_000);
  let coordinatorLockFailure = null;
  void coordinatorLockTask.catch((error) => {
    coordinatorLockFailure = error;
    coordinatorLockReadyResolve();
  });
  await coordinatorLockReady;
  if (coordinatorLockFailure) {
    throw new Error("managed-job recovery fixture could not acquire the held resource transaction lock", { cause: coordinatorLockFailure });
  }
  const coordinatorReleaseTimer = setTimeout(() => releaseCoordinatorLock?.(), RECOVERY_RESOURCE_LOCK_HOLD_MS);
  let recovered;
  try {
    recovered = await waitForJob(recoveryManager, recoverable.job_id, new Set(["recovered", "recovery_failed"]));
  } finally {
    clearTimeout(coordinatorReleaseTimer);
    releaseCoordinatorLock?.();
    await coordinatorLockTask;
  }
  if (recovered.status !== "recovered") {
    let runnerStderr = "";
    try { runnerStderr = (await readFile(join(recoverableDir, "runner.err.log"), "utf8")).slice(-2048); } catch {}
    const coordinator = { transaction_owner: "", leases: [], waiters: [] };
    try { coordinator.transaction_owner = (await readFile(join(coordinatorRoot, "transaction.lock"), "utf8")).trim(); }
    catch (error) { coordinator.transaction_owner = `unavailable:${error?.code || "unknown"}`; }
    try { coordinator.leases = await readdir(join(coordinatorRoot, "leases")); } catch {}
    try { coordinator.waiters = await readdir(join(coordinatorRoot, "waiters")); } catch {}
    throw new Error(`expected recovered cleanup, got ${recovered.status}; result=${JSON.stringify(recovered.result || null)}; runner_stderr=${runnerStderr}; coordinator=${JSON.stringify(coordinator)}`);
  }
  assert(recovered.recovery_attempts === 1 && recovered.recovery_history?.length === 1
    && recovered.recovery_history[0].reason === "runner_interrupted"
    && Number.isFinite(Date.parse(recovered.recovery_history[0].at)),
  "interrupted managed-job recovery lost bounded reason/time attribution");
  assert(await readFile(recoveryMarker, "utf8") === "x", "concurrent recovery launched duplicate finally execution");
  assert(concurrentRecoveryManager.read({ job_id: recoverable.job_id }).status === "recovered", "concurrent manager did not observe recovered terminal state");
  assert(!(await exists(join(recoverableDir, "plan.json"))), "recovered job retained its execution plan");

  const changedResourceFile = join(root, "recovery-changed-resource.txt");
  const changedResourceReadyFile = join(root, "recovery-changed-resource-ready.txt");
  const changedResourceCleanupFile = join(root, "recovery-changed-resource-cleanup.txt");
  const changedResourceCoordinatorRoot = join(root, "resource-coordinator-recovery-changed");
  const changedResourceRunnerSpawn = managedJobTestRunnerForCoordinatorRoot(changedResourceCoordinatorRoot);
  await writeFile(changedResourceFile, "recovery-secret-v1", { mode: 0o600 });
  const changedResource = inspectResourceFile(changedResourceFile);
  const changedResourceManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "recovery-secret": changedResource },
    runnerSpawnProcess: changedResourceRunnerSpawn,
  });
  const changedResourceJob = changedResourceManager.start({
    name: "recover after resource replacement",
    steps: [{
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setTimeout(()=>{},30000)", changedResourceReadyFile],
      env_resources: { MBM_RECOVERY_SECRET: "recovery-secret" },
      timeout_seconds: 60,
      capture_output: "discard",
    }],
    finally_steps: [{
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cleaned')", changedResourceCleanupFile],
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
  });
  await waitForRunning(changedResourceManager, changedResourceJob.job_id);
  const changedResourceChildPid = Number(await waitForManagedJobFixtureFileText(changedResourceManager, changedResourceJob.job_id, changedResourceReadyFile, MANAGED_JOB_TREE_READY_MS));
  assert(Number.isInteger(changedResourceChildPid) && changedResourceChildPid > 0,
    "resource-recovery fixture did not prove the original resource was materialized before interruption");
  const changedResourceDir = join(jobRoot, changedResourceJob.job_id);
  const changedRunnerClaim = JSON.parse(await readFile(join(changedResourceDir, "runner.pid"), "utf8"));
  const changedRunnerPid = Number(changedRunnerClaim.pid);
  assert(Number.isInteger(changedRunnerPid) && changedRunnerPid > 0 && typeof changedRunnerClaim.processStartedAt === "string",
    "resource-recovery fixture omitted the runner identity");
  try { process.kill(changedRunnerPid, "SIGKILL"); } catch {}
  await waitForPidExit(changedRunnerPid, 10_000);
  try { process.kill(changedResourceChildPid, "SIGKILL"); } catch {}
  await waitForPidExit(changedResourceChildPid, 10_000);
  const changedStatusFile = join(changedResourceDir, "status.json");
  const changedStaleStatus = JSON.parse(await readFile(changedStatusFile, "utf8"));
  Object.assign(changedStaleStatus, {
    status: "running",
    runner_pid: changedRunnerPid,
    runner_process_started_at: changedRunnerClaim.processStartedAt,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: null,
  });
  await writeFile(changedStatusFile, `${JSON.stringify(changedStaleStatus, null, 2)}\n`, { mode: 0o600 });
  await writeFile(changedResourceFile, "recovery-secret-v2", { mode: 0o600 });
  const changedRecoveryManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "recovery-secret": inspectResourceFile(changedResourceFile) },
    runnerSpawnProcess: changedResourceRunnerSpawn,
  });
  const changedRecovery = await waitForJob(
    changedRecoveryManager,
    changedResourceJob.job_id,
    new Set(["recovery_failed"]),
  );
  assert(changedRecovery.status === "recovery_failed" && !Object.hasOwn(changedRecovery.result || {}, "recovered"),
    `resource reconstruction failure was misreported after recovery: ${changedRecovery.status}`);
  assert(changedRecovery.result?.error_class && changedRecovery.result.cleanup_error_class === null,
    "resource reconstruction failure lost its main-error evidence or invented a cleanup failure");
  assert(await readFile(changedResourceCleanupFile, "utf8") === "cleaned",
    "resource reconstruction failure skipped an independent finally step");
  assert(!(await exists(join(changedResourceDir, "plan.json"))),
    "resource reconstruction failure retained executable plan state after terminal recovery");

  const exhaustedId = "job_recoveryexhaustedabcdefghijkl";
  const exhaustedDir = join(jobRoot, exhaustedId);
  await mkdir(exhaustedDir, { recursive: true, mode: 0o700 });
  await writeFile(join(exhaustedDir, "plan.json"), `${JSON.stringify({
    version: 1,
    name: "recovery exhausted",
    workspace,
    full_env: false,
    resources: {},
    temporary_files: [],
    steps: [{ name: "noop", argv: [process.execPath, "-e", ""], cwd: workspace, env: {}, env_resources: {}, stdin: null, stdin_resource: null, timeout_seconds: 10, allow_failure: false, capture_output: "redacted" }],
    finally_steps: [],
  })}
`, { mode: 0o600 });
  await writeFile(join(exhaustedDir, "status.json"), `${JSON.stringify({
    job_id: exhaustedId,
    name: "recovery exhausted",
    status: "interrupted",
    recovery_attempts: 3,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date(Date.now() - 120_000).toISOString(),
    runner_pid: 99999999,
  })}
`, { mode: 0o600 });
  const exhaustedManager = createManagedJobTestManager({ jobRoot, workspace, policy: { allowWrite: true, execMode: "direct", minimalEnv: true }, resources: {} });
  const exhausted = exhaustedManager.read({ job_id: exhaustedId });
  assert(exhausted.status === "recovery_exhausted" && exhausted.recovery_attempts === 3
    && exhausted.recovery_history_complete === false,
  "recovery limit did not preserve prior-version attribution incompleteness");
  assert(exhausted.result_persisted === true && exhausted.artifact_cleanup_pending === false && exhausted.result?.status === "recovery_exhausted",
    "recovery exhaustion bypassed the crash-consistent terminal evidence contract");
  assert(exhausted.error_class === "recovery_exhausted" && exhausted.cleanup_error_class === null
    && exhausted.result?.cleanup_error_class === null,
  "recovery exhaustion was misattributed as a cleanup failure");
  assert(!(await exists(join(exhaustedDir, "plan.json"))) && !(await exists(join(exhaustedDir, "runner.pid"))), "recovery exhaustion retained active metadata");

  const foreignClaimId = `job_${"U".repeat(24)}`;
  const foreignClaimDir = join(jobRoot, foreignClaimId);
  await mkdir(foreignClaimDir, { recursive: true, mode: 0o700 });
  await writeFile(join(foreignClaimDir, "plan.json"), "must-remain-after-foreign-claim\n", { mode: 0o600 });
  const foreignClaimStatus = {
    job_id: foreignClaimId, name: "foreign runner claim", status: "queued", approval: "mcp",
    plan_sha256: "0".repeat(64), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await writeFile(join(foreignClaimDir, "status.json"), `${JSON.stringify(foreignClaimStatus)}\n`, { mode: 0o600 });
  const foreignClaimRunner = spawn(process.execPath, [runnerEntry, "--job-dir", foreignClaimDir], {
    stdio: "ignore", windowsHide: true, env: { ...process.env, MBM_RUNNER_LAUNCH_TOKEN: "b".repeat(32) },
  });
  const { code: foreignClaimExit } = await runFixtureChild(foreignClaimRunner, {
    label: "foreign claim",
    prepare: () => publishProvisionalRunnerClaim(foreignClaimDir, process.pid, "a".repeat(32)),
  });
  const foreignClaimAfter = JSON.parse(await readFile(join(foreignClaimDir, "status.json"), "utf8"));
  assert(foreignClaimExit !== 0 && foreignClaimAfter.status === "queued"
    && await exists(join(foreignClaimDir, "plan.json")) && await exists(join(foreignClaimDir, "runner.pid")),
  "runner without the published claim overwrote job state or scrubbed recovery evidence");

  const corruptFatalId = `job_${"V".repeat(24)}`;
  const corruptFatalDir = join(jobRoot, corruptFatalId);
  await mkdir(corruptFatalDir, { recursive: true, mode: 0o700 });
  await writeFile(join(corruptFatalDir, "plan.json"), "must-remain-after-fatal-state-corruption\n", { mode: 0o600 });
  const corruptFatalStatus = {
    job_id: corruptFatalId, name: "fatal state corruption", status: "interrupted", approval: "mcp",
    plan_sha256: "0".repeat(64), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    recovery_attempts: 1,
  };
  await writeFile(join(corruptFatalDir, "status.json"), `${JSON.stringify(corruptFatalStatus)}\n`, { mode: 0o600 });
  const corruptFatalLaunchToken = "c".repeat(32);
  const corruptFatalRunner = spawn(process.execPath, [runnerEntry, "--job-dir", corruptFatalDir, "--recover"], {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, MBM_RUNNER_LAUNCH_TOKEN: corruptFatalLaunchToken, MBM_RECOVERY_LOCK_TOKEN: "d".repeat(32) },
  });
  const { code: corruptFatalExit } = await runFixtureChild(corruptFatalRunner, {
    label: "fatal state corruption",
    prepare: async () => {
      publishProvisionalRunnerClaim(corruptFatalDir, corruptFatalRunner.pid, corruptFatalLaunchToken);
      await waitForConfirmedRunnerClaim(join(corruptFatalDir, "runner.pid"), corruptFatalRunner.pid);
      await writeFile(join(corruptFatalDir, "status.json"), "{not-json\n", { mode: 0o600 });
      // Release the recovery handshake only after corrupt state is installed.
      const recoveryOwnerStartedAtMs = processStartTimeMs(corruptFatalRunner.pid);
      await writeFile(join(corruptFatalDir, "recovery.lock"), JSON.stringify({
        pid: corruptFatalRunner.pid, token: "d".repeat(32),
        startedAt: new Date().toISOString(),
        processStartedAt: Number.isFinite(recoveryOwnerStartedAtMs) && recoveryOwnerStartedAtMs > 0
          ? new Date(recoveryOwnerStartedAtMs).toISOString() : null,
      }) + "\n", { mode: 0o600 });
    },
  });
  assert(corruptFatalExit !== 0 && (await readFile(join(corruptFatalDir, "status.json"), "utf8")) === "{not-json\n"
    && !(await exists(join(corruptFatalDir, "recovery.lock")))
    && await exists(join(corruptFatalDir, "plan.json")) && await exists(join(corruptFatalDir, "runner.pid")),
  "fatal runner replaced unreadable job state or scrubbed evidence after confirming its claim");

  const corruptDir = join(jobRoot, "job_abcdefghijklmnopqrstuvwxyz123456");
  await mkdir(corruptDir, { recursive: true, mode: 0o700 });
  await writeFile(join(corruptDir, "plan.json"), "{not-json", { mode: 0o600 });
  await writeFile(join(corruptDir, "status.json"), `${JSON.stringify({
    job_id: "job_abcdefghijklmnopqrstuvwxyz123456",
    name: "corrupt plan",
    status: "queued",
    approval: "mcp",
    plan_sha256: "0".repeat(64),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })}
`, { mode: 0o600 });
  const corruptRunner = spawn(process.execPath, [runnerEntry, "--job-dir", corruptDir], { stdio: "ignore", windowsHide: true });
  await runFixtureChild(corruptRunner, { label: "corrupt plan" });
  const corruptStatus = JSON.parse(await readFile(join(corruptDir, "status.json"), "utf8"));
  assert(corruptStatus.status === "runner_failed", `corrupt plan did not become runner_failed: ${corruptStatus.status}`);
  assert(!(await exists(join(corruptDir, "plan.json"))) && !(await exists(join(corruptDir, "runner.pid"))), "fatal runner retained active execution metadata");
  if (process.platform !== "win32") {
    const insecure = join(root, "insecure-resource.txt");
    await writeFile(insecure, "not-secret", { mode: 0o644 });
    await chmod(insecure, 0o644);
    expectThrow(() => inspectResourceFile(insecure), "readable by group or others");
    const allowed = inspectResourceFile(insecure, { allowInsecurePermissions: true });
    assert(allowed.allowInsecurePermissions === true, "explicit insecure-permission override was not retained");
  }

  const rootMode = (await stat(jobRoot)).mode & 0o777;
  if (process.platform !== "win32") assert(rootMode === 0o700, `job root mode is ${rootMode.toString(8)}, expected 700`);
  console.log("managed jobs/resources integration test ok");
  } finally {
    if (previousCoordinatorRoot === undefined) delete process.env.AGENT_RESOURCE_COORDINATOR_ROOT;
    else process.env.AGENT_RESOURCE_COORDINATOR_ROOT = previousCoordinatorRoot;
    if (previousBuildRoot === undefined) delete process.env.AGENT_BUILD_ROOT;
    else process.env.AGENT_BUILD_ROOT = previousBuildRoot;
    if (!context.root) {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}
