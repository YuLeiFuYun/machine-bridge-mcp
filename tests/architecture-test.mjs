import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localRoot = join(root, "src", "local");
const modules = readdirSync(localRoot).filter((name) => name.endsWith(".mjs")).sort();
const graph = new Map();

for (const name of modules) {
  const file = join(localRoot, name);
  const source = readFileSync(file, "utf8");
  if (source.includes("LocalDaemon") || source.includes('"./daemon.mjs"') || source.includes("'./daemon.mjs'")) {
    throw new Error(`obsolete daemon/runtime naming returned in ${relative(root, file)}`);
  }
  const dependencies = [];
  for (const match of source.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/g)) {
    const target = resolve(dirname(file), match[1]);
    const modulePath = extname(target) ? target : `${target}.mjs`;
    if (!existsSync(modulePath)) throw new Error(`missing relative module ${match[1]} imported by ${relative(root, file)}`);
    if (dirname(modulePath) === localRoot && modulePath.endsWith(".mjs")) dependencies.push(modulePath);
  }
  graph.set(file, dependencies);
}

const visiting = new Set();
const visited = new Set();
for (const file of graph.keys()) visitModule(file, []);

const docs = [
  join(root, "README.md"),
  join(root, "SECURITY.md"),
  join(root, "CONTRIBUTING.md"),
  ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => join(root, "docs", name)),
];
for (const file of docs) validateRelativeLinks(file);

const repositoryFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
for (const name of repositoryFiles) {
  const file = join(root, name);
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if ((value < 32 && value !== 9 && value !== 10 && value !== 13) || value === 127) {
      throw new Error(`forbidden ASCII control byte 0x${value.toString(16).padStart(2, "0")} in ${name} at byte ${index}`);
    }
  }
}

const engineering = readFileSync(join(root, "docs", "ENGINEERING.md"), "utf8");
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`")) {
  throw new Error("engineering invariants omitted the owner-required full default or local-knowledge boundary");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".project-local/")) {
  throw new Error("machine-specific project notes are not ignored");
}

console.log(`architecture/documentation test ok (${modules.length} local modules; ${docs.length} documentation files)`);

function visitModule(file, stack) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const cycle = [...stack.slice(stack.indexOf(file)), file].map((item) => relative(localRoot, item)).join(" -> ");
    throw new Error(`local module dependency cycle detected: ${cycle}`);
  }
  visiting.add(file);
  for (const dependency of graph.get(file) || []) visitModule(dependency, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}

function validateRelativeLinks(file) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = raw.split("#", 1)[0];
    if (!path) continue;
    const target = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(target)) throw new Error(`broken relative documentation link in ${relative(root, file)}: ${raw}`);
  }
}
