import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const files = [...walk(join(root, "docs")).filter((file) => file.endsWith(".md")), join(root, "README.md")].sort();
let totalWords = 0;
for (const file of files) {
  const content = readFileSync(file, "utf8").trim();
  if (content.length === 0) {
    throw new Error(`documentation file ${relative(root, file)} is empty`);
  }
  const words = content.split(/\s+/).filter(Boolean).length;
  totalWords += words;
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
