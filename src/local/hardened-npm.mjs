import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { downloadHardenedNpmArtifact } from "./hardened-npm-download.mjs";
import { resolveHardenedNpmTarExecutable } from "./hardened-npm-extract.mjs";
import { ensureOwnerOnlyDirectorySync } from "./secure-file.mjs";
import { isPrivateToolchainIntegrityError } from "./private-toolchain-integrity.mjs";
import {
  hardenedNpmMarkerMatches,
  readHardenedNpmMarker,
  verifyHardenedNpmTree,
  verifyHardenedPackageIdentity,
  writeHardenedNpmMarker,
} from "./hardened-npm-verification.mjs";

export const HARDENED_NPM_ARTIFACTS = Object.freeze([
  Object.freeze({
    name: "npm",
    version: "12.0.1",
    url: "https://registry.npmjs.org/npm/-/npm-12.0.1.tgz",
    integrity: "sha512-L5T9i/YAQWQWqTS/xZxJkei/9zcu99hCeE4qi41IyBVV7mRQad3qc2JfuOktwmH+qwGI/V2rbCL+/UYxb1+RQA==",
    maximumBytes: 20 * 1024 * 1024,
  }),
  Object.freeze({
    name: "undici",
    version: "6.28.0",
    url: "https://registry.npmjs.org/undici/-/undici-6.28.0.tgz",
    integrity: "sha512-LIY910g9TI13YS95lrMFrs8Rm/u/irgHeTWoKCoteeJ04CUJ92eEfj0rVn+7VKMPBpUPiUoBKfhNyLI23EE/KA==",
    maximumBytes: 4 * 1024 * 1024,
  }),
  Object.freeze({
    name: "brace-expansion",
    version: "5.0.9",
    url: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
    integrity: "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
    maximumBytes: 1024 * 1024,
  }),
]);
export function hardenedNpmIdentity(artifacts = HARDENED_NPM_ARTIFACTS) {
  const normalized = normalizeArtifacts(artifacts);
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze({
    npmVersion: normalized[0].version,
    undiciVersion: normalized[1].version,
    braceExpansionVersion: normalized[2].version,
    digest,
    directoryName: `npm-${normalized[0].version}-hardened-${digest.slice(0, 16)}`,
  });
}
export async function ensureHardenedNpm(parent, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  const identity = hardenedNpmIdentity(artifacts);
  const root = path.join(path.resolve(parent), identity.directoryName);
  ensureOwnerOnlyDirectorySync(path.dirname(root));
  let integrityError = null;
  try {
    const verified = verifyHardenedNpm(root, { artifacts, run: options.run });
    const marker = readHardenedNpmMarker(root);
    if (hardenedNpmMarkerMatches(marker, identity)) return Object.freeze({ ...verified, root, identity });
  } catch (error) {
    if (!isPrivateToolchainIntegrityError(error)) throw error;
    integrityError = error;
    // Only positively identified private-copy corruption is reconstructed below.
  }
  if (existsSync(root)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (error) {
      if (integrityError) {
        throw new AggregateError([integrityError, error], "hardened npm is corrupt and private-copy removal was incomplete");
      }
      throw error;
    }
  }
  ensureOwnerOnlyDirectorySync(root);
  try {
    await prepareHardenedNpm(root, { ...options, artifacts });
    const verified = verifyHardenedNpm(root, { artifacts, run: options.run });
    writeHardenedNpmMarker(root, identity);
    return Object.freeze({ ...verified, root, identity });
  } catch (error) {
    let cleanupError = null;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (failure) { cleanupError = failure; }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "hardened npm preparation failed and private-copy cleanup was incomplete");
    }
    throw error;
  }
}
export async function prepareHardenedNpm(root, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  const target = path.resolve(root);
  ensureOwnerOnlyDirectorySync(target);
  const tarExecutable = resolveHardenedNpmTarExecutable(target, options);
  const archives = path.join(target, ".archives");
  ensureOwnerOnlyDirectorySync(archives);
  let primaryError = null;
  try {
    for (const artifact of artifacts) {
      const bytes = await readArtifact(artifact, options);
      verifyArtifact(bytes, artifact);
      const archive = path.join(archives, `${artifact.name}-${artifact.version}.tgz`);
      writeFileSync(archive, bytes, { mode: 0o600 });
      const extracted = path.join(archives, `extract-${artifact.name}`);
      ensureOwnerOnlyDirectorySync(extracted);
      run(options.run, tarExecutable, ["-xzf", archive, "-C", extracted]);
      const packageDirectory = path.join(extracted, "package");
      verifyHardenedPackageIdentity(packageDirectory, artifact.name, artifact.version);
      if (artifact.name === "npm") {
        const destination = path.join(target, "package");
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(packageDirectory, destination);
      } else {
        const destination = path.join(target, "package", "node_modules", artifact.name);
        if (!existsSync(path.dirname(destination))) throw new Error(`hardened npm is missing the ${artifact.name} dependency parent`);
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(packageDirectory, destination);
      }
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { rmSync(archives, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "hardened npm extraction failed and archive cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return verifyHardenedNpm(target, { artifacts, run: options.run });
}
export function verifyHardenedNpm(root, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  return verifyHardenedNpmTree(root, artifacts, (command, args, runOptions) => run(options.run, command, args, runOptions));
}

async function readArtifact(artifact, options) {
  if (typeof options.readArtifact === "function") {
    const value = await options.readArtifact(artifact);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  return downloadHardenedNpmArtifact(artifact, options);
}
function verifyArtifact(bytes, artifact) {
  if (bytes.length > artifact.maximumBytes) throw new Error(`${artifact.name} tarball exceeds its byte limit`);
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(artifact.integrity);
  if (!match) throw new Error(`${artifact.name} integrity is not valid SHA-512 SRI`);
  const actual = createHash("sha512").update(bytes).digest();
  const expected = Buffer.from(match[1], "base64");
  if (actual.length !== expected.length || !actual.equals(expected)) throw new Error(`${artifact.name} tarball failed SHA-512 verification`);
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("hardened npm requires exactly three pinned artifacts");
  const artifacts = value.map((item) => Object.freeze({
    name: String(item?.name || ""),
    version: String(item?.version || ""),
    url: String(item?.url || ""),
    integrity: String(item?.integrity || ""),
    maximumBytes: Number(item?.maximumBytes),
  }));
  if (artifacts.map((item) => item.name).join(",") !== "npm,undici,brace-expansion") {
    throw new Error("hardened npm artifact order or names are invalid");
  }
  for (const artifact of artifacts) {
    let target;
    try { target = new URL(artifact.url); } catch { throw new Error(`hardened npm artifact URL is invalid for ${artifact.name}`); }
    const expectedPath = `/${artifact.name}/-/${artifact.name}-${artifact.version}.tgz`;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version)
        || target.origin !== "https://registry.npmjs.org" || target.pathname !== expectedPath
        || target.username || target.password || target.search || target.hash
        || !Number.isSafeInteger(artifact.maximumBytes) || artifact.maximumBytes < 1) {
      throw new Error(`hardened npm artifact metadata is invalid for ${artifact.name}`);
    }
  }
  return artifacts;
}

function run(injected, command, args, options = {}) {
  if (typeof injected === "function") return injected(command, args, options);
  const result = spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${String(result.stderr || result.stdout || "").trim().slice(0, 1000)}`);
  return options.capture ? String(result.stdout || "") : "";
}
