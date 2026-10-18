import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const config = JSON.parse(readFileSync(join(root, "tsconfig.local.json"), "utf8"));
const included = new Set(config.include);
const deferred = new Set([]);
const sourceFiles = new Set();
function walk(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const absolute = join(root, directory, entry.name);
    if (entry.isDirectory()) walk(relative(root, absolute));
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) sourceFiles.add(relative(root, absolute).split(sep).join("/"));
  }
}
walk("src/local");
walk("src/shared");
const hasTsCheck = (file) => readFileSync(join(root, file), "utf8")
  .split("\n").slice(0, 3).some((line) => line.trim() === "// @ts-check");

for (const file of included) {
  assert(sourceFiles.has(file), `typecheck config includes a missing or out-of-scope file: ${file}`);
  assert(hasTsCheck(file), `typecheck include is ineffective because ${file} lacks // @ts-check`);
}
for (const file of deferred) {
  assert(sourceFiles.has(file) && hasTsCheck(file), `stale typecheck deferral entry: ${file}`);
  assert(!included.has(file), `remove ${file} from the deferral list after adding it to strict type checking`);
}
for (const file of sourceFiles) {
  if (hasTsCheck(file)) assert(included.has(file) || deferred.has(file), `new @ts-check module bypasses strict checking and the explicit migration queue: ${file}`);
}
assert(included.size >= 63, "strict local typecheck coverage regressed below the current baseline");
console.log(`local typecheck coverage contract ok (${included.size} checked modules; ${deferred.size} explicitly deferred modules)`);
