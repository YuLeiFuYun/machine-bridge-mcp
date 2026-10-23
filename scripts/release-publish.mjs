#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runStep(name, command, args) {
  process.stdout.write(`[release-publish] ${name}...\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.stderr.write(`[release-publish] FAILED: ${name} exited with status ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

const node = process.execPath;
runStep("verifying release readiness", node, ["scripts/release-check.mjs"]);

const dryRun = process.argv.includes("--dry-run") || !process.env.CI;
const publishArgs = ["publish", "--access", "public"];
if (dryRun) {
  publishArgs.push("--dry-run");
  process.stdout.write("\n[release-publish] Dry-run mode active. No packages will be uploaded.\n");
}

runStep("npm publish", "npm", publishArgs);
process.stdout.write("\n🚀 [release-publish] Machine Bridge MCP 3.0.0 GA publication completed successfully.\n");
