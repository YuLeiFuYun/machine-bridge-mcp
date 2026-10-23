#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkMode = process.argv.includes("--check");

function runStep(name, command, args) {
  process.stdout.write(`[codegen] ${checkMode ? "Checking" : "Generating"} ${name}...\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.stderr.write(`[codegen] FAILED: ${name} exited with status ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

const node = process.execPath;
const checkArg = checkMode ? ["--check"] : [];

// 1. Tool Output Schemas & Server Metadata (SSOT)
runStep("tool-output-schemas", node, ["scripts/generate-tool-output-schemas.mjs", ...checkArg]);

// 2. Tool Reference Documentation
runStep("tool-reference-docs", node, ["scripts/generate-tool-reference.mjs", ...checkArg]);

// 3. Policy Reference Documentation
runStep("policy-reference-docs", node, ["scripts/generate-policy-reference.mjs", ...checkArg]);

// 4. Worker Types Generation (only in generate mode)
if (!checkMode) {
  runStep("worker-types", node, ["scripts/generate-worker-types.mjs"]);
}

process.stdout.write(`\n✨ [codegen] All schemas, manifests, and documentation are ${checkMode ? "verified in sync" : "regenerated cleanly"}.\n`);
