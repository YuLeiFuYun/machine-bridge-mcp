#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["bin", "src/local", "scripts", "tests", "browser-extension"];
const files = roots.flatMap((entry) => collect(join(root, entry)))
  .filter((file) => [".js", ".mjs"].includes(extname(file)))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`syntax check failed: ${relative(root, file)}\n${result.stderr || result.stdout}`);
    process.exit(1);
  }
}

if (process.platform !== "win32") {
  const shell = spawnSync("sh", ["-n", join(root, "mbm")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (shell.error) throw shell.error;
  if (shell.status !== 0) {
    process.stderr.write(`shell syntax check failed: mbm\n${shell.stderr || shell.stdout}`);
    process.exit(1);
  }
}

console.log(`syntax check ok (${files.length} JavaScript files${process.platform === "win32" ? "" : "; mbm shell wrapper"})`);

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
