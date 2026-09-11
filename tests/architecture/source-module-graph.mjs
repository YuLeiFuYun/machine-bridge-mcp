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
  const specifiers = new Set(moduleSpecifiers(text).filter((specifier) => specifier.startsWith(".")));
  return [...specifiers].flatMap((specifier) => {
    const target = resolve(dirname(file), specifier);
    for (const candidate of sourceCandidates(target)) if (sourceSet.has(candidate)) return [candidate];
    return [];
  });
}

export function moduleSpecifiers(text) {
  const tokens = sourceTokens(String(text || ""));
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier" || (token.value !== "import" && token.value !== "export")) continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.type === "string") {
      specifiers.push(next.value);
      continue;
    }
    if (token.value === "import" && next?.value === "(" && tokens[index + 2]?.type === "string") {
      specifiers.push(tokens[index + 2].value);
      continue;
    }
    for (let cursor = index + 1, remaining = 256; cursor + 1 < tokens.length && remaining > 0; cursor += 1, remaining -= 1) {
      const current = tokens[cursor];
      if (current.value === ";") break;
      if (current.type === "identifier" && (current.value === "import" || current.value === "export")) break;
      if (current.type === "identifier" && current.value === "from" && tokens[cursor + 1]?.type === "string") {
        specifiers.push(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return specifiers;
}

function sourceTokens(text) {
  const tokens = [];
  scanCode(0, false);
  return tokens;

  function scanCode(start, stopAtTemplateBrace) {
    let index = start;
    let nestedBraces = 0;
    while (index < text.length) {
      const char = text[index];
      if (/\s/u.test(char)) { index += 1; continue; }
      if (char === "/" && text[index + 1] === "/") {
        const end = text.indexOf("\n", index + 2);
        if (end < 0) return text.length;
        index = end + 1;
        continue;
      }
      if (char === "/" && text[index + 1] === "*") {
        const end = text.indexOf("*/", index + 2);
        index = end < 0 ? text.length : end + 2;
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = char;
        let cursor = index + 1;
        let value = "";
        while (cursor < text.length) {
          if (text[cursor] === "\\") {
            value += text.slice(cursor, Math.min(text.length, cursor + 2));
            cursor += 2;
            continue;
          }
          if (text[cursor] === quote) break;
          value += text[cursor++];
        }
        tokens.push({ type: "string", value });
        index = cursor < text.length ? cursor + 1 : text.length;
        continue;
      }
      if (char === "`") { index = scanTemplate(index + 1); continue; }
      if (stopAtTemplateBrace && char === "}") {
        if (nestedBraces === 0) return index + 1;
        nestedBraces -= 1;
      } else if (stopAtTemplateBrace && char === "{") nestedBraces += 1;
      if (/[A-Za-z_$]/.test(char)) {
        let cursor = index + 1;
        while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor])) cursor += 1;
        tokens.push({ type: "identifier", value: text.slice(index, cursor) });
        index = cursor;
        continue;
      }
      tokens.push({ type: "punctuation", value: char });
      index += 1;
    }
    return index;
  }

  function scanTemplate(start) {
    let index = start;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === "`") return index + 1;
      if (text[index] === "$" && text[index + 1] === "{") {
        index = scanCode(index + 2, true);
        continue;
      }
      index += 1;
    }
    return index;
  }
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
