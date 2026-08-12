import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FAST_CHECK_TASKS,
  FULL_CHECK_TASKS,
  FULL_ONLY_CHECK_TASKS,
  PLATFORM_CHECK_TASKS,
  PLATFORM_ONLY_CHECK_TASKS,
  SERIAL_FAST_CHECK_TASKS,
  checkTasks,
} from "../scripts/check-plan.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const scripts = packageJson.scripts || {};

assert.deepEqual(checkTasks("fast"), FAST_CHECK_TASKS);
assert.deepEqual(checkTasks("platform"), PLATFORM_CHECK_TASKS);
assert.deepEqual(checkTasks("full"), FULL_CHECK_TASKS);
assert.throws(() => checkTasks("unknown"), /unknown check mode/);
for (const [name, tasks] of Object.entries({
  fast: FAST_CHECK_TASKS,
  platform_only: PLATFORM_ONLY_CHECK_TASKS,
  platform: PLATFORM_CHECK_TASKS,
  full_only: FULL_ONLY_CHECK_TASKS,
  full: FULL_CHECK_TASKS,
})) {
  assert.equal(new Set(tasks).size, tasks.length, `${name} check plan contains duplicate tasks`);
}
for (const task of FULL_CHECK_TASKS) assert.equal(typeof scripts[task], "string", `check plan references missing package script: ${task}`);
for (const task of SERIAL_FAST_CHECK_TASKS) assert(FAST_CHECK_TASKS.includes(task), `serial fast task is not in the fast plan: ${task}`);
assert.equal(new Set(SERIAL_FAST_CHECK_TASKS).size, SERIAL_FAST_CHECK_TASKS.length, "serial fast task list contains duplicates");
for (const task of ["coverage:test", "browser-bridge:test", "package:test", "sbom:test", "install:test", "stdio:integration-test", "worker:integration-test", "oauth-browser:test"]) {
  assert(FULL_ONLY_CHECK_TASKS.includes(task), `environment-sensitive task is not full-only: ${task}`);
}
for (const task of ["self-test", "service-platform:test", "full-access:test", "managed-jobs:test"]) {
  assert(PLATFORM_ONLY_CHECK_TASKS.includes(task), `cross-platform behavior task is not platform-only: ${task}`);
}
for (const task of ["architecture:test", "lint", "typecheck", "syntax", "policy:test", "runtime-infrastructure:test", "control-plane-resilience:test", "service-restart:test", "browser-identity:test", "check-runner:test", "release-channel:test", "release-soak:test", "runtime-activation:test", "release-publication-guard:test", "sbom-check:test", "npm-environment:test", "hardened-npm:test", "consumer-package-security:test", "wrangler-toolchain:test", "worker-types-generator:test", "workflow-policy:test", "managed-job-boundary:test", "release-diagnostic:test"]) {
  assert(FAST_CHECK_TASKS.includes(task), `fast plan omits required development gate: ${task}`);
}
assert.equal(scripts.check, "npm run check:full");
assert.equal(scripts["check:fast"], "node scripts/run-checks.mjs fast");
assert.equal(scripts["check:platform"], "node scripts/run-checks.mjs platform");
assert.equal(scripts["check:full"], "node scripts/run-checks.mjs full");

console.log(`check plan test ok (${FAST_CHECK_TASKS.length} fast, ${PLATFORM_CHECK_TASKS.length} platform, ${FULL_CHECK_TASKS.length} full tasks)`);
