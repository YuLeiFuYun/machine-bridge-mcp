import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { directNodeTestFiles } from "../scripts/check-runner.mjs";
import { bundleTaskTimeouts } from "../scripts/lib/release.mjs";
import {
  FAST_CHECK_TASKS,
  FULL_CHECK_TASKS,
  FULL_ONLY_CHECK_TASKS,
  FULL_POST_PLATFORM_CHECK_TASKS,
  FULL_PREFLIGHT_CHECK_TASKS,
  PLATFORM_CHECK_TASKS,
  PLATFORM_ONLY_CHECK_TASKS,
  QUICK_CHECK_TASKS,
  SERIAL_FAST_CHECK_TASKS,
  checkTasks,
} from "../scripts/check-plan.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const scripts = packageJson.scripts || {};

assert.deepEqual(checkTasks("quick"), QUICK_CHECK_TASKS);
assert.deepEqual(checkTasks("fast"), FAST_CHECK_TASKS);
assert.deepEqual(checkTasks("platform"), PLATFORM_CHECK_TASKS);
assert.deepEqual(checkTasks("full"), FULL_CHECK_TASKS);
assert.throws(() => checkTasks("unknown"), /unknown check mode/);
const fullTaskSet = new Set(FULL_CHECK_TASKS);
assert(QUICK_CHECK_TASKS.every((task) => fullTaskSet.has(task)), "quick plan contains a task outside the complete gate");
for (const [name, tasks] of Object.entries({
  quick: QUICK_CHECK_TASKS,
  fast: FAST_CHECK_TASKS,
  platform_only: PLATFORM_ONLY_CHECK_TASKS,
  platform: PLATFORM_CHECK_TASKS,
  full_only: FULL_ONLY_CHECK_TASKS,
  full_preflight: FULL_PREFLIGHT_CHECK_TASKS,
  full_post_platform: FULL_POST_PLATFORM_CHECK_TASKS,
  full: FULL_CHECK_TASKS,
})) {
  assert.equal(new Set(tasks).size, tasks.length, `${name} check plan contains duplicate tasks`);
}
for (const task of FULL_CHECK_TASKS) assert.equal(typeof scripts[task], "string", `check plan references missing package script: ${task}`);
// A test file no plan task runs cannot fail, so it protects nothing. Keep every test reachable
// from a planned package script or from the curated coverage-fixture list.
const plannedCommands = FULL_CHECK_TASKS.map((task) => String(scripts[task] || ""));
const runnerSource = await readFile(new URL("../scripts/check-runner.mjs", import.meta.url), "utf8");
for (const name of readdirSync(new URL("../tests", import.meta.url))) {
  if (!/(?:-|\.)test\.(?:mjs|js)$/.test(name)) continue;
  const reachable = plannedCommands.some((command) => command.includes(`tests/${name}`)) || runnerSource.includes(`tests/${name}`);
  assert(reachable, `test file is not reachable from any check plan task: tests/${name}`);
}
for (const task of SERIAL_FAST_CHECK_TASKS) assert(FAST_CHECK_TASKS.includes(task), `serial fast task is not in the fast plan: ${task}`);
assert.equal(new Set(SERIAL_FAST_CHECK_TASKS).size, SERIAL_FAST_CHECK_TASKS.length, "serial fast task list contains duplicates");
for (const task of ["coverage:test", "browser-bridge:test", "package:test", "sbom:test", "install:test", "stdio:integration-test", "worker:integration-test", "oauth-browser:test"]) {
  assert(FULL_ONLY_CHECK_TASKS.includes(task), `environment-sensitive task is not full-only: ${task}`);
}
assert.deepEqual(FULL_PREFLIGHT_CHECK_TASKS, ["sbom:test"], "full plan lost its cheap exact-dependency/SBOM preflight");
assert(FULL_CHECK_TASKS[0] === "sbom:test"
  && FULL_CHECK_TASKS.indexOf("sbom:test") < FULL_CHECK_TASKS.indexOf("managed-jobs:test")
  && FULL_CHECK_TASKS.indexOf("sbom:test") < FULL_CHECK_TASKS.indexOf("coverage:test"),
"full plan no longer starts by failing fast on an invalid source dependency tree before other verification work");
for (const task of ["self-test", "service-platform:test", "full-access:test", "managed-jobs:test", "test:platform-unit"]) {
  assert(PLATFORM_ONLY_CHECK_TASKS.includes(task), `cross-platform behavior task is not platform-only: ${task}`);
}
const plannedFastFiles = new Set(FAST_CHECK_TASKS.flatMap((task) => directNodeTestFiles(task, scripts)));
for (const task of ["architecture:test", "lint", "typecheck", "syntax", "test:policy", "test:runtime", "test:browser-unit", "test:apps-computer", "test:agent", "test:release-unit", "test:toolchain", "test:checks", "workflow-policy:test", "wrangler-toolchain:test", "cf-network:test", "cf-build:test"]) {
  assert(FAST_CHECK_TASKS.includes(task), `fast plan omits required development gate: ${task}`);
}
for (const testFile of [
  "tests/policy-test.mjs", "tests/runtime-infrastructure-test.mjs", "tests/control-plane-resilience-test.mjs",
  "tests/service-restart-handoff-test.mjs", "tests/browser-extension-identity-test.mjs", "tests/check-runner-test.mjs",
  "tests/release-channel-test.mjs", "tests/release-soak-test.mjs", "tests/runtime-activation-test.mjs",
  "tests/release-publication-guard-test.mjs", "tests/sbom-check-test.mjs", "tests/npm-environment-test.mjs",
  "tests/consumer-package-security-test.mjs", "tests/worker-types-generator-test.mjs",
  "tests/managed-job-boundary-test.mjs", "tests/release-diagnostic-test.mjs",
  "tests/browser-devtools-input-test.mjs", "tests/browser-devtools-observation-test.mjs",
  "tests/browser-computer-observation-test.mjs", "tests/browser-service-worker-test.mjs",
  "tests/app-automation-test.mjs", "tests/local-typecheck-coverage-test.mjs",
]) {
  assert(plannedFastFiles.has(testFile), `fast plan omits required test file: ${testFile}`);
}
assert.equal(scripts.check, "npm run check:full");
assert.equal(scripts["check:fast"], "node scripts/run-checks.mjs fast");
assert.equal(scripts["check:platform"], "node scripts/run-checks.mjs platform");
assert.equal(scripts["check:full"], "node scripts/run-checks.mjs full");

// The workflow bundle is the declared lifecycle authority; the runner must actually read
// its per-task budgets instead of keeping a second, silent copy.
const bundle = JSON.parse(await readFile(new URL("../workflow-bundle.json", import.meta.url), "utf8"));
const bundleTimeouts = bundleTaskTimeouts(bundle, scripts);
for (const [task, milliseconds] of [
  ["cf-network:test", 300_000],
  ["wrangler-toolchain:test", 300_000],
  ["cf-project:test", 600_000],
]) {
  assert.equal(bundleTimeouts.get(task), milliseconds, `workflow bundle budget for ${task} is not wired to the plan`);
}
const plannedTasks = new Set([...FAST_CHECK_TASKS, ...FULL_CHECK_TASKS, "test", "check:fast", "check:full"]);
for (const task of bundleTimeouts.keys()) {
  assert(plannedTasks.has(task), `workflow bundle declares a budget for a task no plan runs: ${task}`);
}

console.log(`check plan test ok (${FAST_CHECK_TASKS.length} fast, ${PLATFORM_CHECK_TASKS.length} platform, ${FULL_CHECK_TASKS.length} full tasks)`);
