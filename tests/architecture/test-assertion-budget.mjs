import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const testsRoot = join(root, "tests");
const files = testFiles(testsRoot);
let totalIncludes = 0;
let nodeTestFiles = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const count = (source.match(/\.includes\s*\(/g) || []).length;
  totalIncludes += count;
  if (/from\s+["']node:test["']/.test(source)) nodeTestFiles += 1;
}

if (nodeTestFiles < 1) {
  throw new Error(`node:test adoption regressed: ${nodeTestFiles} < 1`);
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
