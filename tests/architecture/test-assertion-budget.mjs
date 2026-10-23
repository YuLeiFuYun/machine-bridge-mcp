import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is a ratchet, not a semantic migration: lower the budget whenever a test
// replaces a substring assertion with a structural assertion, and never raise it
// to accommodate new tests. New test files start with a zero allowance.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const testsRoot = join(root, "tests");
const baseline = JSON.parse(readFileSync(join(root, "tests", "architecture", "test-assertion-budget.json"), "utf8"));
const files = testFiles(testsRoot);
const counts = new Map();
let totalIncludes = 0;
let nodeTestFiles = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const relativePath = relative(root, file).split("\\").join("/");
  if (relativePath !== "tests/architecture/test-assertion-budget.mjs"
      && /\.indexOf\s*\([^)]*\)\s*(?:!==\s*-1|===\s*-1|>=\s*0|<\s*0)/.test(source)) {
    throw new Error(`test substring-assertion budget bypass (.indexOf existence check) in ${relativePath}; use a structural assertion within budget`);
  }
  const count = (source.match(/\.includes\s*\(/g) || []).length;
  if (count) counts.set(relativePath, count);
  totalIncludes += count;
  if (/from\s+["']node:test["']/.test(source)) nodeTestFiles += 1;
}
if (totalIncludes > baseline.totalIncludes) {
  throw new Error(`test substring-assertion budget exceeded: ${totalIncludes} > ${baseline.totalIncludes}; use a structural assertion instead`);
}
for (const [file, count] of counts) {
  const allowed = baseline.files[file] || 0;
  if (count > allowed) {
    throw new Error(`test substring-assertion budget exceeded in ${file}: ${count} > ${allowed}`);
  }
}
if (nodeTestFiles < baseline.nodeTestFiles) {
  throw new Error(`node:test adoption regressed: ${nodeTestFiles} < ${baseline.nodeTestFiles}`);
}
console.log(`test assertion budget ok (${totalIncludes} substring calls; ${nodeTestFiles} node:test file)`);

function testFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...testFiles(file));
    else if (/\.(?:mjs|js)$/.test(entry.name)) result.push(file);
  }
  return result;
}
