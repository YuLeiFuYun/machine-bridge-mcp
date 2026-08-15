import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceRoots = ["src/local", "src/worker", "src/shared"].map((path) => resolve(root, path));
const sourceExtensions = new Set([".js", ".mjs", ".mts", ".ts"]);
const sourceFiles = sourceRoots.flatMap((sourceRoot) => sourceFilesBelow(sourceRoot));
const sourceSet = new Set(sourceFiles);
const dependencies = new Map(sourceFiles.map((file) => [file, relativeDependencies(file)]));
const visiting = new Set();
const visited = new Set();

for (const file of sourceFiles) visit(file, []);
console.log(`architecture source module graph ok (${sourceFiles.length} modules)`);

function sourceFilesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function relativeDependencies(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = new Set();
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) if (match[1].startsWith(".")) specifiers.add(match[1]);
  }
  return [...specifiers].flatMap((specifier) => {
    const target = resolve(dirname(file), specifier);
    for (const candidate of sourceCandidates(target)) if (sourceSet.has(candidate)) return [candidate];
    return [];
  });
}

function sourceCandidates(target) {
  if (sourceExtensions.has(extname(target))) return [target];
  return [target, ...[".js", ".mjs", ".mts", ".ts"].map((extension) => `${target}${extension}`)];
}

function visit(file, stack) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file].map((path) => relative(root, path)).join(" -> ");
    assert.fail(`source module dependency cycle detected: ${cycle}`);
  }
  visiting.add(file);
  for (const dependency of dependencies.get(file) || []) visit(dependency, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}
