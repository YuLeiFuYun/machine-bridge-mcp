import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { FAST_CHECK_TASKS, SERIAL_FAST_CHECK_TASKS, checkTasks } from "./check-plan.mjs";
import { runVerificationPlan } from "./check-runner.mjs";

const mode = process.argv[2] || "full";
const tasks = checkTasks(mode);
const packageScripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts || {};
const serialFastTasks = new Set(SERIAL_FAST_CHECK_TASKS);
const parallelFastTasks = new Set(FAST_CHECK_TASKS.filter((task) => !serialFastTasks.has(task)));

try {
  await runVerificationPlan({
    mode,
    tasks,
    npmCli: process.env.npm_execpath,
    verbose: process.env.MBM_CHECK_VERBOSE === "1",
    concurrency: checkConcurrency(process.env.MBM_CHECK_CONCURRENCY),
    parallelTaskNames: parallelFastTasks,
    packageScripts,
  });
} catch (error) {
  if (error?.message && !String(error.message).startsWith("verification task failed:")) {
    console.error(error.message);
  }
  process.exit(Number(error?.exitCode) || 1);
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
