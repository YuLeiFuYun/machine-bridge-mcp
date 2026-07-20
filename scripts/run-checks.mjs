import { checkTasks } from "./check-plan.mjs";
import { runVerificationPlan } from "./check-runner.mjs";

const mode = process.argv[2] || "full";
const tasks = checkTasks(mode);

try {
  await runVerificationPlan({
    mode,
    tasks,
    npmCli: process.env.npm_execpath,
    verbose: process.env.MBM_CHECK_VERBOSE === "1",
  });
} catch (error) {
  if (error?.message && !String(error.message).startsWith("verification task failed:")) {
    console.error(error.message);
  }
  process.exit(Number(error?.exitCode) || 1);
}
