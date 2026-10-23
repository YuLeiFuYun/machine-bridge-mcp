import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Documentation size is a guardrail against unbounded manual prose sprawl. Auto-generated
// reference files (verified byte-for-byte by tool-docs:check and policy-docs:check) are
// excluded so schema or catalog additions do not trip manual prose budgets.
const GENERATED_DOCUMENTS = new Set([
  "docs/POLICY_REFERENCE.md",
  "docs/TOOL_REFERENCE.md",
]);
const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, "tests", "architecture", "documentation-budget.json"), "utf8"));
const files = [...walk(join(root, "docs")).filter((file) => file.endsWith(".md")), join(root, "README.md")]
  .filter((file) => !GENERATED_DOCUMENTS.has(relative(root, file).split("\\").join("/")))
  .sort();
const counts = new Map();
let totalWords = 0;
for (const file of files) {
  const words = readFileSync(file, "utf8").trim().split(/\s+/).filter(Boolean).length;
  const relativePath = relative(root, file).split("\\").join("/");
  counts.set(relativePath, words);
  totalWords += words;
}
if (totalWords > baseline.totalWords) {
  throw new Error(`documentation budget exceeded: ${totalWords} > ${baseline.totalWords}; compress or move prose before documenting new material`);
}
for (const [file, words] of counts) {
  const allowed = baseline.files[file];
  if (allowed !== undefined && words > allowed) {
    throw new Error(`documentation budget exceeded in ${file}: ${words} > ${allowed}`);
  }
}
console.log(`documentation budget ok (${totalWords} words across ${files.length} handwritten files; ${GENERATED_DOCUMENTS.size} generated references excluded)`);

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else if (entry.name.endsWith(".md")) result.push(file);
  }
  return result;
}
