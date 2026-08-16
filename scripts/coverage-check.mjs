import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCoverageGeneration } from "./coverage-generation.mjs";
import { mergeFunctionExecutions } from "./coverage-range-merge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRITICAL_SCRIPT_FILES = new Set(["scripts/release-publication-guard.mjs", "scripts/verification-generation-guard.mjs", "scripts/verification-state.mjs"]);
const generationBefore = captureCoverageGeneration(root);
const coverageDir = mkdtempSync(resolve(tmpdir(), "machine-bridge-coverage-"));
const tests = [
  "tests/policy-test.mjs",
  "tests/runtime-infrastructure-test.mjs",
  "tests/control-plane-resilience-test.mjs",
  "tests/process-output-continuation-test.mjs",
  "tests/process-nonreplayable-test.mjs",
  "tests/runtime-boundaries-test.mjs",
  "tests/git-commit-test.mjs",
  "tests/privacy-test.mjs",
  "tests/worker-runtime-infrastructure-test.mjs",
  "tests/mcp-protocol-test.mjs",
  "tests/mcp-controller-test.mjs",
  "tests/mcp-response-proxy-test.mjs",
  "tests/tool-argument-validation-test.mjs",
  "tests/worker-oauth-controller-test.mjs",
  "tests/logging-structure-test.mjs",
  "tests/runtime-handler-matrix-test.mjs",
  "tests/cli-entrypoint-test.mjs",
  "tests/cli-service-test.mjs",
  "tests/service-restart-handoff-test.mjs",
  "tests/service-platform-test.mjs",
  "tests/process-lock-test.mjs",
  "tests/secure-file-test.mjs",
  "tests/worker-secret-file-test.mjs",
  "tests/atomic-fs-test.mjs",
  "tests/coverage-range-merge-test.mjs",
  "tests/coverage-generation-test.mjs",
  "tests/check-runner-test.mjs",
  "tests/full-verification-receipt-test.mjs",
  "tests/resource-admission-test.mjs",
  "tests/resource-build-root-test.mjs",
  "tests/runtime-activation-test.mjs",
  "tests/prerelease-activation-test.mjs",
  "tests/release-publication-guard-test.mjs",
  "tests/local-self-test.mjs",
  "tests/numbers-test.mjs",
  "tests/records-test.mjs",
  "tests/project-metadata-test.mjs",
  "tests/state-inventory-test.mjs",
  "tests/state-root-retirement-test.mjs",
  "tests/worker-deployment-test.mjs",
  "tests/hardened-npm-test.mjs",
  "tests/wrangler-toolchain-test.mjs",
  "tests/agent-context-test.mjs",
  "tests/agent-boundaries-test.mjs",
  "tests/capability-ranking-test.mjs",
  "tests/execution-routing-test.mjs",
  "tests/browser-broker-auth-test.mjs",
  "tests/browser-pairing-launch-test.mjs",
  "tests/browser-bridge-test.mjs",
  "tests/browser-request-settlement-test.mjs",
  "tests/browser-operation-service-test.mjs",
  "tests/browser-devtools-input-test.mjs",
  "tests/browser-devtools-observation-test.mjs",
  "tests/browser-service-worker-test.mjs",
  "tests/app-automation-test.mjs",
  "tests/macos-background-input-test.mjs",
  "tests/computer-use-application-observation-test.mjs",
  "tests/browser-computer-observation-test.mjs",
  "tests/computer-use-test.mjs",
  "tests/computer-use-result-budget-test.mjs",
  "tests/relay-connection-test.mjs",
  "tests/managed-job-boundary-test.mjs",
  "tests/managed-jobs-test.mjs",
  "tests/account-admin-test.mjs",
  "tests/monotonic-deadline-test.mjs",
  "tests/device-auth-test.mjs",
  "tests/operation-authorization-test.mjs",
  "tests/security-audit-log-test.mjs",
  "tests/delegated-process-sandbox-test.mjs",
  "tests/dpop-test.mjs",
  "tests/worker-security-boundaries-test.mjs",
  "tests/ssh-key-test.mjs",
];

try {
  for (const test of tests) {
    const run = spawnSync(process.execPath, [test], {
      cwd: root,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.status !== 0) {
      process.stdout.write(run.stdout || "");
      process.stderr.write(run.stderr || "");
      throw new Error(`coverage fixture failed: ${test}`);
    }
  }
  const generationAfter = captureCoverageGeneration(root);
  if (generationAfter !== generationBefore) {
    throw new Error(`coverage generation changed during verification: ${generationBefore} -> ${generationAfter}`);
  }

  const coverage = collectCoverage(coverageDir);
  const thresholds = {
    "src/local/authority-context.mjs": [85, 55],
    "src/local/device-identity.mjs": [90, null],
    "src/local/operation-authorization.mjs": [85, 45],
    "src/local/operation-risk.mjs": [85, 60],
    "src/local/fixed-process-environment.mjs": [100, 80],
    "src/local/git-config-safety.mjs": [100, 75],
    "src/local/git-metadata-boundary.mjs": [100, 70],
    "src/local/git-metadata-tree-safety.mjs": [100, 70],
    "src/local/git-operation-state.mjs": [100, 80],
    "src/local/git-commit.mjs": [100, 75],
    "src/local/git-log-parser.mjs": [100, 80],
    "src/local/git-service.mjs": [90, 65],
    "src/local/support-state-projection.mjs": [100, 75],
    "src/local/security-audit-log.mjs": [85, 55],
    "src/local/security-audit-dispatch.mjs": [100, 70],
    "src/local/security-audit-warning.mjs": [100, 75],
    "src/local/security-audit-storage.mjs": [85, 60],
    "src/local/security-audit-state.mjs": [90, 65],
    "src/local/delegated-process-sandbox.mjs": [80, 45],
    "src/shared/device-session-auth.mjs": [100, null],
    "src/shared/mcp-protocol.mjs": [90, 70],
    "src/shared/tool-argument-validation.mjs": [90, 70],
    "src/shared/tool-call-capacity.mjs": [100, 75],
    "src/shared/project-overview-projection.mjs": [100, 90],
    "src/shared/activation-recovery.mjs": [100, 85],
    "src/local/policy.mjs": [90, 65],
    "src/local/errors.mjs": [70, 50],
    "src/local/call-registry.mjs": [85, 55],
    "src/local/call-capacity.mjs": [100, 70],
    "src/local/call-registry-drain.mjs": [100, 70],
    "src/local/process-tree-signal.mjs": [90, 55],
    "src/local/process-tree-supervisor.mjs": [100, 70],
    "src/local/process-tree-snapshot.mjs": [90, 65],
    "src/local/relay-heartbeat.mjs": [90, 65],
    "src/local/tool-executor.mjs": [90, 40],
    "src/local/tool-result-boundary.mjs": [100, 75],
    "src/local/process-nonreplayable-settlement.mjs": [100, 80],
    "src/local/computer-use.mjs": [85, 60],
    "src/local/computer-use-observation.mjs": [90, 65],
    "src/local/computer-use-application-observation.mjs": [90, 65],
    "src/local/computer-use-recovery.mjs": [100, 75],
    "src/local/computer-use-snapshot-store.mjs": [100, 80],
    "src/local/computer-use-result-budget.mjs": [100, 75],
    "src/local/browser-computer-observation-service.mjs": [90, 65],
    "src/local/macos-background-input.mjs": [90, 60],
    "src/local/observability.mjs": [95, 40],
    "src/local/process-tracker.mjs": [65, 35],
    "src/local/process-session-termination.mjs": [100, 70],
    "src/local/file-mutation-coordinator.mjs": [100, 65],
    "src/local/file-snapshot-preservation.mjs": [100, 75],
    "src/local/directory-metadata.mjs": [100, 80],
    "src/local/workspace-search.mjs": [100, 75],
    "src/local/filesystem-identity.mjs": [100, 85],
    "src/local/workspace-file-transaction.mjs": [90, 65],
    "src/local/log.mjs": [60, 40],
    "src/local/runtime.mjs": [75, 55],
    "src/local/runtime-paths.mjs": [90, 50],
    "src/local/resource-operations.mjs": [80, 50],
    "src/local/resource-admission.mjs": [95, 40],
    "src/local/resource-admission-policy.mjs": [100, 65],
    "src/local/resource-waiters.mjs": [95, 45],
    "src/local/resource-cargo-concurrency.mjs": [100, 75],
    "src/local/resource-cmake-concurrency.mjs": [100, 75],
    "src/local/resource-go-concurrency.mjs": [100, 75],
    "src/local/resource-gradle-concurrency.mjs": [100, 75],
    "src/local/resource-swift-concurrency.mjs": [100, 75],
    "src/local/resource-xcode-concurrency.mjs": [100, 75],
    "src/local/resource-xcode-command.mjs": [100, 75],
    "src/local/resource-xcode-non-build.mjs": [100, 75],
    "src/local/resource-make-concurrency.mjs": [100, 75],
    "src/local/resource-ninja-command-concurrency.mjs": [100, 75],
    "src/local/resource-ninja-concurrency.mjs": [100, 75],
    "src/local/resource-command-profile.mjs": [100, 55],
    "src/local/resource-foreground-wait.mjs": [100, 75],
    "src/local/npm-cli.mjs": [100, 70],
    "src/local/resource-light-command.mjs": [100, null],
    "src/local/resource-release-control-classification.mjs": [100, 75],
    "src/local/resource-release-control-executable.mjs": [100, 70],
    "src/local/resource-release-control-workspace.mjs": [100, 70],
    "src/local/resource-command-concurrency.mjs": [100, 70],
    "src/local/resource-maven-concurrency.mjs": [100, 75],
    "src/local/resource-pytest-concurrency.mjs": [100, 75],
    "src/local/resource-elastic-memory.mjs": [100, 75],
    "src/local/resource-elastic-request.mjs": [100, 70],
    "src/local/resource-script-classification.mjs": [100, 50],
    "src/local/resource-shell-analysis.mjs": [95, 60],
    "src/local/resource-host-cache.mjs": [100, 70],
    "src/local/resource-host-darwin.mjs": [100, 65],
    "src/local/resource-host-linux.mjs": [100, 85],
    "src/local/resource-host-snapshot.mjs": [100, null],
    "src/local/resource-lease-accounting.mjs": [95, 65],
    "src/local/resource-coordinator-accounting.mjs": [100, null],
    "src/local/resource-probe-command.mjs": [100, 40],
    "src/local/resource-process-ancestry.mjs": [100, 45],
    "src/local/resource-process-ancestry-cache.mjs": [100, 70],
    "src/local/resource-process-priority.mjs": [100, 60],
    "src/local/resource-project-key.mjs": [100, 45],
    "src/local/resource-wait.mjs": [100, 75],
    "src/local/resource-staging-recovery.mjs": [100, 55],
    "src/local/resource-build-root.mjs": [90, 65],
    "src/local/resource-process-admission.mjs": [100, 35],
    "src/local/resource-request-contract.mjs": [100, 70],
    "src/local/secure-file.mjs": [90, 65],
    "src/local/ssh-key.mjs": [90, 65],
    "src/local/service-definition.mjs": [100, 75],
    "src/local/account-admin.mjs": [90, 60],
    "src/local/account-admin-response.mjs": [100, 75],
    "src/local/cli.mjs": [48, 21.9],
    "src/local/cli-service.mjs": [100, 75],
    "src/local/service-convergence.mjs": [100, 75],
    "src/local/service-status.mjs": [100, 75],
    "src/local/service-ownership.mjs": [100, 75],
    "src/local/service-restart-scheduler.mjs": [100, 70],
    "src/local/service-restart-handoff.mjs": [100, 60],
    "src/local/service-owner.mjs": [100, 85],
    "src/local/service-runtime.mjs": [100, 80],
    "src/local/service-runtime-convergence.mjs": [100, 80],
    "src/local/windows-service-convergence.mjs": [100, 95],
    "src/local/runtime-activation.mjs": [90, 70],
    "scripts/release-publication-guard.mjs": [100, 80],
    "scripts/verification-generation-guard.mjs": [100, 80],
    "scripts/verification-state.mjs": [90, 70],
    "src/local/child-process-settlement.mjs": [100, 85],
    "src/local/cli-options.mjs": [65, 35],
    "src/local/cli-policy.mjs": [70, 35],
    "src/local/numbers.mjs": [100, 100],
    "src/local/records.mjs": [100, 100],
    "src/local/project-metadata.mjs": [95, 55],
    "src/local/state-inventory.mjs": [85, 55],
    "src/local/network-proxy.mjs": [90, 65],
    "src/local/worker-health.mjs": [85, 60],
    "src/local/worker-deployment.mjs": [80, 55],
    "src/local/hardened-npm-download.mjs": [90, 70],
    "src/local/hardened-npm-download-timeout.mjs": [100, 85],
    "src/local/agent-contract.mjs": [95, 40],
    "src/local/agent-context-projection.mjs": [95, 60],
    "src/local/agent-skill-discovery.mjs": [85, 60],
    "src/local/agent-text-file.mjs": [90, 60],
    "src/local/capability-ranking.mjs": [95, 70],
    "src/local/application-capability-projection.mjs": [100, 100],
    "src/local/execution-routing.mjs": [95, 70],
    "src/local/browser-extension-protocol.mjs": [95, 35],
    "src/local/browser-operation-service.mjs": [80, 50],
    "src/local/owner-state-lock.mjs": [90, 55],
    "src/local/exclusive-file.mjs": [90, 60],
    "src/local/worker-secret-file.mjs": [90, 65],
    "src/local/runtime-reporting.mjs": [95, 75],
    "src/local/runtime-info-projection.mjs": [100, 70],
    "src/local/runtime-diagnostics.mjs": [75, 65],
    "src/local/system-network-route.mjs": [90, 75],
    "src/local/systemd-removal.mjs": [100, 80],
    "src/local/runtime-capabilities.mjs": [75, 45],
    "src/local/monotonic-deadline.mjs": [100, 100],
    "src/local/path-inspection.mjs": [100, 60],
    "src/local/state.mjs": [85, 45],
    "src/local/state-root-retirement.mjs": [90, 70],
    "src/local/relay-connection.mjs": [90, 55],
    "src/local/relay-connection-classification.mjs": [90, 60],
    "src/local/managed-jobs.mjs": [85, 50],
    "src/local/managed-job-capacity.mjs": [100, 75],
    "src/local/managed-job-directory-generation.mjs": [90, 70],
    "src/local/managed-job-retention.mjs": [90, 70],
    "src/local/managed-job-terminal-maintenance.mjs": [90, 70],
    "src/local/managed-job-projection.mjs": [90, 60],
    "src/local/managed-job-storage.mjs": [75, 50],
    "src/local/managed-job-runner-claim.mjs": [90, 60],
    "src/local/managed-job-runner.mjs": [80, 50],
    "src/local/browser-broker-auth.mjs": [95, 80],
    "src/local/browser-pairing-grant.mjs": [95, 75],
    "src/local/browser-pairing-launch.mjs": [90, 70],
    "src/local/browser-broker-auth-http.mjs": [90, 70],
    "src/local/browser-bridge.mjs": [80, 55],
    "src/local/browser-request-settlement.mjs": [100, 75],
    "src/local/browser-request-registry.mjs": [95, 35],
    "src/local/browser-broker-routes.mjs": [85, 55],
    "src/local/browser-broker-server.mjs": [80, 50],
    "src/worker/account-admin.ts": [70, 35],
    "src/worker/tool-timeout.ts": [95, 85],
    "src/worker/daemon-ready-waiters.ts": [100, 70],
    "src/worker/daemon-ready-dispatch.ts": [100, 80],
    "src/worker/daemon-recovery-budget.ts": [100, 75],
    "src/worker/tool-catalog.ts": [95, 80],
    "src/worker/daemon-auth.ts": [85, 45],
    "src/worker/dpop.ts": [90, 30],
    "src/worker/nonce-store.ts": [85, 50],
    "src/worker/oauth-client-admin.ts": [75, 45],
    "src/worker/oauth-refresh-families.ts": [70, 35],
    "src/worker/oauth-store-validation.ts": [90, 70],
    "src/worker/oauth-tokens.ts": [70, 35],
    "src/worker/oauth-controller.ts": [84, 65],
    "src/worker/oauth-authorization-page.ts": [90, 60],
    "src/worker/pending-calls.ts": [90, 35],
    "src/worker/pending-call-capacity.ts": [100, 70],
    "src/worker/policy.ts": [100, 25],
    "src/worker/errors.ts": [100, 40],
    "src/worker/mcp-jsonrpc.ts": [95, 55],
    "src/worker/mcp-tool-call-input.ts": [100, 75],
    "src/worker/mcp-http-contract.ts": [90, 70],
    "src/worker/mcp-controller.ts": [90, 70],
    "src/worker/mcp-removed-protocol.ts": [100, 75],
    "src/worker/mcp-response-proxy.ts": [90, 70],
    "src/worker/mcp-response-stream.ts": [100, null],
    "src/worker/mcp-http-accept.ts": [100, 75],
    "src/worker/mcp-stream-proxy-contract.ts": [100, 75],
    "src/worker/worker-mcp-config.ts": [100, 75],
    "src/worker/runtime-alarm.ts": [95, 65],
    "src/worker/worker-static-routes.ts": [100, 90],
    "src/worker/worker-metadata.ts": [100, null],
    "src/worker/worker-edge-guard.ts": [100, 55],
    "src/worker/worker-edge-log.ts": [100, 80],
    "src/worker/oauth-token-issuance.ts": [100, 80],
    "src/worker/oauth-token-derivation.ts": [100, 75],
    "src/worker/oauth-refresh-exchange.ts": [95, 60],
    "src/worker/server-info.ts": [95, 65],
    "src/worker/daemon-status.ts": [100, 70],
    "src/worker/websocket-protocol.ts": [100, 50],
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
  rmSync(coverageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
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
