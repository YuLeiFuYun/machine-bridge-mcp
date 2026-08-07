import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeManagedJobs, inspectResourceFile, launchRunner, ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { managedRunnerEnvironment, runnerProcessIsCurrent } from "../src/local/managed-job-runner.mjs";
import { confirmRunnerClaim, publishProvisionalRunnerClaim } from "../src/local/managed-job-runner-claim.mjs";
import { persistManagedJobTerminal } from "../src/local/managed-job-terminal.mjs";

const MANAGED_JOB_TEST_WAIT_MS = 480_000;
const MANAGED_JOB_MULTI_STEP_WAIT_MS = 600_000;
const MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS = 120;
const MANAGED_JOB_TREE_TIMEOUT_SECONDS = 15;
const MANAGED_JOB_TREE_READY_MS = 10_000;

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
  const originalStartedAt = JSON.parse(await readFile(provisionalFile, "utf8")).startedAt;
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

  await expectReject(confirmRunnerClaim({ file: join(root, "invalid-token.pid"), pid: process.pid, processStartedAt, launchToken: "invalid" }), "runner launch token is invalid");

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

  const oversizedRunnerDir = join(root, "runner-owner-oversized");
  await mkdir(oversizedRunnerDir, { recursive: true });
  await writeFile(join(oversizedRunnerDir, "runner.pid"), "x".repeat(1025), { mode: 0o600 });
  expectThrow(
    () => runnerProcessIsCurrent({ runner_pid: 2_147_483_647, runner_process_started_at: processStartedAt }, oversizedRunnerDir),
    "file exceeds 1024 bytes",
  );
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
    manager[method] = (plan) => original(isolateStepCoverage(plan));
  }
  return manager;
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

await mkdir(workspace, { recursive: true });
await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
if (process.platform !== "win32") await chmod(secretFile, 0o600);
await writeFile(helperFile, "temporary", "utf8");

try {
  testTerminalPersistenceBoundary();
  await testRunnerClaimBoundary();
  const minimalRunnerEnv = managedRunnerEnvironment({
    source: { PATH: "/safe/bin", HOME: "/safe/home", LANG: "C", HTTPS_PROXY: "http://secret", API_TOKEN: "secret" },
  });
  assert(minimalRunnerEnv.PATH === "/safe/bin" && minimalRunnerEnv.HOME === "/safe/home" && minimalRunnerEnv.LANG === "C", "minimal runner environment lost control variables");
  assert(minimalRunnerEnv.HTTPS_PROXY === undefined && minimalRunnerEnv.API_TOKEN === undefined, "minimal runner environment retained daemon credentials");
  const recoveryRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin", MBM_RECOVERY_LOCK_TOKEN: "stale" }, recoveryToken: "fresh" });
  assert(recoveryRunnerEnv.MBM_RECOVERY_LOCK_TOKEN === "fresh", "recovery runner environment lost the ownership token");
  const ordinaryRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin", MBM_RECOVERY_LOCK_TOKEN: "stale", MBM_RUNNER_LAUNCH_TOKEN: "stale" } });
  assert(ordinaryRunnerEnv.MBM_RECOVERY_LOCK_TOKEN === undefined, "ordinary runner inherited a stale recovery token");
  assert(ordinaryRunnerEnv.MBM_RUNNER_LAUNCH_TOKEN === undefined, "ordinary runner inherited a stale launch token");
  const launchRunnerEnv = managedRunnerEnvironment({ source: { PATH: "/bin" }, launchToken: "a".repeat(32) });
  assert(launchRunnerEnv.MBM_RUNNER_LAUNCH_TOKEN === "a".repeat(32), "runner environment lost the fresh launch token");
  const fullRunnerEnv = managedRunnerEnvironment({ fullEnv: true, source: { PATH: "/bin", API_TOKEN: "explicit" } });
  assert(fullRunnerEnv.API_TOKEN === "explicit", "explicit full-env runner did not preserve the requested parent environment");

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
  assert(typeof provisionalClaim.startedAt === "string" && !provisionalClaim.processStartedAt,
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
    job_id: reconstructedId, name: "terminal result recovery", status: "failed", recovered: false,
    steps: [], finally_steps: [], error_class: "execution_failed", cleanup_error_class: null,
    finished_at: reconstructedFinishedAt,
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(reconstructedDir, "plan.json"), "sensitive-plan-must-be-scrubbed\n", { mode: 0o600 });
  const reconstructed = manager.read({ job_id: reconstructedId });
  assert(reconstructed.status === "failed" && reconstructed.finished_at === reconstructedFinishedAt, "terminal result did not reconstruct an interrupted status");
  assert(reconstructed.result_persisted === true && reconstructed.artifact_cleanup_pending === false, "reconstructed terminal status lost persistence metadata");
  assert(!(await exists(join(reconstructedDir, "plan.json"))), "terminal result recovery retained the sensitive execution plan");

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
  manager.list({ limit: 50 });
  const expiredResult = manager.read({ job_id: expiredStaged.job_id });
  assert(expiredResult.status === "expired_before_start" && expiredResult.error_class === "expired", "staged sensitive plan did not expire fail-closed");
  assert(!(await exists(join(expiredDir, "plan.json"))), "expired staged plan retained env/stdin/script content");
  const expiredDiskText = (await Promise.all(["status.json", "result.json"].map((name) => readFile(join(expiredDir, name), "utf8")))).join("\n");
  assert(!expiredDiskText.includes("must-be-scrubbed") && !expiredDiskText.includes("sensitive-stdin"), "expired staged audit records retained sensitive plan content");

  const stagedMarker = join(workspace, "staged-approved.txt");
  const staged = manager.stage({
    name: "local approval handoff",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'approved')", stagedMarker], env_resources: { MBM_REVIEW_ONLY: "test-secret" }, timeout_seconds: MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS }],
  });
  assert(staged.status === "staged" && staged.execution_started === false, "stage_job started execution");
  await delay(200);
  assert(!(await exists(stagedMarker)), "staged job executed before local approval");
  const stagedStatus = manager.read({ job_id: staged.job_id });
  assert(stagedStatus.status === "staged" && await exists(join(jobRoot, staged.job_id, "plan.json")), "staged plan was not retained for approval");
  const stagedInspection = manager.inspectLocal({ job_id: staged.job_id });
  const stagedInspectionText = JSON.stringify(stagedInspection);
  assert(stagedInspection.review_plan?.steps?.length === 1 && stagedInspection.plan_sha256 === staged.plan_sha256 && stagedInspection.plan_integrity_verified === true, "local staged-plan inspection is incomplete");
  const inspectedResource = stagedInspection.review_plan?.resources?.["test-secret"];
  assert(!stagedInspectionText.includes(secretFile) && inspectedResource && !("path" in inspectedResource) && !("sha256" in inspectedResource), "local staged-plan inspection exposed a resource source path/hash");
  const approved = manager.approve({ job_id: staged.job_id }, { localOperator: true });
  assert(approved.status === "queued" && approved.approval === "local-operator", "local approval did not launch the staged job");
  const approvedResult = await waitForJob(manager, staged.job_id);
  assert(
    approvedResult.status === "succeeded" && await readFile(stagedMarker, "utf8") === "approved",
    `approved staged job did not execute: ${JSON.stringify(approvedResult)}`,
  );

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
  expectThrow(() => manager.approve({ job_id: tampered.job_id }, { localOperator: true }), "plan integrity check failed");
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
  const transitionLock = join(jobRoot, locked.job_id, "transition.lock");
  await writeFile(transitionLock, `${process.pid}\n`, { mode: 0o600 });
  expectThrow(() => manager.approve({ job_id: locked.job_id }, { localOperator: true }), "job state is being modified");
  await rm(transitionLock, { force: true });
  manager.cancel({ job_id: locked.job_id });

  const staleReusedPid = manager.stage({
    name: "stale reused pid transition lock",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const staleTransitionLock = join(jobRoot, staleReusedPid.job_id, "transition.lock");
  await writeFile(staleTransitionLock, `${process.pid}\n`, { mode: 0o600 });
  const oldTime = new Date(Date.now() - 10 * 60_000);
  await utimes(staleTransitionLock, oldTime, oldTime);
  const staleApproval = manager.approve({ job_id: staleReusedPid.job_id }, { localOperator: true });
  assert(staleApproval.accepted === true, "stale transition lock with a reused live PID was not reclaimed");
  await waitForJob(manager, staleReusedPid.job_id);

  const trimmedLogJob = manager.stage({
    name: "bounded runner diagnostics",
    steps: [{ argv: [process.execPath, "-e", ""] }],
  });
  const trimmedLogPath = join(jobRoot, trimmedLogJob.job_id, "runner.out.log");
  const trimTailMarker = "runner-diagnostic-tail-marker";
  await writeFile(trimmedLogPath, `${"old-line\n".repeat(20_000)}${trimTailMarker}\n`, { mode: 0o600 });
  manager.approve({ job_id: trimmedLogJob.job_id }, { localOperator: true });
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
    await symlink(logTarget, join(jobRoot, logSymlinkJob.job_id, "runner.out.log"));
    expectThrow(() => manager.approve({ job_id: logSymlinkJob.job_id }, { localOperator: true }), "symbolic link");
    assert(await readFile(logTarget, "utf8") === "unchanged", "runner diagnostics followed a symbolic link");
  }

  const neverRunMarker = join(workspace, "staged-cancelled.txt");
  const stagedCancelled = manager.stage({
    name: "cancel before approval",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'should-not-run')", neverRunMarker] }],
    finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'finally-should-not-run')", neverRunMarker] }],
  });
  const cancelledBeforeStart = manager.cancel({ job_id: stagedCancelled.job_id });
  assert(cancelledBeforeStart.status === "cancelled_before_start" && cancelledBeforeStart.execution_started === false, "staged cancellation status is incorrect");
  await delay(200);
  assert(!(await exists(neverRunMarker)), "cancelled staged job executed a main or finally step");
  assert(!(await exists(join(jobRoot, stagedCancelled.job_id, "plan.json"))), "cancelled staged plan was not scrubbed");

  const publicResources = manager.listResources();
  assert(publicResources.count === 1 && publicResources.resources[0].name === "test-secret", "resource alias was not listed");
  assert(!JSON.stringify(publicResources).includes(secretFile) && !JSON.stringify(publicResources).includes(secret), "resource listing exposed a path or value");
  assert(manager.diagnoseStorage().ok, "managed-job storage probe failed");

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

  const descendantPidFile = join(workspace, "managed-descendant.pid");
  const treeTimeout = manager.start({
    name: "timeout terminates descendants",
    steps: [{
      argv: [process.execPath, "-e", `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{},1000);`, descendantPidFile],
      timeout_seconds: MANAGED_JOB_TREE_TIMEOUT_SECONDS,
    }],
  });
  await waitForRunning(manager, treeTimeout.job_id);
  const treeRunnerClaim = JSON.parse(await readFile(join(jobRoot, treeTimeout.job_id, "runner.pid"), "utf8"));
  const treeRunnerPid = Number(treeRunnerClaim.pid);
  assert(Number.isInteger(treeRunnerPid) && treeRunnerPid > 0, "managed job private runner claim omitted the runner pid");
  assert(typeof treeRunnerClaim.processStartedAt === "string" && !("launchToken" in treeRunnerClaim),
    "runner did not atomically upgrade its provisional claim to an exact token-free identity");
  const descendantPid = Number(await waitForFileText(descendantPidFile, MANAGED_JOB_TREE_READY_MS));
  assert(Number.isInteger(descendantPid) && descendantPid > 0, "managed job process-tree fixture published an invalid descendant pid");
  const treeTimeoutResult = await waitForJob(manager, treeTimeout.job_id, null, MANAGED_JOB_TEST_WAIT_MS);
  assert(treeTimeoutResult.result.steps[0].timed_out === true, "managed job process-tree fixture did not time out");
  await waitForPidExit(descendantPid, MANAGED_JOB_TEST_WAIT_MS);
  await waitForPidExit(treeRunnerPid, MANAGED_JOB_TEST_WAIT_MS);

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
  });
  const concurrentRecoveryManager = createManagedJobTestManager({
    jobRoot,
    workspace,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: false },
    resources: { "test-secret": resource },
  });
  const recovered = await waitForJob(recoveryManager, recoverable.job_id, new Set(["recovered", "recovery_failed"]));
  assert(recovered.status === "recovered", `expected recovered cleanup, got ${recovered.status}`);
  assert(await readFile(recoveryMarker, "utf8") === "x", "concurrent recovery launched duplicate finally execution");
  assert(concurrentRecoveryManager.read({ job_id: recoverable.job_id }).status === "recovered", "concurrent manager did not observe recovered terminal state");
  assert(!(await exists(join(recoverableDir, "plan.json"))), "recovered job retained its execution plan");

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
  assert(!(await exists(join(exhaustedDir, "plan.json"))) && !(await exists(join(exhaustedDir, "runner.pid"))), "recovery exhaustion retained active metadata");

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
  await rm(root, { recursive: true, force: true });
}

function testTerminalPersistenceBoundary() {
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

async function waitForJob(manager, jobId, terminal = null, timeoutMs = MANAGED_JOB_TEST_WAIT_MS) {
  const terminalStates = terminal || new Set([
    "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
    "cancelled_cleanup_failed", "recovered", "recovery_failed",
  ]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = manager.read({ job_id: jobId });
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

async function waitForFileText(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) return text;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for managed job fixture file: ${file}`);
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
