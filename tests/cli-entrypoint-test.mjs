import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "bin", "machine-mcp.mjs");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const version = run(["version"]);
assert(version.status === 0, `version command failed: ${version.stderr}`);
assert(version.stdout.trim() === `${pkg.name} ${pkg.version}`, "version command returned stale package metadata");

const help = run(["help"]);
assert(help.status === 0, `help command failed: ${help.stderr}`);
assert(help.stdout.includes("Usage:") && help.stdout.includes("--log-format"), "help output omitted current CLI options");
console.log("CLI entrypoint test ok");

function run(args) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
