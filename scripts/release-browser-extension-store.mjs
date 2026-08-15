// @ts-check
import {
  closeSync, constants as fsConstants, fsyncSync, lstatSync, readSync,
  readdirSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { replaceFileSync } from "../src/local/atomic-fs.mjs";
import { releaseBrowserExtensionPath } from "../src/local/browser-extension-path.mjs";
import { ensureOwnerOnlyDirectorySync, inspectPathIfPresentSync, openRegularFileSync } from "../src/local/secure-file.mjs";

const MANIFEST = "manifest.json";
const MAX_EXTENSION_FILES = 256;
const MAX_EXTENSION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXTENSION_TOTAL_BYTES = 32 * 1024 * 1024;

export function publishReleaseBrowserExtension({ stateRoot, sourceDirectory, expectedVersion = "", beforeManifestCommit = null } = {}) {
  const source = resolve(String(sourceDirectory || ""));
  const destination = releaseBrowserExtensionPath(stateRoot);
  const snapshot = snapshotExtensionTree(source);
  if (!snapshot.files.some((entry) => entry.relative === MANIFEST)) throw new Error("release browser extension is missing manifest.json");
  const manifest = parseManifest(snapshot.files.find((entry) => entry.relative === MANIFEST)?.bytes);
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`release browser extension version ${manifest.version} does not match ${expectedVersion}`);
  }

  ensureOwnerOnlyDirectorySync(dirname(destination));
  ensureOwnerOnlyDirectorySync(destination);
  validateDestinationTree(destination);
  for (const directory of snapshot.directories) ensureOwnerOnlyDirectorySync(join(destination, directory));
  for (const entry of snapshot.files.filter((item) => item.relative !== MANIFEST)) {
    replaceStableFile(destination, entry.relative, entry.bytes);
  }
  removeStaleEntries(destination, snapshot);
  if (typeof beforeManifestCommit === "function") beforeManifestCommit({ destination, version: manifest.version });
  const manifestEntry = snapshot.files.find((entry) => entry.relative === MANIFEST);
  replaceStableFile(destination, MANIFEST, manifestEntry.bytes);
  verifyPublishedTree(destination, snapshot);
  return { path: destination, version: manifest.version, file_count: snapshot.files.length };
}

function snapshotExtensionTree(source) {
  const rootInfo = inspectPathIfPresentSync(source, "release browser extension source");
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("release browser extension source must be a real directory");
  }
  const files = [];
  const directories = [];
  let totalBytes = 0;
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      const info = lstatSync(absolutePath);
      if (info.isSymbolicLink()) throw new Error("release browser extension source must not contain symbolic links");
      if (info.isDirectory()) {
        directories.push(relativePath);
        walk(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) throw new Error("release browser extension source contains an unsupported entry type");
      if (files.length >= MAX_EXTENSION_FILES) throw new Error("release browser extension contains too many files");
      const bytes = readRegularFile(absolutePath, MAX_EXTENSION_FILE_BYTES, "release browser extension source file");
      totalBytes += bytes.length;
      if (totalBytes > MAX_EXTENSION_TOTAL_BYTES) throw new Error("release browser extension exceeds the total byte budget");
      files.push({ relative: relativePath, bytes });
    }
  };
  walk(source);
  return { files, directories };
}

function replaceStableFile(destination, relativePath, bytes) {
  const target = join(destination, relativePath);
  const targetInfo = inspectPathIfPresentSync(target, "stable browser extension target");
  if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    throw new Error("stable browser extension target must be a regular file");
  }
  ensureOwnerOnlyDirectorySync(dirname(target));
  const temporary = join(dirname(target), `.mbm-extension-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    const opened = openRegularFileSync(
      temporary,
      Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_EXCL),
      { label: "stable browser extension staging file", mode: 0o600, chmod: 0o600, rejectMultipleLinks: true },
    );
    fd = opened.fd;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try { replaceFileSync(temporary, target); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function removeStaleEntries(destination, snapshot) {
  const expectedFiles = new Set(snapshot.files.map((entry) => entry.relative));
  const expectedDirectories = new Set(snapshot.directories);
  const staleDirectories = [];
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      const info = lstatSync(absolutePath);
      if (info.isSymbolicLink()) throw new Error("stable browser extension must not contain symbolic links");
      if (info.isDirectory()) {
        walk(absolutePath, relativePath);
        if (!expectedDirectories.has(relativePath)) staleDirectories.push(absolutePath);
        continue;
      }
      if (!info.isFile()) throw new Error("stable browser extension contains an unsupported entry type");
      if (!expectedFiles.has(relativePath)) unlinkSync(absolutePath);
    }
  };
  walk(destination);
  staleDirectories.sort((left, right) => right.length - left.length);
  for (const directory of staleDirectories) rmdirSync(directory);
}

function validateDestinationTree(destination) {
  const root = resolve(destination);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const info = lstatSync(absolutePath);
      if (info.isSymbolicLink()) throw new Error("stable browser extension must not contain symbolic links");
      if (info.isDirectory()) { walk(absolutePath); continue; }
      if (!info.isFile()) throw new Error("stable browser extension contains an unsupported entry type");
      const rel = relative(root, absolutePath);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("stable browser extension entry escaped its root");
    }
  };
  walk(root);
}

function verifyPublishedTree(destination, snapshot) {
  const actual = snapshotExtensionTree(destination);
  const expectedFiles = new Map(snapshot.files.map((entry) => [entry.relative, entry.bytes]));
  if (actual.files.length !== expectedFiles.size) throw new Error("stable browser extension file inventory does not match the candidate");
  for (const entry of actual.files) {
    const expected = expectedFiles.get(entry.relative);
    if (!expected || !entry.bytes.equals(expected)) throw new Error("stable browser extension bytes do not match the candidate");
  }
}

function readRegularFile(file, maximum, label) {
  const opened = openRegularFileSync(file, fsConstants.O_RDONLY, { label, verifyPathIdentity: true });
  try {
    if (opened.info.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
    const bytes = Buffer.alloc(opened.info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(opened.fd);
  }
}

function parseManifest(bytes) {
  let value;
  try { value = JSON.parse(String(bytes || "")); } catch { throw new Error("release browser extension manifest is invalid JSON"); }
  const version = typeof value?.version_name === "string" && value.version_name ? value.version_name : value?.version;
  if (typeof version !== "string" || !version) throw new Error("release browser extension manifest has no version");
  return { version };
}
