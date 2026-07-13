import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts", "commit-message-check.mjs");

for (const title of [
  "feat: add browser download support",
  "fix(worker): reject expired state",
  "security(policy)!: remove implicit write authority",
  "docs: explain release recovery",
  "revert: restore prior relay behavior",
]) {
  const result = run(title);
  assert.equal(result.status, 0, `${title}\n${result.stderr}`);
}

for (const title of [
  "add browser download support",
  "feature: add browser download support",
  "fix(worker) reject expired state",
  "FIX: use uppercase type",
  "feat(): empty scope",
  `feat: ${"x".repeat(116)}`,
]) {
  const result = run(title);
  assert.notEqual(result.status, 0, title);
  assert.match(result.stderr, /invalid Conventional Commit title|exceeds 120 characters/);
}

console.log("commit message policy test ok");

function run(title) {
  return spawnSync(process.execPath, [script, "--title", title], {
    cwd: root,
    encoding: "utf8",
  });
}
