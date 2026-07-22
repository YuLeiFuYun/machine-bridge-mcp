#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ACCEPTANCE_SCHEMA_VERSION, PROMOTION_DIGEST_POLICY_VERSION, acceptanceConfirmationForVersion } from "../../scripts/release-acceptance.mjs";
import { computePromotionContentDigest } from "../../scripts/promotion-digest.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "../../scripts/release-channel.mjs";

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
  const entries = pack.files.map((entry) => normalizeEntry(entry, index));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  for (let indexPosition = 1; indexPosition < entries.length; indexPosition += 1) {
    if (entries[indexPosition - 1].path === entries[indexPosition].path) {
      throw new Error(`npm pack metadata contains duplicate path: ${entries[indexPosition].path}`);
    }
  }

  const blobs = readGitBlobs(projectRoot, [...new Set(entries.map((entry) => entry.oid))]);
  const hash = createHash("sha256");
  addField(hash, "machine-bridge-mcp-package-content-v1");
  addField(hash, pkg.name);
  addField(hash, pkg.version);
  addField(hash, String(pack.filename || ""));
  for (const entry of entries) {
    addField(hash, entry.path);
    const bytes = blobs.get(entry.oid);
    if (!bytes) throw new Error(`Git blob is unavailable for npm package path: ${entry.path}`);
    addField(hash, entry.gitMode);
    addField(hash, entry.oid);
    addField(hash, String(bytes.length));
    addBytes(hash, bytes);
  }
  return hash.digest("hex");
}

export function verifyPortableAcceptance(projectRoot, packValue) {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const pack = normalizePackRecord(packValue, pkg.name);
  if (!pack) throw new Error("npm pack did not return package metadata");
  const acceptance = JSON.parse(readFileSync(join(projectRoot, "release-acceptance", `v${pkg.version}.json`), "utf8"));
  const expectedDigest = canonicalPackageDigest(projectRoot, packValue);

  if (acceptance.schema_version !== ACCEPTANCE_SCHEMA_VERSION
      || acceptance.result !== "passed"
      || acceptance.confirmation !== acceptanceConfirmationForVersion(pkg.version)) {
    throw new Error("interactive local candidate acceptance marker is invalid");
  }
  if (acceptance.package_name !== pkg.name
      || acceptance.package_version !== pkg.version
      || acceptance.filename !== pack.filename) {
    throw new Error("interactive local candidate acceptance package identity does not match npm pack");
  }
  if (!/^[0-9a-f]{40}$/.test(String(acceptance.shasum || ""))
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(acceptance.integrity || ""))) {
    throw new Error("interactive local candidate acceptance tarball hashes are malformed");
  }
  if (!Number.isFinite(Date.parse(String(acceptance.accepted_at || "")))) {
    throw new Error("interactive local candidate acceptance timestamp is invalid");
  }
  if (acceptance.package_content_sha256 !== expectedDigest) {
    throw new Error(`interactive local candidate acceptance content digest does not match the current npm package (expected ${expectedDigest})`);
  }
  if (compareReleaseVersions(parseReleaseVersion(pkg.version), parseReleaseVersion(PROMOTION_DIGEST_POLICY_VERSION)) >= 0) {
    const promotionDigest = computePromotionContentDigest(projectRoot, { packageJson: pkg, packRecord: pack });
    if (acceptance.promotion_content_sha256 !== promotionDigest) {
      throw new Error(`interactive local candidate promotion digest does not match the current npm package (expected ${promotionDigest})`);
    }
  }
  return { acceptance, digest: expectedDigest, pack };
}

function normalizeEntry(entry, index) {
  const path = String(entry?.path || "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`npm pack metadata contains unsafe path: ${path || "<empty>"}`);
  }
  const tracked = index.get(path);
  if (!tracked) throw new Error(`npm package file is not tracked by Git: ${path}`);
  return { path, gitMode: tracked.mode, oid: tracked.oid };
}

function trackedIndex(projectRoot) {
  const result = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: projectRoot,
    encoding: null,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${String(result.stderr || "").trim()}`);
  const entries = new Map();
  for (const raw of result.stdout.toString("utf8").split("\0")) {
    if (!raw) continue;
    const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(raw);
    if (!match) continue;
    entries.set(match[3].replaceAll("\\", "/"), { mode: match[1], oid: match[2] });
  }
  return entries;
}

function readGitBlobs(projectRoot, objectIds) {
  const input = objectIds.map((oid) => `${oid}\n`).join("");
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: projectRoot,
    input: Buffer.from(input, "ascii"),
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git cat-file failed: ${String(result.stderr || "").trim()}`);

  const values = new Map();
  let offset = 0;
  for (const requestedOid of objectIds) {
    const lineEnd = result.stdout.indexOf(0x0a, offset);
    if (lineEnd < 0) throw new Error("git cat-file returned a truncated object header");
    const header = result.stdout.subarray(offset, lineEnd).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== requestedOid) throw new Error(`git cat-file returned an invalid blob header for ${requestedOid}`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) {
      throw new Error(`Git blob size is invalid for ${requestedOid}`);
    }
    const contentStart = lineEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= result.stdout.length || result.stdout[contentEnd] !== 0x0a) {
      throw new Error(`git cat-file returned truncated content for ${requestedOid}`);
    }
    values.set(requestedOid, result.stdout.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== result.stdout.length) throw new Error("git cat-file returned unexpected trailing output");
  return values;
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
  process.stdout.write(`Portable interactive candidate acceptance matches ${result.pack.filename} (${result.digest}).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`portable release acceptance failed: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
