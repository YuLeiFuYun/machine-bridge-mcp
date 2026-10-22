import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Documentation size is a ratchet, not a target. Splitting a document is allowed because new
// files have no per-file ceiling; adding prose is not, because the total may only fall. Lower
// the total whenever a document gets shorter, and do not raise it to admit new prose.
const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, "tests", "architecture", "documentation-budget.json"), "utf8"));
const files = [...walk(join(root, "docs")).filter((file) => file.endsWith(".md")), join(root, "README.md")].sort();
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
console.log(`documentation budget ok (${totalWords} words across ${files.length} files)`);

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else if (entry.name.endsWith(".md")) result.push(file);
  }
  return result;
}
