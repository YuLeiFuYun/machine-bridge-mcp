import assert from "node:assert/strict";
import { parse } from "@babel/parser";
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

function sourceFilesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function relativeDependencies(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = new Set(moduleSpecifiers(text, file).filter((specifier) => specifier.startsWith(".")));
  return [...specifiers].flatMap((specifier) => {
    const target = resolve(dirname(file), specifier);
    for (const candidate of sourceCandidates(target)) if (sourceSet.has(candidate)) return [candidate];
    return [];
  });
}

export function moduleSpecifiers(text, file = "module.ts") {
  const nodes = [parse(String(text || ""), {
    sourceType: "module",
    sourceFilename: file,
    plugins: [["typescript", { dts: /\.d\.[cm]?ts$/u.test(file) }]],
    createImportExpressions: true,
    attachComment: false,
  })];
  const specifiers = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node.type !== "string") continue;
    let source;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) {
      source = node.source;
    } else if (node.type === "TSImportType") {
      source = node.source;
    } else if (node.type === "TSImportEqualsDeclaration" && node.moduleReference.type === "TSExternalModuleReference") {
      source = node.moduleReference.expression;
    }
    if (source?.type === "StringLiteral") specifiers.push({ start: node.start, value: source.value });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value);
      else if (value && typeof value === "object") nodes.push(value);
    }
  }
  return specifiers.sort((left, right) => left.start - right.start).map(({ value }) => value);
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

const parserFixture = moduleSpecifiers([
  "import {",
  "  alpha,",
  "  beta,",
  "} from \"./multiline-import.mjs\";",
  "export {",
  "  gamma,",
  "} from \"../shared/multiline-export.mjs\";",
  "import \"./side-effect.mjs\";",
  "const lazy = import(\"./dynamic.mjs\");",
  "const nested = `raw import(\"./template-text-only.mjs\") ${import(\"./template-expression.mjs\")}`;",
  "// import \"./comment-only.mjs\";",
  "const prose = \"export { value } from './string-only.mjs'\";",
].join("\n"));
assert.deepEqual(parserFixture, [
  "./multiline-import.mjs",
  "../shared/multiline-export.mjs",
  "./side-effect.mjs",
  "./dynamic.mjs",
  "./template-expression.mjs",
], "source module graph parser missed multiline edges or treated comments/string contents as imports");

assert.deepEqual(moduleSpecifiers(String.raw`import "\u002e/escaped-import.mjs";
export { value } from "\x2e/escaped-export.mjs";
const lazy = import("./dynamic-\u0065dge.mjs");
const misleading = /import("regex-only")/;
const call = receiver.import("./method-only.mjs");
const optional = receiver?.import("./optional-method-only.mjs");
const meta = import.meta.url;
import type { Type } from "./type-only.ts";
type Loaded = import("./type-query.ts").Type;
import legacy = require("./require-style.ts");
`), [
  "./escaped-import.mjs", "./escaped-export.mjs", "./dynamic-edge.mjs",
  "./type-only.ts", "./type-query.ts", "./require-style.ts",
], "source module graph must decode module strings and exclude regexes, methods and import.meta");

assert.deepEqual(moduleSpecifiers('import type { Type } from "./ambient.mjs"; export const value: Type;', "fixture.d.mts"),
  ["./ambient.mjs"], "source module graph rejected ambient declaration syntax");
assert.throws(() => moduleSpecifiers("export declare const tools: readonly Array<string>;", "fixture.d.mts"), SyntaxError,
  "source module graph accepted the public validator's invalid readonly-array declaration");

const longBindings = Array.from({ length: 300 }, (_, index) => "value" + index).join(", ");
assert.deepEqual(moduleSpecifiers("import { " + longBindings + " } from './long-import.mjs';"),
  ["./long-import.mjs"], "source module graph silently truncated a long import declaration");
assert.throws(() => moduleSpecifiers("import { unfinished"), SyntaxError,
  "source module graph accepted an incomplete module as dependency-free");

console.log("architecture source module graph ok (" + sourceFiles.length + " modules)");
