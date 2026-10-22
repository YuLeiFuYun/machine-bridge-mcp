import { spawn } from "node:child_process";

import { readFile, rm, stat, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedJobManager } from "../../../src/local/managed-jobs.mjs";

import { withResourceTransactionLock } from "../../../src/local/resource-transaction-lock.mjs";

import { processState } from "../../../src/local/process-identity.mjs";
import { terminalStatusFromResult } from "../../../src/local/managed-job-terminal.mjs";
import serverMetadata from "../../../src/shared/server-metadata.json" with { type: "json" };

export const MANAGED_JOB_TEST_WAIT_MS = 480_000;
export const RUNNER_EXIT_RECOVERY_TEST_WAIT_MS = 90_000; // Covers three 10.1s recovery delays, bounded Windows filesystem cleanup retries, and scheduler margin.
export const MANAGED_JOB_MULTI_STEP_WAIT_MS = 600_000;
export const MANAGED_JOB_SUCCESS_TIMEOUT_SECONDS = 120;
export const MANAGED_JOB_TREE_TIMEOUT_SECONDS = 15;
export const MANAGED_JOB_TREE_READY_MS = 10_000;
export const RECOVERY_RESOURCE_LOCK_HOLD_MS = 5_500;
export const TOOL_SCHEMA_GENERATION = Number(serverMetadata.toolSchemaGeneration);

export const runnerEntry = fileURLToPath(new URL("../../../src/local/job-runner.mjs", import.meta.url));
export const runnerResourceHook = new URL("../managed-job-resource-hook.mjs", import.meta.url).href;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}

export async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

export function delay(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

export async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export async function withFixtureResourceTransactionLock(root, callback, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPublicationError = null;
  while (Date.now() < deadline) {
    try {
      return await withResourceTransactionLock(root, callback, { timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch (error) {
      const code = error?.code || error?.cause?.code;
      if (code !== "MBM_MULTIPLE_HARD_LINKS") throw error;
      lastPublicationError = error;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  throw lastPublicationError || new Error("managed-job recovery fixture timed out acquiring its private resource transaction lock");
}

export function isolateStepCoverage(plan) {
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

export function createManagedJobTestManager(options) {
  const manager = new ManagedJobManager({
    ...options,
    runnerSpawnProcess: options.runnerSpawnProcess ?? spawnManagedJobTestRunner,
  });
  const isolateFullEnvStepCoverage = options?.policy?.minimalEnv === false;
  for (const method of ["start", "stage"]) {
    const original = manager[method].bind(manager);
    manager[method] = (plan, ...rest) => original(isolateFullEnvStepCoverage ? isolateStepCoverage(plan) : plan, ...rest);
  }
  return manager;
}

export function relayRecoveryQuotaContext({ accountChar = "q", accountVersion = 1, clientChar = "a", familyChar = clientChar, role = "operator" } = {}) {
  return {
    origin: "relay",
    authority: {
      origin: "relay",
      owner: role === "owner",
      principal: {
        kind: "account",
        accountId: `acct_${accountChar.repeat(32)}`,
        accountVersion,
        clientId: `mcp_client_${clientChar.repeat(43)}`,
        familyId: `mcp_family_${familyChar.repeat(43)}`,
        role,
      },
    },
  };
}

export async function setRunnerFixtureState(jobRoot, jobId, queued) {
  const statusFile = join(jobRoot, jobId, "status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  status.status = queued ? "queued" : "staged";
  status.approval = queued ? "mcp" : "review-only";
  status.cleanup_guarantee = queued ? "best-effort-finally-and-recovery" : "not-started";
  status.updated_at = new Date().toISOString();
  await writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
}

export async function pendingDependencyFixture(manager, name) {
  const staged = manager.stage({
    name,
    steps: [{ argv: [process.execPath, "--version"], timeout_seconds: 10 }],
  });
  await setRunnerFixtureState(manager.jobRoot, staged.job_id, true);
  return staged;
}

export async function settleDependencyFixture(manager, jobId, terminalStatus, errorClass = null) {
  const dir = join(manager.jobRoot, jobId);
  const statusFile = join(dir, "status.json");
  const resultFile = join(dir, "result.json");
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  const finishedAt = new Date().toISOString();
  const result = {
    job_id: jobId,
    name: status.name,
    status: terminalStatus,
    steps: [],
    finally_steps: [],
    error_class: errorClass,
    cleanup_error_class: null,
    finished_at: finishedAt,
  };
  const terminal = {
    ...terminalStatusFromResult(status, result, { resultPersisted: true, updatedAt: finishedAt }),
    artifact_cleanup_pending: false,
    artifact_cleanup_error_class: null,
  };
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await writeFile(statusFile, `${JSON.stringify(terminal, null, 2)}\n`, { mode: 0o600 });
  for (const artifact of ["runtime", "plan.json", "runner.pid", "cancel"]) {
    await rm(join(dir, artifact), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  return terminal;
}

export async function waitForConfirmedRunnerClaim(file, pid, timeoutMs = 10_000) {
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

export async function waitForRunning(manager, jobId, timeoutMs = MANAGED_JOB_TEST_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = manager.read({ job_id: jobId });
    if (["running", "cleaning"].includes(value.status)) return value;
    if (!new Set(["queued"]).has(value.status)) throw new Error(`job finished before cancellation: ${value.status}`);
    await delay(50);
  }
  throw new Error("timed out waiting for managed job to start");
}

export function isSettledTerminalJob(value, terminalStates) {
  return terminalStates.has(value.status) && value.artifact_cleanup_pending !== true;
}

export async function waitForJob(manager, jobId, terminal = null, timeoutMs = MANAGED_JOB_TEST_WAIT_MS, context = {}) {
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
  const dir = join(manager.jobRoot, jobId);
  const diagnostics = {};
  for (const name of ["status.json", "runner.out.log", "runner.err.log"]) {
    try { diagnostics[name] = await readFile(join(dir, name), "utf8"); } catch {}
  }
  throw new Error(`timed out waiting for managed job ${jobId}: ${JSON.stringify(diagnostics)}`);
}

export async function waitForManagedJobFixtureFileText(manager, jobId, file, timeoutMs) {
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
      throw new Error(`managed job fixture ended before publishing ${file}: ${await managedJobFixtureDiagnostics(jobId, value, manager.jobRoot)}`);
    }
    await delay(50);
  }
  const value = manager.read({ job_id: jobId });
  throw new Error(`timed out waiting for managed job fixture file ${file}: ${await managedJobFixtureDiagnostics(jobId, value, manager.jobRoot)}`);
}

export async function managedJobFixtureDiagnostics(jobId, value, diagnosticsJobRoot) {
  let runnerStderr = "";
  try { runnerStderr = (await readFile(join(diagnosticsJobRoot, jobId, "runner.err.log"), "utf8")).slice(-2048); } catch {}
  return `status=${value.status}; phase=${value.current_phase || "none"}; result=${JSON.stringify(value.result || null)}; runner_stderr=${runnerStderr}`;
}

export async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    if (process.platform !== "win32" && processState(pid) === "zombie") return;
    await delay(50);
  }
  throw new Error(`timed out waiting for runner pid ${pid} to exit`);
}

export function spawnManagedJobTestRunner(command, args, options) {
  return spawn(command, ["--import", runnerResourceHook, ...args], options);
}

export function spawnManagedJobTestRunnerWithoutCoverage(command, args, options = {}) {
  return spawnManagedJobTestRunner(command, args, {
    ...options,
    env: { ...(options.env || {}), NODE_V8_COVERAGE: "" },
  });
}

export function managedJobTestRunnerForCoordinatorRoot(coordinatorRoot) {
  return (command, args, options = {}) => spawnManagedJobTestRunnerWithoutCoverage(command, args, {
    ...options,
    env: {
      ...(options.env || {}),
      AGENT_RESOURCE_COORDINATOR_ROOT: coordinatorRoot,
    },
  });
}
