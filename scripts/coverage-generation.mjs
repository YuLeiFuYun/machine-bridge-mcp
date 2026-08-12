import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_ROOTS = ["src", "scripts", "tests", "browser-extension", ".github/scripts"];
const DEFAULT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.local.json", "wrangler.jsonc"];

export function captureCoverageGeneration(root, options = {}) {
  const entries = [];
  for (const name of options.roots || DEFAULT_ROOTS) collect(join(root, name), root, entries);
  for (const name of options.files || DEFAULT_FILES) collect(join(root, name), root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path); hash.update("\0"); hash.update(String(entry.mode)); hash.update("\0");
    hash.update(entry.content); hash.update("\0");
  }
  return hash.digest("hex");
}

function collect(path, root, entries) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const name = relative(root, path).split("\\").join("/");
  const mode = Number(info.mode) & 0o777;
  if (info.isSymbolicLink()) {
    entries.push({ path: name, mode, content: Buffer.from(`link:${readlinkSync(path)}`) });
    return;
  }
  if (info.isFile()) {
    entries.push({ path: name, mode, content: readFileSync(path) });
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) collect(join(path, entry.name), root, entries);
}
