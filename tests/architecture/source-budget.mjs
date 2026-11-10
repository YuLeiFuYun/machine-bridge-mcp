import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source size is a ratchet, not a style rule. The project already budgets
// handwritten prose and substring assertions; without a matching budget the
// module count, the largest module, and the number of sub-1.5 KiB fragments can
// grow silently until the next review rediscovers the same sprawl.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const budget = JSON.parse(readFileSync(join(root, "tests", "architecture", "source-budget.json"), "utf8"));
const files = ["src", "browser-extension"].flatMap((directory) => walk(join(root, directory)));
const measurements = files.map((file) => ({ file, bytes: normalizedSourceSize(file) }));
const totalBytes = measurements.reduce((sum, entry) => sum + entry.bytes, 0);
const microFiles = measurements.filter((entry) => entry.bytes < 1536).length;
const largest = measurements.reduce((current, entry) => (entry.bytes > current.bytes ? entry : current), { file: "", bytes: 0 });

assert.ok(files.length <= budget.totalFiles,
  `source file budget exceeded: ${files.length} > ${budget.totalFiles}; consolidate modules before adding another file`);
assert.ok(totalBytes <= budget.totalBytes,
  `source byte budget exceeded: ${totalBytes} > ${budget.totalBytes}; move detail behind a boundary instead of growing the tree`);
assert.ok(largest.bytes <= budget.maxModuleBytes,
  `module size budget exceeded: ${relative(root, largest.file)} is ${largest.bytes} bytes > ${budget.maxModuleBytes}; split it by responsibility`);
assert.ok(microFiles <= budget.microFiles,
  `micro-module budget exceeded: ${microFiles} files under 1536 bytes > ${budget.microFiles}; inline single-purpose fragments into their owning module`);

for (const [directory, maximum] of Object.entries(budget.flatDirectories)) {
  const count = readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSource(entry.name)).length;
  assert.ok(count <= maximum,
    `flat directory budget exceeded: ${directory} has ${count} source files > ${maximum}; introduce a domain subdirectory instead of another prefix`);
}

console.log(`source budget ok (${files.length} files, ${totalBytes} bytes, largest ${largest.bytes} B, ${microFiles} micro-files)`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    return entry.isFile() && isSource(entry.name) ? [file] : [];
  });
}

function isSource(name) {
  return /\.(?:mjs|ts|js)$/.test(name) && !/\.d\.mts$/.test(name);
}

function normalizedSourceSize(file) {
  const buffer = readFileSync(file);
  let crCount = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0d) crCount += 1;
  }
  return buffer.length - crCount;
}
