import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { policyProfile } from "../src/local/policy.mjs";
import { acquireJobCapacityLock, acquireJobTransitionLock } from "../src/local/managed-job-lock.mjs";
import { relayOwnerContext } from "./fixtures/authority-context.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mbm-resource-idempotency-")));
const workspace = join(root, "workspace");
const cwd = join(workspace, "work");
const resource = join(root, "synthetic-resource.txt");
const jobRoot = join(root, "jobs");
mkdirSync(cwd, { recursive: true });
writeFileSync(resource, "synthetic-resource\n", { mode: 0o600 });
const context = relayOwnerContext();
let launches = 0;
const options = {
  workspace, jobRoot, policy: policyProfile("full", "explicit"), recover: false,
  resources: { synthetic: { kind: "file", path: resource }, constructor: { kind: "file", path: resource } },
  logger: { warn() {}, error() {} },
  runnerSpawnProcess: () => { launches += 1; return { pid: process.pid, unref() {}, once() {} }; },
};
const request = {
  idempotency_key: "synthetic-resource-recovery",
  steps: [{ argv: [process.execPath, "{{resource:synthetic}}"], cwd, stdin_resource: "constructor", env_resources: { SYNTHETIC: "synthetic" }, env: JSON.parse('{"A":"one","B":"two","constructor":"data","__proto__":"data","hasOwnProperty":"data","toString":"data","valueOf":"data"}') }],
};
mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00.000Z") });
try {
  const manager = new ManagedJobManager(options);
  // The fake runner owns no child. Keep lifecycle reconciliation outside this
  // deterministic acceptance/identity test; real runners are exercised below.
  manager.reconcileStatus = () => {};
  const first = manager.start(request, context);
  const dir = join(jobRoot, first.job_id);
  const statusFile = join(dir, "status.json");
  const readStatus = () => JSON.parse(readFileSync(statusFile, "utf8"));
  const writeStatus = (status) => writeFileSync(statusFile, JSON.stringify(status), { mode: 0o600 });
  writeStatus({ ...readStatus(), status: "running" });
  const originalPlan = readFileSync(join(dir, "plan.json"), "utf8");
  const expectReplay = (activeManager = manager, args = request) => {
    const replay = activeManager.start(args, context);
    assert.equal(replay.job_id, first.job_id);
    assert.equal(replay.idempotency_replay, true);
    assert.equal(replay.plan_sha256, first.plan_sha256);
    assert.equal(launches, 1, "recovery launched a second runner");
  };
  mock.timers.tick(5000);
  expectReplay();
  expectReplay(manager, { ...request, steps: [{ ...request.steps[0], env: Object.fromEntries(Object.entries(request.steps[0].env).reverse()) }] });
  const currentStatus = readStatus();
  const legacyStatus = { ...currentStatus };
  delete legacyStatus.request_sha256;
  writeStatus(legacyStatus);
  expectReplay();
  writeStatus(currentStatus);
  const tamperedPlan = JSON.parse(originalPlan);
  tamperedPlan.steps[0].argv = ["must-not-run"];
  writeFileSync(join(dir, "plan.json"), JSON.stringify(tamperedPlan), { mode: 0o600 });
  assert.throws(() => manager.start(request, context), /plan integrity check failed/);
  writeFileSync(join(dir, "plan.json"), originalPlan, { mode: 0o600 });
  writeFileSync(resource, "changed-after-acceptance\n");
  expectReplay();
  rmSync(resource);
  rmSync(cwd, { recursive: true });
  manager.resources = {};
  expectReplay();
  assert.equal(readFileSync(join(dir, "plan.json"), "utf8"), originalPlan, "recovery rewrote the frozen execution plan");
  assert.throws(() => manager.start({ ...request, steps: [{ ...request.steps[0], argv: [process.execPath, "--version"] }] }, context),
    (error) => error.code === "conflict" && error.retryable === false);
  const capacity = acquireJobCapacityLock(jobRoot);
  try { assert.throws(() => manager.start(request, context), (error) => error.code === "conflict" && error.retryable); }
  finally { capacity.release(); }
  const transition = acquireJobTransitionLock(dir);
  try { assert.throws(() => manager.start(request, context), (error) => error.code === "conflict" && error.retryable); }
  finally { transition.release(); }
  expectReplay();
  const replacement = new ManagedJobManager({ ...options, resources: {} });
  replacement.reconcileStatus = () => {};
  expectReplay(replacement);
  const originalStatus = readStatus();
  writeStatus({ ...originalStatus, owner_account_version: originalStatus.owner_account_version + 1 });
  const scopedContext = { ...context, authority: { ...context.authority, owner: false, principal: { ...context.authority.principal, role: "operator" } } };
  assert.throws(() => manager.start(request, scopedContext), (error) => error.code === "authorization_denied");
  writeStatus({ ...originalStatus, request_sha256: "invalid" });
  assert.throws(() => manager.start(request, context), (error) => error.code === "integrity_error");
  writeStatus(originalStatus);
  const before = readdirSync(jobRoot).sort();
  assert.throws(() => manager.start({ ...request, idempotency_key: "new-invalid-input" }, context));
  assert.deepEqual(readdirSync(jobRoot).sort(), before, "invalid new inputs left an uncommitted job directory");
  writeStatus({ ...originalStatus, status: "succeeded" });
  rmSync(join(dir, "plan.json"));
  expectReplay(replacement);
  assert.equal(launches, 1);
  console.log("resource-bound managed-job idempotency test ok");
} finally { mock.timers.reset(); rmSync(root, { recursive: true, force: true }); }
