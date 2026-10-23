#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runStep(name, command, args) {
  process.stdout.write(`[release-check] Running ${name}...\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.stderr.write(`[release-check] FAILED: ${name} exited with status ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

const node = process.execPath;
runStep("version-sync", node, ["scripts/sync-worker-version.mjs", "--check"]);
runStep("privacy-check", node, ["scripts/privacy-check.mjs"]);
runStep("tool-schemas", node, ["scripts/generate-tool-output-schemas.mjs", "--check"]);
runStep("typecheck", "npm", ["run", "typecheck"]);
runStep("lint", "npm", ["run", "lint"]);
runStep("architecture-test", node, ["tests/architecture-test.mjs"]);
runStep("package-test", "npm", ["run", "package:test"]);
runStep("integration-test", "npm", ["run", "test:integration"]);

process.stdout.write("\n✨ [release-check] All release gates passed cleanly. Release candidate is verified for 3.0.0 GA.\n");
