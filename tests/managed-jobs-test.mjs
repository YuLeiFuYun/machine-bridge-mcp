import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeManagedJobs, inspectResourceFile, launchRunner, ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { hostedManagedJobListStatus, hostedManagedJobStatus } from "../src/local/managed-job-hosted-status.mjs";
import { readJson as readManagedJobJson, resourceErrorClass } from "../src/local/managed-job-storage.mjs";
import { normalizeResourceRegistry } from "../src/local/managed-job-plan.mjs";
import { managedRunnerEnvironment, runnerProcessIsCurrent } from "../src/local/managed-job-runner.mjs";
import { confirmRunnerClaim, publishProvisionalRunnerClaim } from "../src/local/managed-job-runner-claim.mjs";
import { managedJobFinalStatus, persistManagedJobTerminal } from "../src/local/managed-job-terminal.mjs";
import { acquireJobCapacityLock, acquireJobTransitionLock } from "../src/local/managed-job-lock.mjs";
import { withResourceTransactionLock } from "../src/local/resource-transaction-lock.mjs";
import { EXECUTION_SURFACE } from "../src/local/execution-surface.mjs";

const MANAGED_JOB_TEST_WAIT_MS = 480_000;
const MANAGED_JOB_MULTI_STEP_WAIT_MS = 600_000;
const MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS = 120;
const MANAGED_JOB_TREE_TIMEOUT_SECONDS = 15;
const MANAGED_JOB_TREE_READY_MS = 10_000;
const RECOVERY_RESOURCE_LOCK_HOLD_MS = 5_500;

function testManagedStateIdentityRetry() {
  let attempts = 0;
  const recovered = readManagedJobJson("synthetic-status.json", 1024, "job status", {
    readFile() {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("synthetic generation change"), { code: "MBM_IDENTITY_CHANGED" });
      return Buffer.from('{"status":"running"}');
    },
  });
  assert(attempts === 4 && recovered.status === "running",
    "managed job state did not recover from bounded atomic-generation churn");
  let failure = null;
  attempts = 0;
  try {
    readManagedJobJson("synthetic-status.json", 1024, "job status", {
      readFile() {
        attempts += 1;
        throw Object.assign(new Error("synthetic persistent generation churn"), { code: "MBM_IDENTITY_CHANGED" });
      },
    });
  } catch (error) { failure = error; }
  assert(attempts === 4 && String(failure?.message || "").includes("identity_changed")
    && resourceErrorClass(failure) === "identity_changed",
  "managed job state identity retry became unbounded or lost its stable error classification");
  assert(resourceErrorClass(Object.assign(new Error("corrupt terminal state"), { code: "integrity_error" })) === "integrity_error",
    "managed-job diagnostics collapsed an integrity failure into generic resource unavailability");
}

function testHostedManagedJobStatusProjection() {
  const relayContext = { authority: { origin: "relay" } };
  for (const status of ["queued", "running", "cleaning", "interrupted"]) {
    const projected = hostedManagedJobStatus({ status }, relayContext);
    assert(projected.host_turn_handoff_recommended === true && projected.status_polling_mode === "checkpoint",
      `active managed-job state ${status} did not hand the hosted turn back`);
  }
  const terminal = hostedManagedJobStatus({ status: "succeeded" }, relayContext);
  assert(terminal.host_turn_handoff_recommended === false && terminal.status_polling_mode === "checkpoint",
    "terminal managed-job status incorrectly recommended hosted-turn handoff");
  assert(Object.keys(hostedManagedJobStatus({ status: "running" }, {})).length === 0,
    "local managed-job status gained relay-only hosted-turn metadata");
  const activeListing = hostedManagedJobListStatus([{ status: "succeeded" }, { status: "cleaning" }], relayContext);
  assert(activeListing.host_turn_handoff_recommended === true && activeListing.status_polling_mode === "checkpoint",
    "remote list_jobs did not hand back a visible active job");
  const terminalListing = hostedManagedJobListStatus([{ status: "succeeded" }], relayContext);
  assert(terminalListing.host_turn_handoff_recommended === false && terminalListing.status_polling_mode === "checkpoint",
    "terminal-only remote list_jobs incorrectly recommended handoff");
  assert(Object.keys(hostedManagedJobListStatus([{ status: "running" }], {})).length === 0,
    "local list_jobs gained relay-only hosted-turn metadata");
}

async function setRunnerFixtureState(jobRoot, jobId, queued) {
  const statusFile = join(jobRoot, jobId, "status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  status.status = queued ? "queued" : "staged";
  status.approval = queued ? "mcp" : "review-only";
  status.cleanup_guarantee = queued ? "best-effort-finally-and-recovery" : "not-started";
  status.updated_at = new Date().toISOString();
  await writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
}

async function testRunnerClaimBoundary() {
  const processStartedAt = new Date(Date.now() - 1000).toISOString();
  const directDir = join(root, "claim-direct");
  await mkdir(directDir, { recursive: true });
  const directFile = join(directDir, "runner.pid");
  await confirmRunnerClaim({ file: directFile, pid: process.pid, processStartedAt, launchToken: "" });
  const direct = JSON.parse(await readFile(directFile, "utf8"));
  assert(direct.pid === process.pid && direct.processStartedAt === processStartedAt && !("launchToken" in direct),
    "token-free runner claim did not persist exact identity");

  const token = "a".repeat(32);
  const provisionalDir = join(root, "claim-provisional");
  await mkdir(provisionalDir, { recursive: true });
  publishProvisionalRunnerClaim(provisionalDir, process.pid, token);
  publishProvisionalRunnerClaim(provisionalDir, process.pid, token);
  const provisionalFile = join(provisionalDir, "runner.pid");
  const provisional = JSON.parse(await readFile(provisionalFile, "utf8"));
  const originalStartedAt = provisional.startedAt;
  assert(provisional.committed === true, "parent-side runner claim became executable before publication was fully committed");
  await confirmRunnerClaim({ file: provisionalFile, pid: process.pid, processStartedAt, launchToken: token });
  const exact = JSON.parse(await readFile(provisionalFile, "utf8"));
  assert(exact.startedAt === originalStartedAt && exact.processStartedAt === processStartedAt && !("launchToken" in exact),
    "provisional runner claim was not atomically upgraded");

  const delayedDir = join(root, "claim-delayed");
  await mkdir(delayedDir, { recursive: true });
  const delayedFile = join(delayedDir, "runner.pid");
  const delayedToken = "b".repeat(32);
  setTimeout(() => publishProvisionalRunnerClaim(delayedDir, process.pid, delayedToken), 20);
  await confirmRunnerClaim({ file: delayedFile, pid: process.pid, processStartedAt, launchToken: delayedToken });

  const uncommittedDir = join(root, "claim-uncommitted");
  await mkdir(uncommittedDir, { recursive: true });
  const uncommittedFile = join(uncommittedDir, "runner.pid");
  const uncommittedToken = "e".repeat(32);
  const uncommittedClaim = `${JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), launchToken: uncommittedToken, committed: false,
  })}\n`;
  await writeFile(uncommittedFile, uncommittedClaim, { mode: 0o600 });
  await expectReject(confirmRunnerClaim({
    file: uncommittedFile, pid: process.pid, processStartedAt, launchToken: uncommittedToken, waitMs: 25,
  }), "runner ownership claim was not published before startup deadline");
  assert(await readFile(uncommittedFile, "utf8") === uncommittedClaim,
    "runner accepted or rewrote an uncommitted parent-side ownership claim");

  await expectReject(confirmRunnerClaim({ file: join(root, "invalid-token.pid"), pid: process.pid, processStartedAt, launchToken: "invalid" }), "runner launch token is invalid");
  const invalidPublishDir = join(root, "claim-invalid-publish-token");
  await mkdir(invalidPublishDir, { recursive: true });
  expectThrow(() => publishProvisionalRunnerClaim(invalidPublishDir, process.pid, "invalid"), "runner launch token is invalid");
  assert(!(await exists(join(invalidPublishDir, "runner.pid"))), "invalid launch token created a provisional runner claim");

  const reusedPidDir = join(root, "claim-reused-pid");
  await mkdir(reusedPidDir, { recursive: true });
  const reusedPidFile = join(reusedPidDir, "runner.pid");
  const staleToken = "c".repeat(32);
  const freshToken = "d".repeat(32);
  const staleClaim = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), launchToken: staleToken })}\n`;
  await writeFile(reusedPidFile, staleClaim, { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(reusedPidDir, process.pid, freshToken), "owned by another process or launch");
  assert(await readFile(reusedPidFile, "utf8") === staleClaim,
    "PID-reused runner claim accepted a different launch token or mutated the existing owner");

  const conflictDir = join(root, "claim-conflict");
  await mkdir(conflictDir, { recursive: true });
  await writeFile(join(conflictDir, "runner.pid"), `${JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString(), launchToken: token })}\n`, { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(conflictDir, process.pid, token), "owned by another process");
  await expectReject(confirmRunnerClaim({ file: join(conflictDir, "runner.pid"), pid: process.pid, processStartedAt, launchToken: token }), "does not match the spawned process");

  const unreadableDir = join(root, "claim-unreadable");
  await mkdir(unreadableDir, { recursive: true });
  await writeFile(join(unreadableDir, "runner.pid"), "not-json\n", { mode: 0o600 });
  expectThrow(() => publishProvisionalRunnerClaim(unreadableDir, process.pid, token), "already exists but is unreadable");
  await expectReject(confirmRunnerClaim({ file: join(unreadableDir, "runner.pid"), pid: process.pid, processStartedAt, launchToken: token }), "ownership claim is unreadable");

  if (process.platform !== "win32") {
    const hardClaimDir = join(root, "runner-owner-hardlink");
    const hardClaimFile = join(hardClaimDir, "runner.pid");
    const hardClaimAlias = join(hardClaimDir, "runner.pid.alias");
    await mkdir(hardClaimDir, { recursive: true });
    await writeFile(hardClaimFile, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), launchToken: token })}
`, { mode: 0o600 });
    await link(hardClaimFile, hardClaimAlias);
    let hardClaimFailure = null;
    try { publishProvisionalRunnerClaim(hardClaimDir, process.pid, token); } catch (error) { hardClaimFailure = error; }
    assert(hardClaimFailure?.cause?.code === "MBM_MULTIPLE_HARD_LINKS"
      && await readFile(hardClaimFile, "utf8") === await readFile(hardClaimAlias, "utf8"),
    "managed-job runner claim accepted or modified multiply-linked ownership evidence");
  }

  const oversizedRunnerDir = join(root, "runner-owner-oversized");
  await mkdir(oversizedRunnerDir, { recursive: true });
  await writeFile(join(oversizedRunnerDir, "runner.pid"), "x".repeat(1025), { mode: 0o600 });
  expectThrow(
    () => runnerProcessIsCurrent({ runner_pid: 2_147_483_647, runner_process_started_at: processStartedAt }, oversizedRunnerDir),
    "file exceeds 1024 bytes",
  );
  expectThrow(() => runnerProcessIsCurrent({ runner_pid: process.pid, runner_process_started_at: processStartedAt }, unreadableDir),
    "runner claim is invalid");
}

async function testRecoveryClaimFailurePreservesRetryState() {
  const jobId = `job_${"H".repeat(24)}`;
  const dir = join(root, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const plan = { name: "recovery claim handshake failure", steps: [], finally_steps: [], resources: {}, temporary_files: [], full_env: false };
  const now = new Date().toISOString();
  const status = {
    job_id: jobId, name: plan.name, status: "interrupted", approval: "mcp",
    plan_sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    created_at: now, updated_at: now, finished_at: now, recovery_attempts: 1,
    owner_kind: "local", owner_account_id: null, owner_account_version: null, owner_client_id: null, owner_family_id: null,
  };
  await writeFile(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await mkdir(join(dir, "recovery.lock"), { mode: 0o700 });
  const recoveryToken = "e".repeat(32);
  const launchToken = "f".repeat(32);
  const child = spawn(process.execPath, [runnerEntry, "--job-dir", dir, "--recover"], {
    env: { ...process.env, MBM_RECOVERY_LOCK_TOKEN: recoveryToken, MBM_RUNNER_LAUNCH_TOKEN: launchToken },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  publishProvisionalRunnerClaim(dir, child.pid, launchToken);
  const code = await new Promise((resolvePromise) => { child.once("close", resolvePromise); });
  const after = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert(code !== 0, "recovery runner unexpectedly accepted a wrong-type recovery-lock claim");
  assert(after.status === "interrupted" && await exists(join(dir, "plan.json")) && !(await exists(join(dir, "result.json"))),
    `recovery-lock handshake failure destroyed retry state: status=${after.status}`);
  assert(stderr.includes("managed job fatal terminal record skipped: reason=runner_claim_unconfirmed"),
    "recovery-lock handshake failure was not classified as pre-terminal runner bootstrap failure");
}

function isolateStepCoverage(plan) {
  const isolate = (step) => ({
    ...step,
    env: { ...(step.env || {}), NODE_V8_COVERAGE: "" },
  });
  return {
    ...plan,
    steps: Array.isArray(plan.steps) ? plan.steps.map(isolate) : plan.steps,
    finally_steps: Array.isArray(plan.finally_steps) ? plan.finally_steps.map(isolate) : plan.finally_steps,
  };
}

function createManagedJobTestManager(options) {
  const manager = new ManagedJobManager(options);
  for (const method of ["start", "stage"]) {
    const original = manager[method].bind(manager);
    manager[method] = (plan, ...rest) => original(isolateStepCoverage(plan), ...rest);
  }
  return manager;
}

async function testManagedJobCapacityBoundary() {
  const terminalRoot = join(root, "capacity-terminal-jobs");
  const terminalManager = createManagedJobTestManager({
    jobRoot: terminalRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
  });
  const heldCapacity = acquireJobCapacityLock(terminalRoot);
  assert(heldCapacity, "capacity boundary fixture could not acquire the root transaction lock");
  let capacityCommitError = null;
  try {
    terminalManager.stage({ name: "blocked capacity commit", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { capacityCommitError = error; }
  heldCapacity.release();
  assert(capacityCommitError?.code === "conflict" && capacityCommitError?.retryable === true
    && capacityCommitError?.details?.capacity_commit_pending === true,
  "concurrent managed-job capacity commit did not fail with a structured retryable conflict");
  const terminalIds = [];
  for (let index = 0; index < 50; index += 1) {
    const staged = terminalManager.stage({
      name: `terminal capacity ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
    terminalIds.push(staged.job_id);
    terminalManager.cancel({ job_id: staged.job_id });
  }
  assert(terminalManager.list({ limit: 50 }).retained === 50, "terminal capacity fixture did not fill the retained-job limit");
  if (process.platform !== "win32") {
    const invalidKey = "capacity-presence-fail-closed";
    const invalidDigest = createHash("sha256")
      .update("machine-bridge-managed-job-idempotency-v1\0").update("local").update("\0").update(invalidKey).digest("hex");
    const invalidDir = join(terminalRoot, `job_${invalidDigest}`);
    await symlink(join(root, "missing-capacity-target"), invalidDir);
    expectThrow(() => terminalManager.start({
      idempotency_key: invalidKey,
      name: "invalid deterministic capacity target",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }), "managed job directory is not a real directory");
    assert(terminalManager.list({ limit: 50 }).retained === 50,
      "failed deterministic target inspection evicted retained terminal history before admission failed");
    await rm(invalidDir, { force: true });
  }
  const replacement = terminalManager.stage({
    name: "terminal capacity replacement",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const survivingTerminal = (await Promise.all(terminalIds.map((id) => exists(join(terminalRoot, id))))).filter(Boolean).length;
  assert(survivingTerminal === 49 && terminalManager.list({ limit: 50 }).retained === 50,
    "full retained-job capacity did not evict exactly one safely removable terminal record for a new job");
  assert(terminalManager.read({ job_id: replacement.job_id }).status === "staged",
    "capacity reservation removed or failed to create the replacement staged job");
  terminalManager.cancel({ job_id: replacement.job_id });

  const stagedRoot = join(root, "capacity-staged-jobs");
  const stagedManager = createManagedJobTestManager({
    jobRoot: stagedRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true },
    resources: {},
    recover: false,
    logger: { warn() {} },
  });
  const stagedIds = [];
  for (let index = 0; index < 50; index += 1) {
    stagedIds.push(stagedManager.stage({
      name: `staged capacity ${index}`,
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }).job_id);
  }
  let capacityError = null;
  try {
    stagedManager.stage({
      name: "staged capacity overflow",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    });
  } catch (error) { capacityError = error; }
  assert(capacityError?.code === "limit_exceeded" && capacityError?.retryable === true,
    "fully active/staged managed-job capacity did not return a structured retryable limit error");
  assert(stagedManager.list({ limit: 50 }).retained === 50,
    "capacity reservation evicted a staged/active job to admit an overflow job");

  await rm(join(stagedRoot, stagedIds.pop()), { recursive: true, force: true });
  const retiredCapacityDir = join(stagedRoot, `retired_job_${"V".repeat(24)}_d0_i0`);
  await mkdir(retiredCapacityDir, { mode: 0o700 });
  let retiredCapacityError = null;
  try {
    stagedManager.stage({ name: "retired state capacity overflow", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { retiredCapacityError = error; }
  const ownerCapacityList = stagedManager.list({ limit: 50 });
  assert(retiredCapacityError?.code === "limit_exceeded"
    && retiredCapacityError?.details?.retained_state === 50
    && retiredCapacityError?.details?.retired_state === 1
    && retiredCapacityError?.details?.retired_unreadable === 1
    && ownerCapacityList.retained === 49
    && ownerCapacityList.capacity?.retained_state === 50
    && ownerCapacityList.capacity?.retired_state === 1
    && ownerCapacityList.capacity?.retired_unreadable === 1,
  "unreadable retired managed-job state escaped the hard retained-state capacity boundary or owner diagnostics");
  const delegatedCapacityList = stagedManager.list({ limit: 50 }, { authority: { owner: false } });
  assert(!("capacity" in delegatedCapacityList), "non-owner list_jobs exposed global retained-state capacity diagnostics");
  await rm(retiredCapacityDir, { recursive: true, force: true });

  const wrongTypeId = `job_${"W".repeat(24)}`;
  const wrongTypePath = join(stagedRoot, wrongTypeId);
  await writeFile(wrongTypePath, "not-a-job-directory\n", { mode: 0o600 });
  let wrongTypeCapacityError = null;
  try {
    stagedManager.stage({ name: "wrong-type state capacity overflow", steps: [{ argv: [process.execPath, "-e", ""] }] });
  } catch (error) { wrongTypeCapacityError = error; }
  const wrongTypeList = stagedManager.list({ limit: 50 });
  assert(wrongTypeCapacityError?.code === "limit_exceeded"
    && wrongTypeCapacityError?.details?.retained_state === 50
    && wrongTypeCapacityError?.details?.job_state_unreadable === 1
    && wrongTypeList.retained === 50
    && wrongTypeList.jobs.some((job) => job.job_id === wrongTypeId && job.status === "unreadable")
    && wrongTypeList.capacity?.retained_state === 50 && wrongTypeList.capacity?.job_state_unreadable === 1
    && activeManagedJobs(stagedRoot).some((job) => job.job_id === wrongTypeId && job.status === "unreadable"),
  "wrong-type public managed-job state escaped retained-state capacity or destructive inventory");
  const delegatedWrongTypeList = stagedManager.list({ limit: 50 }, { authority: { owner: false } });
  assert(!delegatedWrongTypeList.jobs.some((job) => job.job_id === wrongTypeId) && !("capacity" in delegatedWrongTypeList),
    "non-owner list_jobs exposed wrong-type global job state or capacity diagnostics");
  await rm(wrongTypePath, { force: true });
}

const root = await mkdtemp(join(tmpdir(), "mbm-managed-job-test-"));
const workspace = join(root, "workspace");
const jobRoot = join(root, "jobs");
const secretFile = join(root, "local-resource.txt");
const helperFile = join(workspace, "temporary-helper.txt");
const cleanupMarker = join(workspace, "cleanup-marker.txt");
const cancelMarker = join(workspace, "cancel-cleanup-marker.txt");
const recoveryMarker = join(workspace, "recovery-cleanup-marker.txt");
const secret = "managed-job-secret-value-42";
const runnerEntry = fileURLToPath(new URL("../src/local/job-runner.mjs", import.meta.url));
const previousCoordinatorRoot = process.env.AGENT_RESOURCE_COORDINATOR_ROOT;
const previousBuildRoot = process.env.AGENT_BUILD_ROOT;
process.env.AGENT_RESOURCE_COORDINATOR_ROOT = join(root, "resource-coordinator");
process.env.AGENT_BUILD_ROOT = join(root, "build-cache");

await mkdir(workspace, { recursive: true });
await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
if (process.platform !== "win32") await chmod(secretFile, 0o600);
await writeFile(helperFile, "temporary", "utf8");

try {
  testTerminalPersistenceBoundary();
  testManagedStateIdentityRetry();
  testHostedManagedJobStatusProjection();
  await testRunnerClaimBoundary();
  await testRecoveryClaimFailurePreservesRetryState();
  await testManagedJobCapacityBoundary();
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
  assert(await exists(join(mismatchedFinishedDir, "plan.json")),
    "prune trusted same-status terminal files from different finished_at generations");
  assert(inconsistentTerminalWarnings.filter((entry) => entry.fields?.error_class === "integrity_error").length >= 3,
    "terminal evidence mismatches were retained without integrity-class diagnostics");
  const inconsistentActive = activeManagedJobs(inconsistentTerminalRoot);
  assert([inconsistentTerminalId, unprovenFailureId, mismatchedFinishedId].every((jobId) => inconsistentActive.some((job) =>
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
    assert(remoteDelayedStatus.host_turn_handoff_recommended === true && remoteDelayedStatus.status_polling_mode === "checkpoint",
      "remote active read_job did not recommend handing the hosted turn back instead of polling to terminal state");
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
    assert(remoteTerminalRead.host_turn_handoff_recommended === false && remoteTerminalRead.status_polling_mode === "checkpoint",
      "remote terminal read_job incorrectly recommended handing off an already settled job");
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
    job_id: reconstructedId, name: "terminal result recovery", status: "failed", recovered: false,
    steps: [], finally_steps: [], error_class: "execution_failed", cleanup_error_class: null,
    finished_at: reconstructedFinishedAt,
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(reconstructedDir, "plan.json"), "sensitive-plan-must-be-scrubbed\n", { mode: 0o600 });
  const reconstructed = manager.read({ job_id: reconstructedId });
  assert(reconstructed.status === "failed" && reconstructed.finished_at === reconstructedFinishedAt, "terminal result did not reconstruct an interrupted status");
  assert(reconstructed.result_persisted === true && reconstructed.artifact_cleanup_pending === false, "reconstructed terminal status lost persistence metadata");
  assert(!(await exists(join(reconstructedDir, "plan.json"))), "terminal result recovery retained the sensitive execution plan");
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "succeeded", recovered: false,
    steps: [], finally_steps: [], error_class: null, cleanup_error_class: null, finished_at: reconstructedFinishedAt,
  })}\n`, { mode: 0o600 });
  expectThrow(() => manager.read({ job_id: reconstructedId }), "managed job terminal status and result are inconsistent");
  await rm(join(reconstructedDir, "result.json"), { force: true });
  expectThrow(() => manager.read({ job_id: reconstructedId }), "managed job terminal result is missing");
  await writeFile(join(reconstructedDir, "result.json"), `${JSON.stringify({
    job_id: reconstructedId, name: "terminal result recovery", status: "failed", recovered: false,
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
  expectThrow(() => manager.stage({ name: "bad bool", steps: [{ argv: [process.execPath, "-e", ""], allow_failure: "true" }] }), "allow_failure must be a boolean");
  expectThrow(() => manager.stage({ name: "bad timeout", steps: [{ argv: [process.execPath, "-e", ""], timeout_seconds: "60" }] }), "timeout_seconds must be an integer between 1 and 3600");
  expectThrow(() => manager.stage({ name: "bad executable", temporary_files: [{ name: "helper.js", content: "", executable: "true" }], steps: [{ argv: [process.execPath, "-e", ""] }] }), "temporary_files[0].executable must be a boolean");

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
  const directExit = await new Promise((resolvePromise, rejectPromise) => {
    directRunner.once("close", (code) => resolvePromise(code));
    directRunner.once("error", rejectPromise);
  });
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
  await writeFile(transitionLock, `${process.pid}\n`, { mode: 0o600 });
  expectThrow(() => manager.inspectLocal({ job_id: locked.job_id }), "job state is being modified");
  expectThrow(() => manager.cancel({ job_id: locked.job_id }), "job state is being modified");
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
  await writeFile(staleTransitionLock, `${process.pid}\n`, { mode: 0o600 });
  const oldTime = new Date(Date.now() - 10 * 60_000);
  await utimes(staleTransitionLock, oldTime, oldTime);
  const staleCancellation = manager.cancel({ job_id: staleReusedPid.job_id });
  assert(staleCancellation.status === "cancelled_before_start", "stale transition lock with a reused live PID was not reclaimed");

  const trimmedLogJob = manager.stage({
    name: "bounded runner diagnostics",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  await setRunnerFixtureState(jobRoot, trimmedLogJob.job_id, true);
  const trimmedLogPath = join(jobRoot, trimmedLogJob.job_id, "runner.out.log");
  const trimTailMarker = "runner-diagnostic-tail-marker";
  await writeFile(trimmedLogPath, `${"old-line\n".repeat(20_000)}${trimTailMarker}\n`, { mode: 0o600 });
  launchRunner(join(jobRoot, trimmedLogJob.job_id));
  await waitForJob(manager, trimmedLogJob.job_id);
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
  const idempotentPlan = {
    idempotency_key: idempotencyKey,
    name: "idempotent managed job",
    steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},250)"], timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
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
  assert(idempotentResult.status === "succeeded", "idempotent managed-job fixture did not finish successfully");

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
    " process.stdout.write(file.toString()+process.env.MBM_JOB_SECRET+'\\n'+stdin.toString()+file.toString('base64')+'\\n'+file.toString('hex')+'\\n'+p+'\\n'+alt(p)+'\\n'+process.env.MBM_SOURCE_PATH+'\\n'+alt(process.env.MBM_SOURCE_PATH)+'\\n');",
    " process.exit(7);",
    "});",
  ].join("");
  const cleanupScript = "const fs=require('node:fs'); fs.rmSync(process.argv[1],{force:true}); fs.writeFileSync(process.argv[2],'cleaned');";

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
    finally_steps: [{
      name: "remove temporary helper",
      argv: [process.execPath, "-e", cleanupScript, helperFile, cleanupMarker],
      timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS,
    }],
  });
  assert(accepted.detached && accepted.continues_without_mcp_connection, "managed job was not accepted as detached");
  const failed = await waitForJob(manager, accepted.job_id);
  assert(failed.status === "failed", `expected failed job, got ${failed.status}`);
  assert(!(await exists(helperFile)) && await exists(cleanupMarker), "finally step did not clean the temporary helper");
  const serialized = JSON.stringify(failed);
  assert(!serialized.includes(secret), "job result exposed raw resource content");
  assert(!serialized.includes(Buffer.from(`${secret}\n`).toString("base64")), "job result exposed base64 resource content");
  assert(!serialized.includes(Buffer.from(`${secret}\n`).toString("hex")), "job result exposed hex resource content");
  assert(!serialized.includes(secretFile) && !serialized.includes(sourcePathAlias), "job result exposed a registered resource path alias");
  const expectedRedactionMarkers = ["redacted-resource:test-secret", "resource:test-secret", "resource-source:test-secret"];
  const missingRedactionMarkers = expectedRedactionMarkers.filter((marker) => !serialized.includes(marker));
  assert(missingRedactionMarkers.length === 0, `job result did not mark redacted values and paths: ${missingRedactionMarkers.join(", ")}`);
  assert(serialized.includes("temporary-helper-ok"), "job-scoped temporary helper did not run");
  assert(!(await exists(join(jobRoot, accepted.job_id, "runtime"))), "job runtime resource copies and temporary files were not removed");
  assert(!(await exists(join(jobRoot, accepted.job_id, "plan.json"))), "finished job retained scripts, stdin, argv, or resource source paths in plan.json");

  const changingResource = join(root, "changing-resource.txt");
  await writeFile(changingResource, "first-value", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(changingResource, 0o600);
  const changingManager = createManagedJobTestManager({
    jobRoot: join(root, "changing-jobs"),
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { changing: inspectResourceFile(changingResource) },
  });
  const changingJob = changingManager.start({
    name: "resource replacement fails closed",
    steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},250)"], stdin_resource: "changing", timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  await writeFile(changingResource, "second-value", { mode: 0o600 });
  const changed = await waitForJob(changingManager, changingJob.job_id);
  assert(changed.status === "failed" && changed.result?.error_class === "resource_error", "resource change after submission did not fail closed");

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

  const descendantPidFile = join(workspace, "managed-descendant.pid");
  const treeOrderFile = join(workspace, "managed-tree-order.txt");
  const treeTimeout = manager.start({
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
  await waitForRunning(manager, treeTimeout.job_id);
  const treeRunnerClaim = JSON.parse(await readFile(join(jobRoot, treeTimeout.job_id, "runner.pid"), "utf8"));
  const treeRunnerPid = Number(treeRunnerClaim.pid);
  assert(Number.isInteger(treeRunnerPid) && treeRunnerPid > 0, "managed job private runner claim omitted the runner pid");
  assert(typeof treeRunnerClaim.processStartedAt === "string" && !("launchToken" in treeRunnerClaim),
    "runner did not atomically upgrade its provisional claim to an exact token-free identity");
  const descendantPid = Number(await waitForManagedJobFixtureFileText(manager, treeTimeout.job_id, descendantPidFile, MANAGED_JOB_TREE_READY_MS));
  assert(Number.isInteger(descendantPid) && descendantPid > 0, "managed job process-tree fixture published an invalid descendant pid");
  const treeTimeoutResult = await waitForJob(manager, treeTimeout.job_id, null, MANAGED_JOB_TEST_WAIT_MS);
  assert(treeTimeoutResult.result.steps[0].timed_out === true, "managed job process-tree fixture did not time out");
  await waitForPidExit(descendantPid, MANAGED_JOB_TEST_WAIT_MS);
  await waitForPidExit(treeRunnerPid, MANAGED_JOB_TEST_WAIT_MS);
  const treeOrder = (await readFile(treeOrderFile, "utf8")).trim();
  assert(treeOrder === "dead",
    `managed job cleanup began before timed-out descendants settled: ${treeOrder}`);

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
  await writeFile(staleRecoveryLock, `${process.pid}
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
  const coordinatorLockTask = withResourceTransactionLock(coordinatorRoot, async () => {
    coordinatorLockReadyResolve();
    await new Promise((resolvePromise) => { releaseCoordinatorLock = resolvePromise; });
  }, { timeoutMs: 30_000 });
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
    try { coordinator.transaction_owner = (await readFile(join(coordinatorRoot, "transaction.lock", "owner.json"), "utf8")).trim(); }
    catch (error) { coordinator.transaction_owner = `unavailable:${error?.code || "unknown"}`; }
    try { coordinator.leases = await readdir(join(coordinatorRoot, "leases")); } catch {}
    try { coordinator.waiters = await readdir(join(coordinatorRoot, "waiters")); } catch {}
    throw new Error(`expected recovered cleanup, got ${recovered.status}; result=${JSON.stringify(recovered.result || null)}; runner_stderr=${runnerStderr}; coordinator=${JSON.stringify(coordinator)}`);
  }
  assert(await readFile(recoveryMarker, "utf8") === "x", "concurrent recovery launched duplicate finally execution");
  assert(concurrentRecoveryManager.read({ job_id: recoverable.job_id }).status === "recovered", "concurrent manager did not observe recovered terminal state");
  assert(!(await exists(join(recoverableDir, "plan.json"))), "recovered job retained its execution plan");

  const changedResourceFile = join(root, "recovery-changed-resource.txt");
  const changedResourceReadyFile = join(root, "recovery-changed-resource-ready.txt");
  const changedResourceCleanupFile = join(root, "recovery-changed-resource-cleanup.txt");
  await writeFile(changedResourceFile, "recovery-secret-v1", { mode: 0o600 });
  const changedResource = inspectResourceFile(changedResourceFile);
  const changedResourceManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "recovery-secret": changedResource },
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
  });
  const changedRecovery = await waitForJob(
    changedRecoveryManager,
    changedResourceJob.job_id,
    new Set(["recovery_failed"]),
  );
  assert(changedRecovery.status === "recovery_failed" && changedRecovery.result?.recovered === true,
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
  assert(exhausted.status === "recovery_exhausted" && exhausted.recovery_attempts === 3, "recovery limit did not become terminal");
  assert(exhausted.result_persisted === true && exhausted.artifact_cleanup_pending === false && exhausted.result?.status === "recovery_exhausted",
    "recovery exhaustion bypassed the crash-consistent terminal evidence contract");
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
  publishProvisionalRunnerClaim(foreignClaimDir, process.pid, "a".repeat(32));
  const foreignClaimExit = await childExitCode(foreignClaimRunner);
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
  publishProvisionalRunnerClaim(corruptFatalDir, corruptFatalRunner.pid, corruptFatalLaunchToken);
  await waitForConfirmedRunnerClaim(join(corruptFatalDir, "runner.pid"), corruptFatalRunner.pid);
  await writeFile(join(corruptFatalDir, "status.json"), "{not-json\n", { mode: 0o600 });
  const corruptFatalExit = await childExitCode(corruptFatalRunner);
  assert(corruptFatalExit !== 0 && (await readFile(join(corruptFatalDir, "status.json"), "utf8")) === "{not-json\n"
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
  await new Promise((resolvePromise, rejectPromise) => {
    corruptRunner.once("close", resolvePromise);
    corruptRunner.once("error", rejectPromise);
  });
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
  await rm(root, { recursive: true, force: true });
}

function testTerminalPersistenceBoundary() {
  assert(managedJobFinalStatus({ recover: true, cancelled: false, mainError: new Error("resource snapshot changed"), cleanupError: null }) === "recovery_failed",
    "recovery ignored a pre-cleanup resource/state failure and reported success");
  assert(managedJobFinalStatus({ recover: true, cancelled: false, mainError: null, cleanupError: null }) === "recovered",
    "clean recovery was not reported as recovered");
  const terminalStates = new Set(["failed"]);
  assert(!isSettledTerminalJob({ status: "failed", artifact_cleanup_pending: true }, terminalStates),
    "terminal cleanup checkpoint was mistaken for fully settled job state");
  assert(isSettledTerminalJob({ status: "failed", artifact_cleanup_pending: false }, terminalStates),
    "cleanup-confirmed terminal job was not treated as settled");

  const status = { job_id: `job_${"P".repeat(24)}`, name: "persistence boundary", status: "running" };
  const result = {
    job_id: status.job_id, name: status.name, status: "failed", steps: [], finally_steps: [],
    error_class: "execution_failed", cleanup_error_class: null, finished_at: new Date().toISOString(),
  };

  const resultFailureWrites = [];
  const resultFailureRemoved = [];
  const resultFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan", "pid"], status, result,
    writeJson(file, value) {
      if (file === "result") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      resultFailureWrites.push(structuredClone(value));
    },
    removeFile(file) { resultFailureRemoved.push(file); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(resultFailure.statusPersisted && !resultFailure.resultPersisted && resultFailure.artifactsScrubbed, "result persistence failure did not preserve a terminal status");
  assert(resultFailure.status.result_persisted === false && resultFailure.status.terminal_record_error_class === "storage_limit", "result persistence failure metadata is incomplete");
  assert(resultFailureWrites.length === 2 && resultFailureRemoved.join(",") === "plan,pid", "terminal status was not confirmed around artifact cleanup");

  const statusFailureRemoved = [];
  const statusFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan"], status, result,
    writeJson(file) { if (file === "status") throw Object.assign(new Error("read only"), { code: "EROFS" }); },
    removeFile(file) { statusFailureRemoved.push(file); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(statusFailure.resultPersisted && !statusFailure.statusPersisted && statusFailureRemoved.length === 0, "status persistence failure deleted recovery artifacts");
  assert(statusFailure.statusErrorClass === "permission_denied", "status persistence failure was not classified");

  const cleanupWrites = [];
  const cleanupFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan", "pid"], status, result,
    writeJson(file, value) { if (file === "status") cleanupWrites.push(structuredClone(value)); },
    removeFile(file) { if (file === "plan") throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(cleanupFailure.statusPersisted && !cleanupFailure.artifactsScrubbed, "artifact cleanup failure was reported as successful");
  assert(cleanupFailure.status.artifact_cleanup_pending === true && cleanupFailure.cleanupErrorClass === "permission_denied", "artifact cleanup failure metadata is incomplete");
  assert(cleanupWrites.at(-1).artifact_cleanup_pending === true, "cleanup-pending status was not persisted");

  let statusWrites = 0;
  const confirmationFailure = persistManagedJobTerminal({
    statusFile: "status", resultFile: "result", artifacts: ["plan"], status, result,
    writeJson(file) {
      if (file === "status" && ++statusWrites === 2) throw new Error("confirmation failed");
    },
    removeFile() {}, maxStatusBytes: 1024, maxResultBytes: 1024,
  });
  assert(confirmationFailure.statusPersisted && confirmationFailure.artifactsScrubbed && confirmationFailure.statusErrorClass === "persistence_failed", "post-cleanup status confirmation failure was hidden");
  assert(confirmationFailure.status.artifact_cleanup_pending === true, "failed cleanup confirmation did not retain conservative pending state");
}

async function childExitCode(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("close", (code) => resolvePromise(code));
    child.once("error", rejectPromise);
  });
}

async function waitForConfirmedRunnerClaim(file, pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const claim = JSON.parse(await readFile(file, "utf8"));
      if (Number(claim.pid) === Number(pid) && typeof claim.processStartedAt === "string" && !claim.launchToken) return claim;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("timed out waiting for managed job runner claim confirmation");
}

async function waitForRunning(manager, jobId, timeoutMs = MANAGED_JOB_TEST_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = manager.read({ job_id: jobId });
    if (["running", "cleaning"].includes(value.status)) return value;
    if (!new Set(["queued"]).has(value.status)) throw new Error(`job finished before cancellation: ${value.status}`);
    await delay(50);
  }
  throw new Error("timed out waiting for managed job to start");
}

async function waitForJob(manager, jobId, terminal = null, timeoutMs = MANAGED_JOB_TEST_WAIT_MS, context = {}) {
  const terminalStates = terminal || new Set([
    "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
    "cancelled_cleanup_failed", "recovered", "recovery_failed",
  ]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = manager.read({ job_id: jobId }, context);
    if (isSettledTerminalJob(value, terminalStates)) return value;
    await delay(50);
  }
  const dir = join(jobRoot, jobId);
  const diagnostics = {};
  for (const name of ["status.json", "runner.out.log", "runner.err.log"]) {
    try { diagnostics[name] = await readFile(join(dir, name), "utf8"); } catch {}
  }
  throw new Error(`timed out waiting for managed job ${jobId}: ${JSON.stringify(diagnostics)}`);
}

function isSettledTerminalJob(value, terminalStates) {
  return terminalStates.has(value.status) && value.artifact_cleanup_pending !== true;
}

async function waitForManagedJobFixtureFileText(manager, jobId, file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) return text;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const value = manager.read({ job_id: jobId });
    if (!["queued", "running", "cleaning"].includes(value.status)) {
      throw new Error(`managed job fixture ended before publishing ${file}: ${await managedJobFixtureDiagnostics(jobId, value)}`);
    }
    await delay(50);
  }
  const value = manager.read({ job_id: jobId });
  throw new Error(`timed out waiting for managed job fixture file ${file}: ${await managedJobFixtureDiagnostics(jobId, value)}`);
}

async function managedJobFixtureDiagnostics(jobId, value) {
  let runnerStderr = "";
  try { runnerStderr = (await readFile(join(jobRoot, jobId, "runner.err.log"), "utf8")).slice(-2048); } catch {}
  return `status=${value.status}; phase=${value.current_phase || "none"}; result=${JSON.stringify(value.result || null)}; runner_stderr=${runnerStderr}`;
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
  throw new Error(`timed out waiting for runner pid ${pid} to exit`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function delay(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
