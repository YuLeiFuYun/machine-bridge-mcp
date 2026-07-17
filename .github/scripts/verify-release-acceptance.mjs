#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function canonicalPackageDigest(projectRoot, packValue) {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const pack = normalizePackRecord(packValue, pkg.name);
  if (!pack || !Array.isArray(pack.files)) throw new Error("npm pack metadata omitted the file list");
  if (pack.name !== pkg.name || pack.version !== pkg.version) {
    throw new Error("npm pack identity does not match package.json");
  }

  const index = trackedIndex(projectRoot);
  const entries = pack.files.map((entry) => normalizeEntry(projectRoot, entry, index));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  for (let indexPosition = 1; indexPosition < entries.length; indexPosition += 1) {
    if (entries[indexPosition - 1].path === entries[indexPosition].path) {
      throw new Error(`npm pack metadata contains duplicate path: ${entries[indexPosition].path}`);
    }
  }

  const hash = createHash("sha256");
  addField(hash, "machine-bridge-mcp-package-content-v1");
  addField(hash, pkg.name);
  addField(hash, pkg.version);
  addField(hash, String(pack.filename || ""));
  for (const entry of entries) {
    addField(hash, entry.path);
    addField(hash, entry.gitMode);
    addField(hash, String(entry.bytes.length));
    addBytes(hash, entry.bytes);
  }
  return hash.digest("hex");
}

export function verifyPortableAcceptance(projectRoot, packValue) {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const pack = normalizePackRecord(packValue, pkg.name);
  if (!pack) throw new Error("npm pack did not return package metadata");
  const acceptance = JSON.parse(readFileSync(join(projectRoot, "release-acceptance", `v${pkg.version}.json`), "utf8"));
  const expectedDigest = canonicalPackageDigest(projectRoot, packValue);

  if (acceptance.schema_version !== 1
      || acceptance.result !== "passed"
      || acceptance.confirmation !== "repository-owner-local-test") {
    throw new Error("repository-owner local acceptance marker is invalid");
  }
  if (acceptance.package_name !== pkg.name
      || acceptance.package_version !== pkg.version
      || acceptance.filename !== pack.filename) {
    throw new Error("repository-owner local acceptance package identity does not match npm pack");
  }
  if (!/^[0-9a-f]{40}$/.test(String(acceptance.shasum || ""))
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(acceptance.integrity || ""))) {
    throw new Error("repository-owner local acceptance tarball hashes are malformed");
  }
  if (!Number.isFinite(Date.parse(String(acceptance.accepted_at || "")))) {
    throw new Error("repository-owner local acceptance timestamp is invalid");
  }
  if (acceptance.package_content_sha256 !== expectedDigest) {
    throw new Error(`repository-owner local acceptance content digest does not match the current npm package (expected ${expectedDigest})`);
  }
  return { acceptance, digest: expectedDigest, pack };
}

function normalizeEntry(projectRoot, entry, index) {
  const path = String(entry?.path || "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`npm pack metadata contains unsafe path: ${path || "<empty>"}`);
  }
  const gitMode = index.get(path);
  if (!gitMode) throw new Error(`npm package file is not tracked by Git: ${path}`);
  const sourcePath = join(projectRoot, ...path.split("/"));
  const stat = lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`npm package path is not a regular tracked file: ${path}`);
  }
  const bytes = readFileSync(sourcePath);
  if (Number(entry.size) !== bytes.length) {
    throw new Error(`npm pack size does not match source bytes: ${path}`);
  }
  return { path, gitMode, bytes };
}

function trackedIndex(projectRoot) {
  const result = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: projectRoot,
    encoding: "buffer",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${String(result.stderr || "").trim()}`);
  const entries = new Map();
  for (const raw of result.stdout.toString("utf8").split("\0")) {
    if (!raw) continue;
    const match = /^(100644|100755) [0-9a-f]+ 0\t(.+)$/.exec(raw);
    if (!match) continue;
    entries.set(match[2].replaceAll("\\", "/"), match[1]);
  }
  return entries;
}

function normalizePackRecord(value, packageName) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (!value || typeof value !== "object") return null;
  if (value[packageName] && typeof value[packageName] === "object") return value[packageName];
  return Object.values(value).find((item) => item && typeof item === "object") ?? null;
}

function addField(hash, value) {
  addBytes(hash, Buffer.from(String(value), "utf8"));
}

function addBytes(hash, bytes) {
  hash.update(Buffer.from(String(bytes.length), "ascii"));
  hash.update(":", "ascii");
  hash.update(bytes);
  hash.update("\0", "ascii");
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) throw new Error(`npm pack metadata exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (!total) throw new Error("npm pack metadata was not provided on stdin");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const value = await readStdin();
  if (process.argv.includes("--print-digest")) {
    process.stdout.write(`${canonicalPackageDigest(root, value)}\n`);
    return;
  }
  const result = verifyPortableAcceptance(root, value);
  process.stdout.write(`Portable owner acceptance matches ${result.pack.filename} (${result.digest}).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`portable release acceptance failed: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
