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
  "tests/worker-runtime-infrastructure-test.mjs",
  "tests/logging-structure-test.mjs",
  "tests/runtime-handler-matrix-test.mjs",
  "tests/cli-entrypoint-test.mjs",
  "tests/local-self-test.mjs",
  "tests/numbers-test.mjs",
  "tests/records-test.mjs",
  "tests/project-metadata-test.mjs",
  "tests/state-inventory-test.mjs",
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
    "src/local/policy.mjs": [75, 45],
    "src/local/errors.mjs": [70, 50],
    "src/local/call-registry.mjs": [80, 50],
    "src/local/tool-executor.mjs": [90, 25],
    "src/local/observability.mjs": [65, 35],
    "src/local/process-tracker.mjs": [65, 35],
    "src/local/log.mjs": [60, 40],
    "src/local/runtime.mjs": [60, 35],
    "src/local/cli.mjs": [40, 10],
    "src/local/cli-options.mjs": [65, 35],
    "src/local/cli-policy.mjs": [70, 35],
    "src/local/numbers.mjs": [100, 100],
    "src/local/records.mjs": [100, 100],
    "src/local/project-metadata.mjs": [85, 55],
    "src/local/state-inventory.mjs": [80, 50],
    "src/worker/pending-calls.ts": [85, null],
    "src/worker/policy.ts": [90, null],
    "src/worker/errors.ts": [100, null],
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
  rmSync(coverageDir, { recursive: true, force: true });
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
