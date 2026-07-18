import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { checkTasks } from "./check-plan.mjs";

const mode = process.argv[2] || "full";
const tasks = checkTasks(mode);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("check runner must run through npm so npm_execpath is available");
const planStartedAt = performance.now();

console.log(`running ${mode} verification plan (${tasks.length} tasks)`);
for (const [index, task] of tasks.entries()) {
  const taskStartedAt = performance.now();
  console.log(`\n[${index + 1}/${tasks.length}] npm run ${task}`);
  const result = spawnSync(process.execPath, [npmCli, "run", task], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const elapsedSeconds = ((performance.now() - taskStartedAt) / 1000).toFixed(1);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`verification task failed after ${elapsedSeconds}s: ${task}`);
    process.exit(result.status || 1);
  }
  console.log(`completed ${task} in ${elapsedSeconds}s`);
}
const totalSeconds = ((performance.now() - planStartedAt) / 1000).toFixed(1);
console.log(`\n${mode} verification plan passed in ${totalSeconds}s`);
