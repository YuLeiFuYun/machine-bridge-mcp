import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { normalizePackRecord } from "./release-acceptance.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { releaseCommandFailure } from "./release-diagnostic.mjs";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const VERSION_PLACEHOLDER = "<machine-bridge-release-version>";

export function computePromotionContentDigest(root, options = {}) {
  const pkg = options.packageJson || JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = parseReleaseVersion(pkg.version).raw;
  const record = options.packRecord || packageDryRun(root, pkg.name, options.npmCli);
  if (!Array.isArray(record.files) || record.files.length < 1) throw new Error("npm pack dry-run omitted the package file inventory");
  const entries = record.files.map((item) => ({
    path: String(item?.path || ""),
    mode: normalizePackMode(item?.mode),
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (!entries.length || entries.some((entry) => entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").includes(".."))) {
    throw new Error("npm pack dry-run returned an invalid package path");
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path === entries[index].path) throw new Error(`npm pack dry-run returned duplicate path: ${entries[index].path}`);
  }
  const hash = createHash("sha256");
  let total = 0;
  for (const entry of entries) {
    const relative = entry.path;
    const bytes = readBoundedRegularFileSync(join(root, relative), MAX_FILE_BYTES, `promotion package file ${relative}`, { verifyPathIdentity: true });
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error(`promotion package content exceeds ${MAX_TOTAL_BYTES} bytes`);
    const normalized = normalizeReleaseMetadata(relative, bytes, version);
    hash.update(`${relative}\0${entry.mode}\0${normalized.length}\0`, "utf8");
    hash.update(normalized);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}


function normalizePackMode(value) {
  const numeric = Number(value);
  const mode = Number.isSafeInteger(numeric) ? numeric & 0o777 : NaN;
  if (![0o644, 0o755].includes(mode)) throw new Error(`npm pack dry-run returned an invalid file mode: ${String(value)}`);
  return mode.toString(8).padStart(4, "0");
}

function packageDryRun(root, packageName, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error("promotion digest must run through npm so npm_execpath is available");
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--workspaces=false",
    "--global=false",
    "--prefix", root,
    "--ignore-scripts",
    "--silent",
    "--dry-run",
    "--json",
  ], {
    cwd: root,
    encoding: "utf8",
    env: nestedNpmEnvironment(process.env),
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", ["pack"], result));
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("npm pack dry-run did not return valid JSON"); }
  const record = normalizePackRecord(parsed, packageName);
  if (!record) throw new Error("npm pack dry-run did not return package metadata");
  return record;
}

function normalizeReleaseMetadata(relative, bytes, version) {
  if (relative === "package.json") {
    const value = parseJson(bytes, relative);
    value.version = VERSION_PLACEHOLDER;
    return canonicalJson(value);
  }
  if (relative === "package-lock.json") {
    const value = parseJson(bytes, relative);
    value.version = VERSION_PLACEHOLDER;
    if (value.packages?.[""] && typeof value.packages[""] === "object") value.packages[""].version = VERSION_PLACEHOLDER;
    return canonicalJson(value);
  }
  if (relative === "browser-extension/manifest.json") {
    const value = parseJson(bytes, relative);
    value.version = "0.0.0";
    value.version_name = VERSION_PLACEHOLDER;
    return canonicalJson(value);
  }
  if (relative === "src/worker/index.ts") {
    const text = bytes.toString("utf8");
    const normalized = text.replace(/const SERVER_VERSION = "[^"]+";/, `const SERVER_VERSION = "${VERSION_PLACEHOLDER}";`);
    if (normalized === text && !text.includes(`const SERVER_VERSION = "${VERSION_PLACEHOLDER}";`)) {
      throw new Error("Worker source omitted the synchronized SERVER_VERSION constant");
    }
    return Buffer.from(normalized, "utf8");
  }
  if (relative === "CHANGELOG.md") {
    return Buffer.from(bytes.toString("utf8").split(version).join(VERSION_PLACEHOLDER), "utf8");
  }
  return bytes;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(sortValue(value))}\n`, "utf8");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
