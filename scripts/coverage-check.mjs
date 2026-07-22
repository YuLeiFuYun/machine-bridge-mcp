import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coverageDir = mkdtempSync(resolve(tmpdir(), "machine-bridge-coverage-"));
const tests = [
  "tests/policy-test.mjs",
  "tests/runtime-infrastructure-test.mjs",
  "tests/runtime-boundaries-test.mjs",
  "tests/worker-runtime-infrastructure-test.mjs",
  "tests/worker-oauth-controller-test.mjs",
  "tests/logging-structure-test.mjs",
  "tests/runtime-handler-matrix-test.mjs",
  "tests/cli-entrypoint-test.mjs",
  "tests/cli-service-test.mjs",
  "tests/service-restart-handoff-test.mjs",
  "tests/local-self-test.mjs",
  "tests/runtime-self-test.mjs",
  "tests/numbers-test.mjs",
  "tests/records-test.mjs",
  "tests/project-metadata-test.mjs",
  "tests/state-inventory-test.mjs",
  "tests/worker-deployment-test.mjs",
  "tests/agent-context-test.mjs",
  "tests/agent-boundaries-test.mjs",
  "tests/capability-ranking-test.mjs",
  "tests/browser-bridge-test.mjs",
  "tests/relay-connection-test.mjs",
  "tests/managed-jobs-test.mjs",
  "tests/account-admin-test.mjs",
  "tests/monotonic-deadline-test.mjs",
  "tests/device-auth-test.mjs",
  "tests/operation-authorization-test.mjs",
  "tests/security-audit-log-test.mjs",
  "tests/delegated-process-sandbox-test.mjs",
  "tests/dpop-test.mjs",
  "tests/worker-security-boundaries-test.mjs",
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

  const coverage = collectCoverage(coverageDir);
  const thresholds = {
    "src/local/authority-context.mjs": [85, 55],
    "src/local/device-identity.mjs": [90, null],
    "src/local/operation-authorization.mjs": [85, 45],
    "src/local/operation-risk.mjs": [85, 60],
    "src/local/operation-state-lock.mjs": [100, 7],
    "src/local/security-audit-log.mjs": [85, 55],
    "src/local/delegated-process-sandbox.mjs": [80, 45],
    "src/shared/device-session-auth.mjs": [100, null],
    "src/local/policy.mjs": [90, 65],
    "src/local/errors.mjs": [70, 50],
    "src/local/call-registry.mjs": [85, 55],
    "src/local/tool-executor.mjs": [90, 40],
    "src/local/tool-result-boundary.mjs": [100, 75],
    "src/local/observability.mjs": [95, 40],
    "src/local/process-tracker.mjs": [65, 35],
    "src/local/log.mjs": [60, 40],
    "src/local/runtime.mjs": [75, 55],
    "src/local/runtime-paths.mjs": [90, 50],
    "src/local/cli.mjs": [48, 21.9],
    "src/local/cli-service.mjs": [100, 75],
    "src/local/service-convergence.mjs": [100, 75],
    "src/local/service-status.mjs": [100, 75],
    "src/local/service-ownership.mjs": [100, 75],
    "src/local/service-restart-scheduler.mjs": [100, 70],
    "src/local/service-restart-handoff.mjs": [100, 60],
    "src/local/cli-options.mjs": [65, 35],
    "src/local/cli-policy.mjs": [70, 35],
    "src/local/numbers.mjs": [100, 100],
    "src/local/records.mjs": [100, 100],
    "src/local/project-metadata.mjs": [95, 55],
    "src/local/state-inventory.mjs": [85, 55],
    "src/local/network-proxy.mjs": [90, 65],
    "src/local/worker-health.mjs": [85, 60],
    "src/local/worker-deployment.mjs": [80, 55],
    "src/local/agent-contract.mjs": [95, 40],
    "src/local/agent-context-projection.mjs": [95, 60],
    "src/local/agent-skill-discovery.mjs": [85, 60],
    "src/local/agent-text-file.mjs": [90, 60],
    "src/local/capability-ranking.mjs": [95, 70],
    "src/local/browser-extension-protocol.mjs": [95, 35],
    "src/local/browser-operation-service.mjs": [80, 50],
    "src/local/runtime-reporting.mjs": [95, 75],
    "src/local/runtime-diagnostics.mjs": [75, 65],
    "src/local/runtime-capabilities.mjs": [75, 45],
    "src/local/monotonic-deadline.mjs": [100, 100],
    "src/local/state.mjs": [85, 45],
    "src/local/relay-connection.mjs": [90, 55],
    "src/local/managed-jobs.mjs": [85, 50],
    "src/local/managed-job-projection.mjs": [90, 60],
    "src/local/managed-job-storage.mjs": [75, 50],
    "src/local/managed-job-runner.mjs": [80, 50],
    "src/local/browser-bridge.mjs": [80, 55],
    "src/local/browser-request-registry.mjs": [95, 35],
    "src/local/browser-broker-routes.mjs": [85, 55],
    "src/local/browser-broker-server.mjs": [80, 50],
    "src/worker/account-admin.ts": [70, 35],
    "src/worker/daemon-auth.ts": [85, 45],
    "src/worker/dpop.ts": [90, 30],
    "src/worker/nonce-store.ts": [85, 50],
    "src/worker/oauth-client-admin.ts": [75, 45],
    "src/worker/oauth-refresh-families.ts": [70, 35],
    "src/worker/oauth-tokens.ts": [70, 35],
    "src/worker/oauth-controller.ts": [84, 65],
    "src/worker/oauth-authorization-page.ts": [90, 60],
    "src/worker/pending-calls.ts": [90, 35],
    "src/worker/policy.ts": [100, 25],
    "src/worker/errors.ts": [100, 40],
    "src/worker/mcp-jsonrpc.ts": [95, 55],
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
      if (!file.startsWith("src/")) continue;
      let entry = scripts.get(file);
      if (!entry) {
        entry = { functions: new Map(), blocks: new Map() };
        scripts.set(file, entry);
      }
      for (const fn of script.functions || []) {
        if (!fn.ranges?.length) continue;
        const outer = fn.ranges[0];
        const functionKey = `${outer.startOffset}:${outer.endOffset}:${fn.functionName}`;
        entry.functions.set(functionKey, (entry.functions.get(functionKey) || false) || outer.count > 0);
        for (const range of fn.ranges.slice(1)) {
          const blockKey = `${range.startOffset}:${range.endOffset}`;
          entry.blocks.set(blockKey, (entry.blocks.get(blockKey) || false) || range.count > 0);
        }
      }
    }
  }
  return new Map([...scripts].map(([file, entry]) => [file, {
    functionsTotal: entry.functions.size,
    functionsCovered: [...entry.functions.values()].filter(Boolean).length,
    blocksTotal: entry.blocks.size,
    blocksCovered: [...entry.blocks.values()].filter(Boolean).length,
  }]));
}

function percent(covered, total) {
  return total ? covered * 100 / total : 100;
}
