import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_FIXTURE_TESTS, directNodeTestFiles } from "./check-runner.mjs";
import {
  captureCoverageGeneration,
  mergeFunctionExecutions,
  verificationChildEnvironment,
} from "./lib/verification.mjs";
import { releaseDiagnostic } from "./release-diagnostic.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRITICAL_SCRIPT_FILES = new Set(["scripts/release-publication-guard.mjs", "scripts/lib/verification.mjs", "scripts/verification-state.mjs"]);
const FULL_COVERAGE_CONTEXT_ENV = "MBM_CHECK_FULL_COVERAGE_CONTEXT";
const FULL_COVERAGE_CONTEXT_FILE = ".mbm-full-coverage-context.json";
const sharedCoverage = loadFullCoverageContext();
const generationBefore = captureCoverageGeneration(root);
const coverageDir = sharedCoverage?.coverageDir || mkdtempSync(resolve(tmpdir(), "machine-bridge-coverage-"));
const ownsCoverageDir = !sharedCoverage;
const coverageEnvironment = verificationChildEnvironment(process.env);
const tests = COVERAGE_FIXTURE_TESTS;
const precollectedTests = sharedCoverage
  ? precollectedCoverageTests(sharedCoverage.completedTasks, tests)
  : new Set();

try {
  for (const test of tests) {
    if (precollectedTests.has(test)) continue;
    const run = spawnSync(process.execPath, [test], {
      cwd: root,
      env: { ...coverageEnvironment, NODE_V8_COVERAGE: coverageDir },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.status !== 0) {
      writeDiagnostic(process.stdout, run.stdout);
      writeDiagnostic(process.stderr, run.stderr);
      throw new Error(`coverage fixture failed: ${test}`);
    }
  }
  if (precollectedTests.size) {
    console.log(`reused precollected V8 coverage for ${precollectedTests.size}/${tests.length} coverage fixtures`);
  }
  const generationAfter = captureCoverageGeneration(root);
  if (generationAfter !== generationBefore) {
    throw new Error(`coverage generation changed during verification: ${generationBefore} -> ${generationAfter}`);
  }

  const coverage = collectCoverage(coverageDir);
  const thresholds = {
    "src/local/core/authority.mjs": [85, 45],
    "src/local/state/device-identity.mjs": [95, 75],
    "src/local/core/operation-risk.mjs": [85, 60],
    "src/local/process/settlement.mjs": [85, 80],
    "src/local/git/git-safety.mjs": [100, 70],
    "src/local/git/git-contracts.mjs": [100, 70],
    "src/local/git/git-service.mjs": [90, 65],
    "src/local/runtime/runtime-projections.mjs": [90, 50],
    "src/local/runtime/security-audit-log.mjs": [85, 55],
    "src/local/runtime/security-audit-store.mjs": [85, 60],
    "src/shared/device-session-auth.mjs": [100, 90],
    "src/shared/mcp-protocol.mjs": [90, 70],
    "src/shared/tool-argument-validation.mjs": [90, 70],
    "src/shared/tool-call-capacity.mjs": [100, 75],
    "src/shared/project-overview-projection.mjs": [100, 90],
    "src/shared/activation-recovery.mjs": [100, 85],
    "src/local/core/policy.mjs": [90, 65],
    "src/local/core/errors.mjs": [70, 50],
    "src/local/runtime/call-registry.mjs": [85, 55],
    "src/local/runtime/call-helpers.mjs": [90, 70],
    "src/local/process/tree.mjs": [85, 55],
    "src/local/process/tree-snapshot.mjs": [90, 65],
    "src/local/transport/relay-heartbeat.mjs": [90, 65],
    "src/local/runtime/tool-executor.mjs": [90, 40],
    "src/local/automation/computer-use.mjs": [60, 60],
    "src/local/automation/computer-use-observation.mjs": [90, 65],
    "src/local/automation/computer-use-geometry.mjs": [90, 65],
    "src/local/automation/computer-use-policies.mjs": [100, 75],
    "src/local/automation/computer-use-contracts.mjs": [95, 80],
    "src/local/automation/computer-use-result-budget.mjs": [100, 75],
    "src/local/automation/browser-observation.mjs": [90, 65],
    "src/local/automation/macos-background-input.mjs": [90, 60],
    "src/local/runtime/observability.mjs": [85, 40],
    "src/local/process/tracker.mjs": [65, 35],
    "src/local/process/session-helpers.mjs": [95, 70],
    "src/local/core/filesystem-identity.mjs": [100, 60],
    "src/local/core/exclusive-file.mjs": [90, 60],
    "src/local/files/workspace-search.mjs": [85, 55],
    "src/local/files/workspace-transaction.mjs": [90, 65],
    "src/local/core/log.mjs": [60, 40],
    "src/local/runtime/runtime.mjs": [75, 55],
    "src/local/runtime/resource-operations.mjs": [80, 50],
    "src/local/process/resource-admission.mjs": [95, 40],
    "src/local/process/resource-admission-policy.mjs": [100, 65],
    "src/local/process/resource-waiters.mjs": [95, 45],
    "src/local/process/resource-build-concurrency.mjs": [100, 75],
    "src/local/process/resource-lang-concurrency.mjs": [100, 75],
    "src/local/process/resource-xcode.mjs": [100, 75],
    "src/local/process/resource-command-profile.mjs": [90, 45],
    "src/local/deploy/npm.mjs": [100, 70],
    "src/local/process/resource-light-command.mjs": [100, null],
    "src/local/process/resource-metrics.mjs": [100, 60],
    "src/local/process/resource-release-control.mjs": [100, 70],
    "src/local/process/resource-leases.mjs": [95, 65],
    "src/local/process/resource-host.mjs": [100, 40],
    "src/local/process/resource-process-admission.mjs": [100, 35],
    "src/local/core/secure-file.mjs": [90, 65],
    "src/local/state/ssh-key.mjs": [90, 65],
    "src/local/deploy/service-support.mjs": [80, 75],
    "src/local/state/account-admin.mjs": [90, 60],
    "src/local/cli/cli.mjs": [48, 21.9],
    "src/local/cli/cli-activate.mjs": [65, 35],
    "src/local/deploy/service-contracts.mjs": [100, 75],
    "src/local/deploy/service-handoff.mjs": [100, 60],
    "src/local/deploy/service-owner.mjs": [100, 85],
    "src/local/deploy/service-runtime.mjs": [90, 80],
    "src/local/deploy/windows-service-convergence.mjs": [100, 95],
    "src/local/runtime/runtime-activation.mjs": [90, 70],
    "scripts/release-publication-guard.mjs": [100, 80],
    "scripts/lib/verification.mjs": [80, 65],
    "scripts/verification-state.mjs": [90, 70],
    "src/local/cli/cli-admin.mjs": [55, 35],
    "src/local/files/project-metadata.mjs": [95, 55],
    "src/local/cli/state-inventory.mjs": [85, 55],
    "src/local/transport/network-proxy.mjs": [85, 60],
    "src/local/deploy/worker-deployment.mjs": [80, 55],
    "src/local/deploy/hardened-npm.mjs": [90, 70],
    "src/local/agent/agent-contract.mjs": [90, 40],
    "src/local/agent/agent-skill-discovery.mjs": [85, 60],
    "src/local/automation/app-macos-jxa.mjs": [100, 65],
    "src/local/automation/browser-extension-protocol.mjs": [95, 35],
    "src/local/automation/browser-operation-service.mjs": [80, 50],
    "src/local/state/state-locks.mjs": [90, 55],
    "src/local/state/worker-secret-file.mjs": [90, 65],
    "src/local/runtime/runtime-services.mjs": [95, 75],
    "src/local/runtime/runtime-diagnostics.mjs": [75, 45],
    "src/local/transport/stdio-task-projection.mjs": [70, 70],
    "src/local/core/timing.mjs": [100, 100],
    "src/local/state/state.mjs": [85, 45],
    "src/local/state/state-storage.mjs": [90, 65],
    "src/local/transport/relay-connection.mjs": [90, 55],
    "src/local/transport/relay-classification.mjs": [90, 60],
    "src/local/jobs/manager.mjs": [85, 50],
    "src/local/jobs/retention.mjs": [90, 70],
    "src/local/jobs/capacity.mjs": [90, 70],
    "src/local/jobs/directory.mjs": [75, 50],
    "src/local/jobs/projection.mjs": [90, 60],
    "src/local/jobs/runner-claim.mjs": [90, 60],
    "src/local/jobs/runner-lifecycle.mjs": [80, 50],
    "src/local/automation/browser-broker.mjs": [80, 50],
    "src/local/automation/browser-pairing.mjs": [70, 70],
    "src/local/automation/browser-bridge.mjs": [80, 55],
    "src/local/automation/browser-broker-routes.mjs": [85, 35],
    "src/worker/oauth/account-admin.ts": [70, 35],
    "src/worker/room/tool-timeout.ts": [95, 85],
    "src/worker/daemon/ready-waiters.ts": [100, 70],
    "src/worker/mcp/tool-catalog.ts": [95, 80],
    "src/worker/daemon/auth.ts": [85, 45],
    "src/worker/oauth/dpop.ts": [85, 30],
    "src/worker/oauth/client-admin.ts": [75, 45],
    "src/worker/oauth/refresh-families.ts": [70, 35],
    "src/worker/oauth/store-validation.ts": [90, 70],
    "src/worker/oauth/oauth-tokens.ts": [70, 35],
    "src/worker/oauth/controller.ts": [84, 65],
    "src/worker/oauth/authorization-page.ts": [90, 60],
    "src/worker/room/pending-calls.ts": [90, 35],
    "src/worker/room/policy.ts": [100, 25],
    "src/worker/room/errors.ts": [100, 40],
    "src/worker/mcp/jsonrpc.ts": [95, 55],
    "src/worker/mcp/tool-call-dispatch.ts": [100, 75],
    "src/worker/mcp/http-contract.ts": [90, 70],
    "src/worker/mcp/controller.ts": [90, 70],
    "src/worker/mcp/response-proxy.ts": [90, 70],
    "src/worker/mcp/response-stream.ts": [100, null],
    "src/worker/room/server-info.ts": [95, 65],
    "src/worker/room/runtime-alarm.ts": [95, 65],
    "src/worker/room/entry.ts": [95, 55],
    "src/worker/room/observability.ts": [95, 75],
    "src/worker/oauth/token-issuance.ts": [100, 75],
    "src/worker/daemon/registry.ts": [50, 70],
    "src/worker/room/websocket-protocol.ts": [100, 50],
  };
  const failures = [];
  for (const [file, [minimumFunctions, minimumBlocks]] of Object.entries(thresholds)) {
    const metric = coverage.get(file);
    if (!metric) {
      failures.push(`${file}: no coverage data`);
      continue;
    }
    const functionPercent = percent(metric.functionsCovered, metric.functionsTotal);
    const blockPercent = percent(metric.blocksCovered, metric.blocksTotal);
    console.log(`${file}: functions ${functionPercent.toFixed(1)}% (${metric.functionsCovered}/${metric.functionsTotal}), blocks ${blockPercent.toFixed(1)}% (${metric.blocksCovered}/${metric.blocksTotal})`);
    if (functionPercent < minimumFunctions) failures.push(`${file}: function coverage ${functionPercent.toFixed(1)}% < ${minimumFunctions}%`);
    if (minimumBlocks !== null && blockPercent < minimumBlocks) failures.push(`${file}: block coverage ${blockPercent.toFixed(1)}% < ${minimumBlocks}%`);
  }
  if (failures.length) throw new Error(`coverage thresholds failed:\n- ${failures.join("\n- ")}`);
  console.log("critical-module coverage thresholds passed");
} finally {
  if (ownsCoverageDir) rmSync(coverageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

function loadFullCoverageContext() {
  const rawPath = process.env[FULL_COVERAGE_CONTEXT_ENV];
  if (!rawPath) return null;
  const contextPath = resolve(rawPath);
  const coverageDir = dirname(contextPath);
  if (contextPath !== resolve(coverageDir, FULL_COVERAGE_CONTEXT_FILE)) {
    throw new Error("full coverage context path is not the private context filename");
  }
  let record;
  try { record = JSON.parse(readFileSync(contextPath, "utf8")); }
  catch (error) { throw new Error(`full coverage context is unreadable: ${String(error?.message || error)}`); }
  if (!record || record.schema_version !== "1.0.0" || !Number.isSafeInteger(record.producer_pid) || record.producer_pid <= 0) {
    throw new Error("full coverage context metadata is invalid");
  }
  if (record.producer_pid !== process.ppid) throw new Error("full coverage context producer is not the verification parent");
  if (resolve(String(record.coverage_dir || "")) !== coverageDir) throw new Error("full coverage context directory does not match its pathname");
  if (resolve(String(process.env.NODE_V8_COVERAGE || "")) !== coverageDir) throw new Error("full coverage context does not match NODE_V8_COVERAGE");
  const directoryStat = lstatSync(coverageDir);
  const contextStat = lstatSync(contextPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !contextStat.isFile() || contextStat.isSymbolicLink()) {
    throw new Error("full coverage context must use ordinary private filesystem entries");
  }
  if (process.platform !== "win32" && ((directoryStat.mode & 0o077) !== 0 || (contextStat.mode & 0o077) !== 0)) {
    throw new Error("full coverage context permissions are not private");
  }
  if (record.generation !== captureCoverageGeneration(root)) throw new Error("full coverage context generation does not match current coverage inputs");
  if (!Array.isArray(record.completed_tasks) || record.completed_tasks.some((task) => typeof task !== "string" || !task)) {
    throw new Error("full coverage context completed task list is invalid");
  }
  if (!readdirSync(coverageDir).some((name) => name.startsWith("coverage-") && name.endsWith(".json"))) {
    throw new Error("full coverage context has no precollected V8 reports");
  }
  return { coverageDir, completedTasks: record.completed_tasks };
}

function precollectedCoverageTests(completedTasks, coverageTests) {
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts || {};
  const coverageSet = new Set(coverageTests);
  const precollected = new Set();
  for (const task of completedTasks) {
    const files = directNodeTestFiles(task, scripts);
    const matched = files.filter((file) => coverageSet.has(file));
    if (!files.length || !matched.length) {
      throw new Error(`full coverage context contains a non-curated completed task: ${task}`);
    }
    for (const file of matched) precollected.add(file);
  }
  return precollected;
}

function collectCoverage(directory) {
  const scripts = new Map();
  for (const filename of readdirSync(directory)) {
    const report = JSON.parse(readFileSync(resolve(directory, filename), "utf8"));
    for (const script of report.result || []) {
      if (!String(script.url).startsWith("file://")) continue;
      const absolute = fileURLToPath(script.url);
      const repositoryRelative = relative(root, absolute);
      if (!repositoryRelative || repositoryRelative === ".." || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) continue;
      const file = repositoryRelative.split(sep).join("/");
      if (!file.startsWith("src/") && !CRITICAL_SCRIPT_FILES.has(file)) continue;
      let entry = scripts.get(file);
      if (!entry) {
        entry = { functions: new Map() };
        scripts.set(file, entry);
      }
      for (const fn of script.functions || []) {
        if (!fn.ranges?.length) continue;
        const outer = fn.ranges[0];
        const functionKey = `${outer.startOffset}:${outer.endOffset}:${fn.functionName}`;
        let functionEntry = entry.functions.get(functionKey);
        if (!functionEntry) {
          functionEntry = { executions: [] };
          entry.functions.set(functionKey, functionEntry);
        }
        functionEntry.executions.push(fn.ranges);
      }
    }
  }
  return new Map([...scripts].map(([file, entry]) => {
    const blocks = new Map();
    let functionsCovered = 0;
    for (const functionEntry of entry.functions.values()) {
      const merged = mergeFunctionExecutions(functionEntry.executions);
      if (merged.functionCovered) functionsCovered += 1;
      for (const [blockKey, covered] of merged.blocks) {
        blocks.set(blockKey, (blocks.get(blockKey) || false) || covered);
      }
    }
    return [file, {
      functionsTotal: entry.functions.size,
      functionsCovered,
      blocksTotal: blocks.size,
      blocksCovered: [...blocks.values()].filter(Boolean).length,
    }];
  }));
}

function percent(covered, total) {
  return total ? covered * 100 / total : 100;
}

function writeDiagnostic(stream, value) {
  if (!value) return;
  for (const line of String(value).split(/\r?\n/)) {
    if (line) stream.write(`${releaseDiagnostic(line, 4096)}\n`);
  }
}
