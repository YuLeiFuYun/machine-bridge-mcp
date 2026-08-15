#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["bin", "src/local", "src/shared", "scripts", "tests", "browser-extension", ".github/scripts"];
const files = roots.flatMap((entry) => collect(join(root, entry)))
  .filter((file) => [".js", ".mjs"].includes(extname(file)))
  .sort();
const parserMode = process.argv.includes("--vm-parse");

if (parserMode) {
  if (typeof vm.SourceTextModule !== "function") throw new Error("VM module parser is unavailable");
  for (const file of files) {
    try {
      let source = readFileSync(file, "utf8");
      if (source.startsWith("#!")) source = source.replace(/^#![^\n]*(?:\n|$)/, "\n");
      new vm.SourceTextModule(source, { identifier: relative(root, file) });
    } catch (error) {
      process.stderr.write(`syntax check failed: ${relative(root, file)}\n${String(error?.stack || error)}\n`);
      process.exit(1);
    }
  }
  process.exit(0);
}

const parser = spawnSync(process.execPath, [
  "--experimental-vm-modules",
  "--no-warnings",
  fileURLToPath(import.meta.url),
  "--vm-parse",
], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
if (parser.error) throw parser.error;
if (parser.status !== 0) {
  process.stderr.write(parser.stderr || parser.stdout || "syntax parser failed without output\n");
  process.exit(parser.status ?? 1);
}

if (process.platform !== "win32") {
  const shell = spawnSync("sh", ["-n", join(root, "mbm")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (shell.error) throw shell.error;
  if (shell.status !== 0) {
    process.stderr.write(`shell syntax check failed: mbm\n${shell.stderr || shell.stdout}`);
    process.exit(1);
  }
}

console.log(`syntax check ok (${files.length} JavaScript files in one parser process${process.platform === "win32" ? "" : "; mbm shell wrapper"})`);

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
