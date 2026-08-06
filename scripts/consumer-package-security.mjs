import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareHardenedNpm } from "../src/local/hardened-npm.mjs";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONSUMER_TARBALL_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_CONTROL_PACKAGES = new Set(["wrangler", "miniflare"]);

export async function verifyCurrentConsumerPackage(options = {}) {
  const projectRoot = resolve(options.root || root);
  const temp = mkdtempSync(join(tmpdir(), "mbm-consumer-security-"));
  let result = null;
  let primaryError = null;
  try {
    const npmCli = await securityNpmCli(temp, options);
    const packed = runNpm(npmCli, ["pack", "--dry-run=false", "--workspaces=false", "--global=false", "--prefix", projectRoot, "--silent", "--json", "--pack-destination", temp], projectRoot, options.env);
    const record = normalizePackRecord(parseJson(packed.stdout, "npm pack output"));
    if (!record?.filename || !record?.version) throw new Error("npm pack did not return package identity");
    result = await verifyConsumerTarball(join(temp, record.filename), {
      ...options,
      npmCli,
      packageName: String(record.name || "machine-bridge-mcp"),
      packageVersion: String(record.version),
      tempRoot: temp,
    });
  } catch (error) {
    primaryError = error;
  }
  const cleanupError = removeTemporaryTree(temp);
  throwIfCleanupFailed(primaryError, cleanupError, "consumer package verification failed and temporary cleanup was incomplete");
  return result;
}

export async function verifyConsumerTarball(tarball, options = {}) {
  const packageName = String(options.packageName || "machine-bridge-mcp");
  const packageVersion = String(options.packageVersion || "");
  if (!packageVersion) throw new Error("consumer package version is missing");
  const canonicalTarball = canonicalConsumerTarballPath(tarball);
  const ownTemp = !options.tempRoot;
  const temp = options.tempRoot || mkdtempSync(join(tmpdir(), "mbm-consumer-tarball-"));
  const consumer = join(temp, "consumer-install");
  let result = null;
  try {
    const npmCli = await securityNpmCli(temp, options);
    mkdirSync(consumer, { recursive: true });
    const consumerRoot = realpathSync(consumer);
    const fixtureTarball = join(consumerRoot, "accepted-package.tgz");
    const tarballBytes = readBoundedRegularFileSync(
      canonicalTarball, MAX_CONSUMER_TARBALL_BYTES, "consumer tarball",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    );
    writeFileSync(fixtureTarball, tarballBytes, { mode: 0o600 });
    writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({
      name: "machine-bridge-mcp-consumer-fixture",
      version: "1.0.0",
      private: true,
    }, null, 2)}\n`);
    runNpm(npmCli, [
      "install",
      "--dry-run=false",
      "--workspaces=false",
      "--global=false",
      "--prefix", consumerRoot,
      "--ignore-scripts",
      "--include=optional",
      "--package-lock=true",
      "--package-lock-only=false",
      "--save=true",
      "--save-exact",
      fixtureTarball,
    ], consumerRoot, options.env);

    const installedManifest = parseJson(readFileSync(join(consumerRoot, "node_modules", packageName, "package.json"), "utf8"), "installed package manifest");
    if (installedManifest.name !== packageName || installedManifest.version !== packageVersion) {
      throw new Error("consumer installation package identity does not match the packed tarball");
    }
    if (Object.hasOwn(installedManifest.dependencies || {}, "wrangler")) {
      throw new Error("published package still exposes Wrangler as a consumer production dependency");
    }

    const audit = runNpm(npmCli, ["audit", "--workspaces=false", "--global=false", "--prefix", consumerRoot, "--omit=dev", "--audit-level=low", "--json"], consumerRoot, options.env, true);
    const auditSummary = validateConsumerAudit(parseJson(audit.stdout, "consumer npm audit output"), audit.status);
    runNpm(npmCli, ["audit", "signatures", "--workspaces=false", "--global=false", "--prefix", consumerRoot], consumerRoot, options.env);
    const tree = parseJson(runNpm(npmCli, ["ls", "--workspaces=false", "--global=false", "--prefix", consumerRoot, "--all", "--json"], consumerRoot, options.env).stdout, "consumer npm dependency tree");
    const treeSummary = validateConsumerTree(tree, { packageName, packageVersion });
    const sbom = parseJson(runNpm(npmCli, ["sbom", "--workspaces=false", "--global=false", "--prefix", consumerRoot, "--sbom-format", "cyclonedx"], consumerRoot, options.env).stdout, "consumer CycloneDX SBOM");
    const sbomSummary = validateConsumerSbom(sbom, { packageName, packageVersion });
    result = Object.freeze({
      package: `${packageName}@${packageVersion}`,
      audit: auditSummary,
      dependencies: treeSummary.dependencies,
      sbom_components: sbomSummary.components,
    });
  } catch (error) {
    if (!ownTemp) throw error;
    const cleanupError = removeTemporaryTree(temp);
    throwIfCleanupFailed(error, cleanupError, "consumer tarball verification failed and temporary cleanup was incomplete");
  }
  if (ownTemp) {
    const cleanupError = removeTemporaryTree(temp);
    if (cleanupError) throw cleanupError;
  }
  return result;
}

export function canonicalConsumerTarballPath(value) {
  const candidate = resolve(String(value || ""));
  let info;
  try { info = lstatSync(candidate); }
  catch (error) { throw new Error(`consumer tarball is unavailable: ${error.message}`); }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("consumer tarball must be a non-symlink regular file");
  }
  const canonical = realpathSync(candidate);
  const canonicalInfo = lstatSync(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) {
    throw new Error("consumer tarball canonical path must be a regular file");
  }
  return canonical;
}

export function validateConsumerAudit(report, exitCode = 0) {
  const vulnerabilities = report?.metadata?.vulnerabilities;
  const levels = ["info", "low", "moderate", "high", "critical"];
  if (!vulnerabilities || !levels.every((key) => Number.isFinite(Number(vulnerabilities[key])))) {
    throw new Error("consumer npm audit metadata is incomplete");
  }
  const total = levels.reduce((sum, key) => sum + Number(vulnerabilities[key]), 0);
  if (Number(vulnerabilities.total) !== total) throw new Error("consumer npm audit total is inconsistent");
  if (Number(exitCode) !== 0 || total !== 0) {
    throw new Error(`consumer production dependency audit failed (${levels.map((key) => `${key}=${vulnerabilities[key]}`).join(", ")})`);
  }
  return Object.freeze({ total: 0 });
}

export function validateConsumerTree(tree, options = {}) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new Error("consumer dependency tree must be an object");
  if (Array.isArray(tree.problems) && tree.problems.length) throw new Error("consumer dependency tree contains invalid dependency edges");
  const found = [];
  visitTree(tree.dependencies, found, 0);
  const expected = found.filter((item) => item.name === options.packageName && item.version === options.packageVersion);
  if (expected.length !== 1) throw new Error("consumer dependency tree does not contain exactly one packed package");
  for (const item of found) {
    if (FORBIDDEN_CONTROL_PACKAGES.has(item.name)) {
      throw new Error(`consumer dependency tree contains private control-plane package ${item.name}`);
    }
    if (item.name === "undici" && vulnerableUndici(item.version)) {
      throw new Error(`consumer dependency tree contains vulnerable undici ${item.version}`);
    }
    if (item.name === "sharp" && compareNumericVersion(item.version, "0.35.3") < 0) {
      throw new Error(`consumer dependency tree contains unsupported sharp ${item.version}`);
    }
  }
  return Object.freeze({ dependencies: found.length });
}

export function validateConsumerSbom(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)
      || document.bomFormat !== "CycloneDX" || document.specVersion !== "1.5") {
    throw new Error("consumer SBOM must be CycloneDX 1.5");
  }
  if (!Array.isArray(document.components) || document.components.length < 1 || document.components.length > 10_000) {
    throw new Error("consumer SBOM components must be a non-empty bounded array");
  }
  if (!Array.isArray(document.dependencies) || document.dependencies.length < 1 || document.dependencies.length > 20_000) {
    throw new Error("consumer SBOM dependencies must be a non-empty bounded array");
  }
  const matches = document.components.filter((item) => item?.name === options.packageName && item?.version === options.packageVersion);
  if (matches.length !== 1) throw new Error("consumer SBOM does not contain exactly one packed package component");
  const packageReference = String(matches[0]["bom-ref"] || "");
  const rootReference = String(document.metadata?.component?.["bom-ref"] || "");
  const references = new Set([rootReference, ...document.components.map((item) => String(item?.["bom-ref"] || ""))]);
  if (!packageReference || !rootReference || references.has("") || references.size !== document.components.length + 1) {
    throw new Error("consumer SBOM component references are missing or duplicated");
  }
  const dependencyByReference = new Map();
  for (const dependency of document.dependencies) {
    const reference = String(dependency?.ref || "");
    if (!references.has(reference) || dependencyByReference.has(reference) || !Array.isArray(dependency?.dependsOn)
        || dependency.dependsOn.some((item) => !references.has(String(item)))) {
      throw new Error("consumer SBOM dependency graph contains an invalid reference");
    }
    dependencyByReference.set(reference, dependency.dependsOn.map(String));
  }
  if (dependencyByReference.size !== references.size
      || [...references].some((reference) => !dependencyByReference.has(reference))) {
    throw new Error("consumer SBOM dependency graph omits a component reference");
  }
  if (!dependencyByReference.get(rootReference)?.includes(packageReference)) {
    throw new Error("consumer SBOM does not connect the fixture root to the packed package");
  }
  for (const component of document.components) {
    const name = String(component?.name || "");
    const version = String(component?.version || "");
    if (FORBIDDEN_CONTROL_PACKAGES.has(name)) throw new Error(`consumer SBOM contains private control-plane package ${name}`);
    if (name === "undici" && vulnerableUndici(version)) throw new Error(`consumer SBOM contains vulnerable undici ${version}`);
  }
  return Object.freeze({ components: document.components.length });
}

function visitTree(dependencies, found, depth) {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return;
  if (depth > 64 || found.length > 20_000) throw new Error("consumer dependency tree exceeds its traversal limit");
  for (const [name, value] of Object.entries(dependencies)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    found.push({ name, version: String(value.version || "") });
    if (found.length > 20_000) throw new Error("consumer dependency tree exceeds its traversal limit");
    visitTree(value.dependencies, found, depth + 1);
  }
}

function vulnerableUndici(version) {
  const major = Number(String(version).split(".")[0]);
  if (major < 6) return true;
  if (major === 6) return compareNumericVersion(version, "6.28.0") < 0;
  if (major === 7) return compareNumericVersion(version, "7.29.0") < 0;
  if (major === 8) return compareNumericVersion(version, "8.9.0") < 0;
  return false;
}

function compareNumericVersion(left, right) {
  const a = String(left).split(".").slice(0, 3).map(Number);
  const b = String(right).split(".").slice(0, 3).map(Number);
  if (a.some((value) => !Number.isInteger(value) || value < 0)) return -1;
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function runNpm(npmCli, args, cwd, environment, allowFailure = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: nestedNpmEnvironment(environment || process.env),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`npm ${args[0]} failed: ${bounded(result.stderr || result.stdout)}`);
  return result;
}

async function securityNpmCli(temp, options) {
  const explicit = String(options.npmCli || "").trim();
  if (explicit) return explicit;
  return (await prepareHardenedNpm(join(temp, "hardened-npm"), options.hardenedNpm || {})).cli;
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); } catch { throw new Error(`${label} is not valid JSON`); }
}

function normalizePackRecord(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (!value || typeof value !== "object") return null;
  return Object.values(value).find((item) => item && typeof item === "object") || null;
}

function bounded(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").slice(0, 1200);
}

function removeTemporaryTree(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return null;
  } catch (error) {
    return error;
  }
}

function throwIfCleanupFailed(primaryError, cleanupError, message) {
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], message);
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function main() {
  const summary = await verifyCurrentConsumerPackage();
  process.stdout.write(`consumer package security verified (${summary.package}; ${summary.dependencies} dependencies; ${summary.sbom_components} SBOM components)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
