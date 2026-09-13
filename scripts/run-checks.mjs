import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_CHECK_TASKS, SERIAL_FAST_CHECK_TASKS, checkTasks } from "./check-plan.mjs";
import { COVERAGE_FIXTURE_TESTS, directNodeInvocation, runVerificationPlan } from "./check-runner.mjs";
import { captureCoverageGeneration } from "./coverage-generation.mjs";
import { rerunVerificationUnderIdleSleepGuard } from "./verification-idle-sleep-guard.mjs";
import { runWithStableGeneration } from "./verification-generation-guard.mjs";
import {
  captureVerificationRunGeneration,
  captureVerifiedSourceGeneration,
  clearFullVerificationReceipt,
  writeFullVerificationReceipt,
} from "./verification-state.mjs";

const FULL_COVERAGE_CONTEXT_ENV = "MBM_CHECK_FULL_COVERAGE_CONTEXT";
const FULL_COVERAGE_CONTEXT_FILE = ".mbm-full-coverage-context.json";

const guardedExitCode = await rerunVerificationUnderIdleSleepGuard();
if (guardedExitCode !== null) process.exit(guardedExitCode);

const mode = process.argv[2] || "full";
const root = fileURLToPath(new URL("../", import.meta.url));
const tasks = checkTasks(mode);
const packageScripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts || {};
const coverageTaskNames = mode === "full" ? coverageTasksForPlan(tasks, packageScripts) : new Set();
const serialFastTasks = new Set(SERIAL_FAST_CHECK_TASKS);
const parallelFastTasks = new Set(FAST_CHECK_TASKS.filter((task) => !serialFastTasks.has(task)));
let fullCoverage = null;
try {
  if (mode === "full") {
    clearFullVerificationReceipt(root);
    fullCoverage = createFullCoverageContext(root, tasks, coverageTaskNames);
  }
  const verificationEnvironment = fullCoverage ? withoutFullCoverageEnvironment(process.env) : process.env;
  const taskEnvironments = fullCoverage
    ? createFullCoverageTaskEnvironments(fullCoverage, coverageTaskNames)
    : null;
  await runWithStableGeneration({
    label: `${mode} verification inputs`,
    captureGeneration: () => captureVerificationRunGeneration(root),
    run: () => runVerificationPlan({
      mode,
      tasks,
      npmCli: process.env.npm_execpath,
      env: verificationEnvironment,
      verbose: process.env.MBM_CHECK_VERBOSE === "1",
      concurrency: checkConcurrency(process.env.MBM_CHECK_CONCURRENCY),
      parallelTaskNames: parallelFastTasks,
      packageScripts,
      taskEnvironments,
    }),
  });
  if (mode === "full") writeFullVerificationReceipt(root, captureVerifiedSourceGeneration(root));
} catch (error) {
  if (error?.message && !String(error.message).startsWith("verification task failed:")) {
    console.error(error.message);
  }
  process.exitCode = Number(error?.exitCode) || 1;
} finally {
  fullCoverage?.dispose();
}

function createFullCoverageContext(projectRoot, planTasks, coverageTasks) {
  const coverageIndex = planTasks.indexOf("coverage:test");
  if (coverageIndex < 0) throw new Error("full verification plan has no coverage:test gate");
  const directory = mkdtempSync(join(tmpdir(), "machine-bridge-full-coverage-"));
  const contextPath = join(directory, FULL_COVERAGE_CONTEXT_FILE);
  try {
    writeFileSync(contextPath, `${JSON.stringify({
      schema_version: "1.0.0",
      producer_pid: process.pid,
      coverage_dir: directory,
      generation: captureCoverageGeneration(projectRoot),
      completed_tasks: planTasks.slice(0, coverageIndex).filter((task) => coverageTasks.has(task)),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    throw error;
  }
  let disposed = false;
  return {
    directory,
    contextPath,
    dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    },
  };
}

function coverageTasksForPlan(planTasks, scripts) {
  const coverageFixtures = new Set(COVERAGE_FIXTURE_TESTS);
  return new Set(planTasks.filter((task) => {
    const direct = directNodeInvocation(task, scripts);
    return direct && coverageFixtures.has(direct.args[0]);
  }));
}

function createFullCoverageTaskEnvironments(fullCoverage, coverageTasks) {
  const values = new Map();
  for (const task of coverageTasks) {
    values.set(task, { NODE_V8_COVERAGE: fullCoverage.directory });
  }
  values.set("coverage:test", {
    NODE_V8_COVERAGE: fullCoverage.directory,
    [FULL_COVERAGE_CONTEXT_ENV]: fullCoverage.contextPath,
  });
  return values;
}

function withoutFullCoverageEnvironment(environment) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    const upper = key.toUpperCase();
    if (upper === "NODE_V8_COVERAGE" || upper === FULL_COVERAGE_CONTEXT_ENV) delete clean[key];
  }
  return clean;
}

function checkConcurrency(value) {
  if (value !== undefined && value !== "") {
    const configured = Number(value);
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > 16) {
      throw new Error("MBM_CHECK_CONCURRENCY must be an integer from 1 to 16");
    }
    return configured;
  }
  return Math.max(1, Math.min(4, availableParallelism()));
}
